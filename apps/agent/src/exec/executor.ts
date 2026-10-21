/**
 * Manual-mode executor (PLAN 5.1-5.6, M3).
 *
 * take:   guards (pause, maxConcurrent, Claude token) -> `task.claim` -> server `task.offer`
 *         (kind CLAIM) -> `offer.accept` MANUAL -> clone token -> mirror + isolated clone ->
 *         branch -> dev env (devcontainer / Dockerfile / default image) + compose sidecars on a
 *         per-task network -> sandboxed container -> screen session running claude.
 * done:   commit leftovers -> push token -> push -> `task.pushed` + `task.finished` (the server
 *         opens the PR) -> remove containers, sidecars and network. The clone stays.
 * cleanup (server): delete the clone and the task image.
 *
 * All Docker, git, screen and filesystem access goes through injected interfaces.
 */
import { join } from 'node:path';
import type {
  AckPayload,
  AgentMessage,
  ParticipationConfigSchema,
  PayloadOf,
  ServerMessage,
  TaskOfferPayload,
} from '@orch/shared';
import type { z } from 'zod';
import { errorMessage, redact, type Logger } from '../log';
import type { OutboxType } from '../outbox';
import { modelFactor, parseLine, weigh } from '../usage';
import { findComposeFile, postCreateArgvs, selectDevEnv } from './devcontainer';
import type { DockerOps } from './docker';
import type { GitIdentity, GitOps } from './git';
import {
  COMPOSE_PROJECT_PREFIX,
  TASK_LABEL,
  assertSafeId,
  attachCommand,
  claudeModel,
  composeProject,
  containerName,
  imageTag,
  networkName,
  pickBranch,
  screenName,
  taskLabels,
} from './naming';
import { buildManualPrompt } from './prompt';
import { CLAUDE_TOKEN_ENV, TASK_CLAUDE_CONFIG_DIR, buildCreateArgs } from './sandbox';
import type { ScreenOps } from './screen';
import { ACTIVE_STATES, TaskStore, type TaskRecord } from './state';
import type { TokenPurpose } from './tokens';
import type { WorkspaceFs } from './workspace';

type Participation = z.infer<typeof ParticipationConfigSchema>;
type Task = TaskOfferPayload['task'];

export interface ExecutorConfig {
  /** Host path bind-mounted at the same path in the agent (PLAN 5.1). */
  workDir: string;
  dataDir: string;
  maxConcurrent: number;
  /** e.g. https://github.com */
  gitBaseUrl: string;
  defaultImage: string;
  /** Absolute path of the claude binary in the agent; copied to the same path in tasks. */
  claudeBin: string;
  uid: number;
  gid: number;
  identity: GitIdentity;
  opusFactor?: number;
  claimTimeoutMs?: number;
}

export interface ExecutorDeps {
  git: GitOps;
  docker: DockerOps;
  screen: ScreenOps;
  fs: WorkspaceFs;
  requestToken: (assignmentId: string, purpose: TokenPurpose) => Promise<string>;
  /** Persists and sends an acked message; returns its message id. */
  enqueue: <T extends OutboxType>(type: T, payload: PayloadOf<AgentMessage, T>) => string;
  isPaused: () => boolean;
  /** The member's Claude token (`/secrets/claude-token`), or null when `orch login` was not run. */
  readClaudeToken: () => string | null;
  participations: () => readonly Participation[];
  logger: Logger;
}

export interface TaskView {
  assignmentId: string;
  project: string;
  issueNumber: number;
  title: string;
  branch: string;
  state: TaskRecord['state'];
  prUrl: string | null;
  error: string | null;
  warnings: string[];
  attach: string;
}

export class ExecError extends Error {
  override name = 'ExecError';
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

interface ClaimWaiter {
  entryId: string;
  resolve: (v: TaskView) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

export class ManualExecutor {
  readonly store: TaskStore;
  private readonly claims = new Map<string, ClaimWaiter>();
  private readonly jobs = new Set<Promise<unknown>>();
  private readonly log: Logger;

  constructor(
    private readonly cfg: ExecutorConfig,
    private readonly deps: ExecutorDeps,
  ) {
    this.store = new TaskStore(join(cfg.dataDir, 'tasks.json'));
    this.log = deps.logger;
  }

  // ---------- queries ----------

  view(r: TaskRecord): TaskView {
    return {
      assignmentId: r.assignmentId,
      project: r.projectFullName,
      issueNumber: r.issueNumber,
      title: r.title,
      branch: r.branch,
      state: r.state,
      prUrl: r.prUrl,
      error: r.error,
      warnings: r.warnings,
      attach: attachCommand(r.issueNumber),
    };
  }

  views(): TaskView[] {
    return this.store.all().map((r) => this.view(r));
  }

  /** `hello.running` entries. */
  running(): { assignmentId: string; taskId: string; state: string; lastSeq: number }[] {
    return this.store.active().map((r) => ({
      assignmentId: r.assignmentId,
      taskId: r.taskId,
      state: r.state,
      lastSeq: r.seq,
    }));
  }

  get maxConcurrent(): number {
    return this.cfg.maxConcurrent;
  }

  /** Resolves when every background job (prepare, cleanup, ...) has settled. Used by tests. */
  async idle(): Promise<void> {
    while (this.jobs.size > 0) await Promise.allSettled([...this.jobs]);
  }

  // ---------- guards ----------

  private guard(extraSlots = 0): void {
    if (this.deps.isPaused()) {
      throw new ExecError('paused', 'This machine is paused. Run "orch resume" first.');
    }
    const used = this.store.active().length + extraSlots;
    if (used >= this.cfg.maxConcurrent) {
      throw new ExecError(
        'concurrency',
        `Already running ${used} task(s) (max ${this.cfg.maxConcurrent}). Finish one with "orch done <n>".`,
      );
    }
  }

  private resolveProject(project?: string): string {
    const parts = this.deps.participations();
    if (project) {
      const match = parts.find((p) => p.fullName.toLowerCase() === project.toLowerCase());
      return match?.fullName ?? project;
    }
    if (parts.length === 1 && parts[0]) return parts[0].fullName;
    const names = parts.map((p) => p.fullName).join(', ');
    throw new ExecError(
      'project_required',
      parts.length === 0
        ? 'No participating project known yet. Use "orch take <owner/repo>#<n>".'
        : `Several projects (${names}). Use "orch take <owner/repo>#<n>".`,
    );
  }

  // ---------- take ----------

  take(issueNumber: number, project?: string): Promise<TaskView> {
    this.guard(this.claims.size);
    if (!this.deps.readClaudeToken()) {
      throw new ExecError('no_claude_token', 'No Claude token. Run "orch login" first.');
    }
    const fullName = this.resolveProject(project);
    const existing = this.store.byIssue(issueNumber);
    if (existing && ACTIVE_STATES.includes(existing.state)) {
      throw new ExecError('already_running', `Issue #${issueNumber} is already ${existing.state}.`);
    }
    const key = claimKey(fullName, issueNumber);
    if (this.claims.has(key)) {
      throw new ExecError('already_claiming', `A claim for ${fullName}#${issueNumber} is pending.`);
    }
    const entryId = this.deps.enqueue('task.claim', { projectFullName: fullName, issueNumber });
    this.log.info('claim sent', { project: fullName, issue: issueNumber });
    return new Promise<TaskView>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.claims.delete(key);
        reject(
          new ExecError(
            'claim_pending',
            'The server has not answered the claim yet. It stays queued; check "orch status" later.',
          ),
        );
      }, this.cfg.claimTimeoutMs ?? 60_000);
      this.claims.set(key, { entryId, resolve, reject, timer });
    });
  }

  /** Called for every `ack` the agent receives. */
  onAck(replyTo: string, ack: AckPayload): void {
    for (const [key, w] of this.claims) {
      if (w.entryId !== replyTo) continue;
      if (!ack.ok && !ack.duplicate) {
        clearTimeout(w.timer);
        this.claims.delete(key);
        const code = ack.error?.code ?? 'claim_refused';
        w.reject(new ExecError(code, claimRefusalMessage(code, ack.error?.message)));
      }
      return;
    }
  }

  /** Handles task-related server messages. Returns true when handled. */
  handle(m: ServerMessage): boolean {
    switch (m.type) {
      case 'task.offer':
        this.onOffer(m.payload, m.replyTo);
        return true;
      case 'task.cancel':
        this.track(this.cancel(m.payload.assignmentId, m.payload.reason));
        return true;
      case 'pr.opened': {
        const rec = this.store.get(m.payload.assignmentId);
        if (rec) this.store.update(rec.assignmentId, { prUrl: m.payload.prUrl });
        this.log.info('pull request opened', { url: m.payload.prUrl });
        return true;
      }
      case 'cleanup':
        assertSafeId(m.payload.assignmentId);
        this.track(this.cleanup(m.payload.assignmentId));
        return true;
      default:
        return false;
    }
  }

  private onOffer(p: TaskOfferPayload, replyTo?: string): void {
    const { task } = p;
    let key = claimKey(task.project.fullName, task.issueNumber);
    for (const [k, w] of this.claims) if (replyTo !== undefined && w.entryId === replyTo) key = k;
    const waiter = this.claims.get(key);
    const settle = (fn: (w: ClaimWaiter) => void) => {
      if (!waiter) return;
      clearTimeout(waiter.timer);
      this.claims.delete(key);
      fn(waiter);
    };
    if (p.kind !== 'CLAIM') {
      this.deps.enqueue('offer.reject', {
        assignmentId: p.assignmentId,
        reason: 'error',
        detail: 'This agent runs manual mode only (auto mode comes in M4).',
      });
      return;
    }
    if (this.store.get(p.assignmentId)) return; // duplicate offer
    let refusal: 'paused' | 'concurrency' | 'error' | null = null;
    let detail = '';
    try {
      assertSafeId(p.assignmentId);
      this.guard();
      if (!this.deps.readClaudeToken())
        throw new ExecError('error', 'No Claude token on this machine');
    } catch (e) {
      refusal =
        e instanceof ExecError && (e.code === 'paused' || e.code === 'concurrency')
          ? e.code
          : 'error';
      detail = errorMessage(e);
    }
    if (refusal) {
      this.deps.enqueue('offer.reject', { assignmentId: p.assignmentId, reason: refusal, detail });
      settle((w) => w.reject(new ExecError(refusal, detail)));
      return;
    }
    const rec = this.newRecord(p);
    this.store.put(rec);
    this.deps.enqueue('offer.accept', { assignmentId: p.assignmentId, execMode: 'MANUAL' });
    settle((w) => w.resolve(this.view(rec)));
    this.track(this.prepare(rec.assignmentId, task));
  }

  private newRecord(p: TaskOfferPayload): TaskRecord {
    const { task } = p;
    const id = p.assignmentId;
    const taskDir = join(this.cfg.workDir, id);
    const now = new Date().toISOString();
    return {
      assignmentId: id,
      taskId: task.taskId,
      projectId: task.project.id,
      projectFullName: task.project.fullName,
      issueNumber: task.issueNumber,
      title: task.title,
      model: task.model,
      size: task.size,
      baseBranch: task.baseBranch || task.project.defaultBranch,
      branch: pickBranch(task.branchName, task.issueNumber, task.title),
      state: 'preparing',
      seq: 0,
      taskDir,
      cloneDir: join(taskDir, 'src'),
      container: containerName(task.issueNumber, id),
      network: networkName(id),
      image: null,
      builtImage: null,
      composeProject: null,
      screen: screenName(task.issueNumber),
      prUrl: null,
      error: null,
      warnings: [],
      cleanupRequested: false,
      createdAt: now,
      updatedAt: now,
    };
  }

  private nextSeq(id: string): number {
    const rec = this.store.get(id);
    if (!rec) throw new Error(`Unknown task ${id}`);
    return this.store.update(id, { seq: rec.seq + 1 }).seq;
  }

  private status(
    id: string,
    state: 'preparing' | 'building' | 'running' | 'pushing',
    detail?: string,
  ): void {
    this.store.update(id, { state });
    this.deps.enqueue('task.status', {
      assignmentId: id,
      seq: this.nextSeq(id),
      state,
      ...(detail ? { detail: detail.slice(0, 2000) } : {}),
    });
  }

  private cancelled(id: string): boolean {
    const r = this.store.get(id);
    return !r || r.state === 'cancelled' || r.cleanupRequested;
  }

  private async prepare(id: string, task: Task): Promise<void> {
    const rec = () => this.store.get(id) as TaskRecord;
    try {
      const claudeToken = this.deps.readClaudeToken();
      if (!claudeToken) throw new Error('No Claude token. Run "orch login".');
      const r0 = rec();
      this.status(id, 'preparing', 'cloning');
      this.deps.fs.mkdir(r0.taskDir);
      const remoteUrl = `${this.cfg.gitBaseUrl.replace(/\/+$/, '')}/${r0.projectFullName}.git`;
      const mirror = join(this.cfg.dataDir, 'mirrors', `${safeName(r0.projectId)}.git`);
      this.deps.fs.mkdir(join(this.cfg.dataDir, 'mirrors'));
      {
        const token = await this.deps.requestToken(id, 'clone');
        await this.deps.git.syncMirror(mirror, remoteUrl, token);
        await this.deps.git.clone(mirror, remoteUrl, r0.cloneDir, token);
      }
      await this.deps.git.createBranch(r0.cloneDir, r0.branch, r0.baseBranch);
      await this.deps.git.setIdentity(r0.cloneDir, this.cfg.identity);
      this.deps.fs.chownR(r0.taskDir, this.cfg.uid, this.cfg.gid);
      if (this.cancelled(id)) return;

      this.status(id, 'building');
      const env = selectDevEnv(r0.cloneDir, this.cfg.defaultImage);
      for (const w of env.warnings) this.log.warn(w, { issue: r0.issueNumber });
      this.store.update(id, { warnings: env.warnings });
      const labels = taskLabels(id, r0.issueNumber);
      await this.deps.docker.createNetwork(r0.network, labels);

      const compose = findComposeFile(r0.cloneDir);
      if (compose) {
        const override = join(r0.taskDir, 'compose.orch.yaml');
        this.deps.fs.writeFile(
          override,
          `# Written by orch: put the sidecars on the task network.\nnetworks:\n  default:\n    name: ${r0.network}\n    external: true\n`,
        );
        const project = composeProject(id);
        this.store.update(id, { composeProject: project });
        await this.deps.docker.composeUp(project, [compose, override], r0.cloneDir);
      }

      let image: string;
      if (env.kind === 'build') {
        image = imageTag(id);
        this.store.update(id, { builtImage: image });
        await this.deps.docker.build({
          tag: image,
          dockerfile: env.dockerfile,
          context: env.context,
          args: env.args,
          labels,
        });
      } else {
        image = env.image;
        await this.deps.docker.pull(image).catch((e: unknown) => {
          this.log.warn('image pull failed, trying a local copy', {
            image,
            error: errorMessage(e),
          });
        });
      }
      this.store.update(id, { image });
      if (this.cancelled(id)) return;

      const args = buildCreateArgs({
        name: r0.container,
        image,
        clonePath: r0.cloneDir,
        workspaceFolder: env.workspaceFolder,
        uid: this.cfg.uid,
        gid: this.cfg.gid,
        network: r0.network,
        size: r0.size,
        labels,
        containerEnv: env.containerEnv,
      });
      await this.deps.docker.create(args, { [CLAUDE_TOKEN_ENV]: claudeToken });
      await this.deps.docker.copyIn(r0.container, this.cfg.claudeBin);
      await this.deps.docker.start(r0.container);
      for (const argv of postCreateArgvs(env.postCreateCommand)) {
        const res = await this.deps.docker.exec(r0.container, argv);
        if (res.code !== 0) {
          const w = `postCreateCommand failed (exit ${res.code}): ${res.stderr.trim().slice(-300)}`;
          this.log.warn(w);
          this.store.update(id, { warnings: [...rec().warnings, redact(w)] });
        }
      }
      if (this.cancelled(id)) return;

      await this.deps.screen.start(
        r0.screen,
        this.claudeArgv(rec(), buildManualPrompt(task, r0.branch)),
      );
      this.status(id, 'running', `attach: ${attachCommand(r0.issueNumber)}`);
      this.log.info('task ready', { issue: r0.issueNumber, attach: attachCommand(r0.issueNumber) });
    } catch (err) {
      if (this.cancelled(id)) return;
      await this.fail(id, err);
    }
  }

  private claudeArgv(r: TaskRecord, prompt: string | null): string[] {
    const base = ['docker', 'exec', '-it', '-w', '/workspace', r.container];
    const model = claudeModel(r.model);
    if (prompt !== null) return [...base, this.cfg.claudeBin, '--model', model, prompt];
    // Session re-created after an agent restart: continue the last conversation if any.
    const bin = this.cfg.claudeBin;
    return [
      ...base,
      'sh',
      '-c',
      `"${bin}" --model ${model} --continue || exec "${bin}" --model ${model}`,
    ];
  }

  private async fail(id: string, err: unknown): Promise<void> {
    const message = redact(errorMessage(err)).slice(0, 3000);
    this.log.error('task failed', { assignmentId: id, error: message });
    const rec = this.store.update(id, { state: 'failed', error: message });
    await this.teardown(rec);
    this.deps.enqueue('task.finished', {
      assignmentId: id,
      seq: this.nextSeq(id),
      outcome: 'failed',
      usage: { weighted: 0, input: 0, output: 0 },
      error: message,
    });
  }

  // ---------- done ----------

  private findRunning(issueNumber: number): TaskRecord {
    const rec = this.store.byIssue(issueNumber);
    if (!rec)
      throw new ExecError('not_found', `No task for issue #${issueNumber} on this machine.`);
    if (rec.state !== 'running') {
      throw new ExecError('bad_state', `Issue #${issueNumber} is ${rec.state}, not running.`);
    }
    return rec;
  }

  async done(issueNumber: number): Promise<TaskView> {
    const rec = this.findRunning(issueNumber);
    const id = rec.assignmentId;
    this.status(id, 'pushing');
    try {
      const usage = await this.collectUsage(rec);
      const git = this.deps.git;
      await git.commitAll(
        rec.cloneDir,
        `orch: remaining changes for #${rec.issueNumber}`,
        this.cfg.identity,
      );
      this.deps.fs.chownR(rec.cloneDir, this.cfg.uid, this.cfg.gid);
      const ahead = await git.commitsAhead(rec.cloneDir, rec.baseBranch);
      if (ahead === 0) {
        this.deps.enqueue('task.finished', {
          assignmentId: id,
          seq: this.nextSeq(id),
          outcome: 'no_changes',
          usage,
        });
      } else {
        const token = await this.deps.requestToken(id, 'push');
        await git.push(rec.cloneDir, rec.branch, token);
        const [headSha, changedFiles, subjects] = await Promise.all([
          git.headSha(rec.cloneDir),
          git.changedFiles(rec.cloneDir, rec.baseBranch),
          git.subjects(rec.cloneDir, rec.baseBranch),
        ]);
        this.deps.enqueue('task.pushed', {
          assignmentId: id,
          seq: this.nextSeq(id),
          branch: rec.branch,
          headSha,
          changedFiles,
          summary: subjects
            .map((s) => `- ${s}`)
            .join('\n')
            .slice(0, 10_000),
        });
        this.deps.enqueue('task.finished', {
          assignmentId: id,
          seq: this.nextSeq(id),
          outcome: 'succeeded',
          usage,
        });
      }
    } catch (err) {
      const message = redact(errorMessage(err));
      this.status(id, 'running', `done failed: ${message}`);
      throw new ExecError('done_failed', `Push failed, the task is still running: ${message}`);
    }
    const after = this.store.update(id, { state: 'finished', error: null });
    await this.teardown(after);
    return this.view(after);
  }

  /** Sums the task's Claude usage from its config dir (an estimate, PLAN 5.7). */
  private async collectUsage(
    rec: TaskRecord,
  ): Promise<{ weighted: number; input: number; output: number }> {
    const usage = { weighted: 0, input: 0, output: 0 };
    try {
      const res = await this.deps.docker.exec(rec.container, [
        'sh',
        '-c',
        `cat ${TASK_CLAUDE_CONFIG_DIR}/projects/*/*.jsonl 2>/dev/null; true`,
      ]);
      const seen = new Set<string>();
      for (const line of res.stdout.split('\n')) {
        if (line.trim() === '') continue;
        let parsed;
        try {
          parsed = parseLine(line);
        } catch {
          continue;
        }
        if (!parsed) continue;
        if (parsed.key) {
          if (seen.has(parsed.key)) continue;
          seen.add(parsed.key);
        }
        const e = parsed.entry;
        usage.input += e.input;
        usage.output += e.output;
        usage.weighted += weigh(e, modelFactor(e.model, this.cfg.opusFactor ?? 5));
      }
    } catch (err) {
      this.log.warn('could not read task usage', { error: errorMessage(err) });
    }
    usage.weighted = Math.round(usage.weighted);
    return usage;
  }

  // ---------- attach / shell ----------

  async attach(issueNumber: number): Promise<string[]> {
    const rec = this.findRunning(issueNumber);
    if (!(await this.deps.screen.exists(rec.screen))) {
      await this.deps.screen.start(rec.screen, this.claudeArgv(rec, null));
    }
    return ['screen', '-r', rec.screen];
  }

  shell(issueNumber: number): string[] {
    const rec = this.findRunning(issueNumber);
    return [
      'docker',
      'exec',
      '-it',
      '-w',
      '/workspace',
      rec.container,
      'sh',
      '-c',
      'command -v bash >/dev/null && exec bash || exec sh',
    ];
  }

  // ---------- cancel / cleanup / teardown ----------

  private async cancel(id: string, reason: string): Promise<void> {
    const rec = this.store.get(id);
    if (!rec || !ACTIVE_STATES.includes(rec.state)) return;
    this.log.info('task cancelled by the server', { issue: rec.issueNumber, reason });
    const after = this.store.update(id, { state: 'cancelled', error: `cancelled: ${reason}` });
    await this.teardown(after);
    this.deps.enqueue('task.finished', {
      assignmentId: id,
      seq: this.nextSeq(id),
      outcome: 'cancelled',
      usage: { weighted: 0, input: 0, output: 0 },
    });
  }

  /** Stops the session, the task container, the sidecars and the network. Keeps the clone. */
  private async teardown(rec: TaskRecord): Promise<void> {
    const step = async (what: string, fn: () => Promise<void>) => {
      try {
        await fn();
      } catch (err) {
        this.log.warn(`teardown: ${what} failed`, { error: errorMessage(err) });
      }
    };
    await step('screen', () => this.deps.screen.kill(rec.screen));
    await step('container', () => this.deps.docker.remove(rec.container));
    if (rec.composeProject) {
      const project = rec.composeProject;
      await step('sidecars', () => this.deps.docker.composeDown(project));
    }
    await step('network', () => this.deps.docker.removeNetwork(rec.network));
  }

  /** Server `cleanup` (after merge or cancel): remove everything, including the clone. */
  async cleanup(id: string): Promise<void> {
    assertSafeId(id);
    const rec = this.store.get(id);
    if (rec) {
      this.store.update(id, { cleanupRequested: true });
      await this.teardown(rec);
      if (rec.builtImage) await this.deps.docker.removeImage(rec.builtImage).catch(() => undefined);
      await this.deps.fs.remove(rec.taskDir);
      this.store.delete(id);
    } else {
      for (const c of await this.labeled('container')) {
        if (c.value === id) await this.deps.docker.remove(c.name).catch(() => undefined);
      }
      await this.deps.fs.remove(join(this.cfg.workDir, id));
    }
    this.log.info('task cleaned up', { assignmentId: id });
  }

  private async labeled(kind: 'container' | 'network') {
    try {
      return await this.deps.docker.listLabeled(kind, TASK_LABEL);
    } catch (err) {
      this.log.warn(`could not list ${kind}s`, { error: errorMessage(err) });
      return [];
    }
  }

  /**
   * After a restart: finish pending cleanups, fail interrupted preparations, re-create screen
   * sessions of running tasks and remove orphaned containers, networks and sidecars.
   */
  async reconcile(): Promise<void> {
    for (const rec of [...this.store.all()]) {
      try {
        if (rec.cleanupRequested) await this.cleanup(rec.assignmentId);
        else if (rec.state === 'preparing' || rec.state === 'building') {
          await this.fail(rec.assignmentId, new Error('The agent restarted during preparation.'));
        } else if (rec.state === 'running' || rec.state === 'pushing') {
          if (await this.deps.docker.exists(rec.container)) {
            if (rec.state === 'pushing')
              this.status(rec.assignmentId, 'running', 'agent restarted');
            if (!(await this.deps.screen.exists(rec.screen))) {
              await this.deps.screen.start(rec.screen, this.claudeArgv(rec, null));
            }
          } else {
            await this.fail(rec.assignmentId, new Error('The task container disappeared.'));
          }
        }
      } catch (err) {
        this.log.warn('reconcile failed for a task', {
          assignmentId: rec.assignmentId,
          error: errorMessage(err),
        });
      }
    }
    const live = new Set(this.store.active().map((r) => r.assignmentId));
    for (const c of await this.labeled('container')) {
      if (!live.has(c.value)) {
        this.log.info('removing orphaned task container', { name: c.name });
        await this.deps.docker.remove(c.name).catch(() => undefined);
      }
    }
    for (const n of await this.labeled('network')) {
      if (!live.has(n.value)) await this.deps.docker.removeNetwork(n.name).catch(() => undefined);
    }
    const liveProjects = new Set(this.store.active().map((r) => r.composeProject));
    try {
      for (const p of await this.deps.docker.composeProjects(COMPOSE_PROJECT_PREFIX)) {
        if (!liveProjects.has(p)) await this.deps.docker.composeDown(p);
      }
    } catch (err) {
      this.log.warn('could not list compose projects', { error: errorMessage(err) });
    }
  }

  close(): void {
    for (const w of this.claims.values()) {
      clearTimeout(w.timer);
      w.reject(new ExecError('stopping', 'Agent stopping'));
    }
    this.claims.clear();
  }

  private track(p: Promise<unknown>): void {
    const job = p.catch((err: unknown) =>
      this.log.error('background task job failed', { error: errorMessage(err) }),
    );
    this.jobs.add(job);
    void job.finally(() => this.jobs.delete(job));
  }
}

const CLAIM_REFUSALS: Record<string, string> = {
  paused: 'You are paused on the server. Run "orch resume" first.',
  not_found: 'No such task on the server (is the issue imported into the pool?).',
  not_participating: 'You do not participate in this project. Join it on the Discover page.',
  model_not_allowed: 'Your participation does not allow the model this task needs.',
  max_concurrency: 'The server says this machine already runs its maximum number of tasks.',
  not_approved: 'Your participation is waiting for the project owner to approve it.',
  already_taken: 'Someone else already took this task.',
  dependencies_unmet: 'This task depends on tasks that are not finished yet.',
};

/** Human-readable text for a `task.claim` refusal code. */
export function claimRefusalMessage(code: string, fallback?: string): string {
  return CLAIM_REFUSALS[code] ?? fallback ?? `The server refused the claim (${code}).`;
}

const claimKey = (fullName: string, issue: number) => `${fullName.toLowerCase()}#${issue}`;
const safeName = (s: string) => s.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 100) || 'repo';
