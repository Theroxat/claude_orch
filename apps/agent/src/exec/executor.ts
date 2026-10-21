/**
 * Task executor (PLAN 5.1-5.6): manual mode (M3) and auto mode (M4).
 *
 * take:   guards (pause, maxConcurrent, Claude token) -> `task.claim` -> server `task.offer`
 *         (kind CLAIM) -> `offer.accept` MANUAL -> clone token -> mirror + isolated clone ->
 *         branch -> dev env (devcontainer / Dockerfile / default image) + compose sidecars on a
 *         per-task network -> sandboxed container -> screen session running claude.
 * done:   commit leftovers -> push token -> push -> `task.pushed` + `task.finished` (the server
 *         opens the PR) -> remove containers, sidecars and network. The clone stays.
 * auto:   `task.offer` AUTO_OFFER (or an accepted CONSENT_REQUEST) -> local consent guard (kind,
 *         pause, concurrency, participation, model, Claude token) -> `offer.accept` AUTO -> wait
 *         for the server's ack -> same clone / dev env / sandbox -> `claude -p` (stream-json, log
 *         in /data/logs/<id>.log, hard timeout) -> commit, push, `task.pushed` (draft PR) and
 *         `task.finished` -> remove containers. The clone stays.
 * requests: `offer.request` / `offer.withdrawn` keep the list behind `orch requests`;
 *         `orch accept|reject <id>` answer them.
 * cleanup (server): delete the clone, the task image and the run log.
 *
 * All Docker, git, screen and filesystem access goes through injected interfaces.
 */
import { createWriteStream, mkdirSync, rmSync } from 'node:fs';
import { join, relative } from 'node:path';
import type {
  AckPayload,
  AgentMessage,
  OfferRequestPayload,
  ParticipationConfigSchema,
  PayloadOf,
  ServerMessage,
  TaskOfferPayload,
} from '@orch/shared';
import type { z } from 'zod';
import { errorMessage, redact, type Logger } from '../log';
import type { OutboxType } from '../outbox';
import { modelFactor, parseLine, weigh } from '../usage';
import {
  DEFAULT_TIMEOUT_SEC,
  buildAutoArgv,
  isRateLimited,
  parseResultEvent,
  spawnProcessOps,
  type ClaudeResult,
  type ProcessOps,
  type RunningProcess,
} from './claude-run';
import {
  ComposeGuardError,
  checkComposeModel,
  planEnvFileFallbacks,
  sanitizeComposeModel,
  scanComposeSources,
} from './compose-guard';
import { findComposeFile, postCreateArgvs, selectDevEnv } from './devcontainer';
import type { DockerOps } from './docker';
import type { GitIdentity, GitOps, GitRepo } from './git';
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
import { buildAutoPrompt, buildManualPrompt } from './prompt';
import { CLAUDE_TOKEN_ENV, TASK_CLAUDE_CONFIG_DIR, buildCreateArgs } from './sandbox';
import type { ScreenOps } from './screen';
import { ACTIVE_STATES, TaskStore, type TaskRecord } from './state';
import type { TokenPurpose } from './tokens';
import type { WorkspaceFs } from './workspace';

type Participation = z.infer<typeof ParticipationConfigSchema>;
type RejectReason = PayloadOf<AgentMessage, 'offer.reject'>['reason'];
type Usage = { weighted: number; input: number; output: number };
const NO_USAGE: Usage = { weighted: 0, input: 0, output: 0 };

export interface ExecutorConfig {
  /** This agent's id: put on every docker resource it creates (`orch.agent`) for reconcile. */
  agentId: string;
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
  /** How long `orch accept` waits for the server's ack. */
  acceptTimeoutMs?: number;
  /** Length of one `timeoutSec` unit in ms (1000; tests shrink it). */
  timeoutUnitMs?: number;
  now?: () => number;
}

export interface ExecutorDeps {
  git: GitOps;
  docker: DockerOps;
  screen: ScreenOps;
  /** Runs `claude -p` (auto mode). Defaults to real child processes. */
  proc?: ProcessOps;
  fs: WorkspaceFs;
  requestToken: (assignmentId: string, purpose: TokenPurpose) => Promise<string>;
  /** Persists and sends an acked message; returns its message id. */
  enqueue: <T extends OutboxType>(type: T, payload: PayloadOf<AgentMessage, T>) => string;
  isPaused: () => boolean;
  /** The member's Claude token (`/secrets/claude-token`), or null when `orch login` was not run. */
  readClaudeToken: () => string | null;
  participations: () => readonly Participation[];
  /**
   * Asks the server for a fresh config (`config.request`) and resolves once it was applied, or
   * false on timeout / older server. Used once per AUTO offer whose project is missing from the
   * synced participation list, before rejecting it as `not_participating`.
   */
  refreshConfig?: () => Promise<boolean>;
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
  mode: 'auto' | 'manual';
  startedAt: string | null;
  timeoutSec: number | null;
  elapsedSec: number | null;
}

export interface RequestView {
  assignmentId: string;
  project: string;
  issueNumber: number;
  title: string;
  size: string;
  model: string;
  createdBy: string;
  expiresAt: string | null;
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
  /** Pending approval requests (`offer.request`), for `orch requests`. In memory only. */
  private readonly requests = new Map<string, OfferRequestPayload>();
  /** AUTO offers waiting for a config refresh before the guard re-checks them. */
  private readonly refreshing = new Set<string>();
  /** `orch accept` waiting for the ack of its `offer.accept` (message id -> resolver). */
  private readonly userAccepts = new Map<string, (ack: AckPayload) => void>();
  /** Live `claude -p` processes by assignment. */
  private readonly runs = new Map<string, RunningProcess>();
  private readonly proc: ProcessOps;
  private readonly jobs = new Set<Promise<unknown>>();
  private readonly log: Logger;

  constructor(
    private readonly cfg: ExecutorConfig,
    private readonly deps: ExecutorDeps,
  ) {
    this.store = new TaskStore(join(cfg.dataDir, 'tasks.json'));
    this.log = deps.logger;
    this.proc = deps.proc ?? spawnProcessOps;
  }

  private now(): number {
    return this.cfg.now?.() ?? Date.now();
  }

  // ---------- queries ----------

  view(r: TaskRecord): TaskView {
    const auto = r.execMode === 'AUTO';
    const started = r.runStartedAt ? Date.parse(r.runStartedAt) : NaN;
    const elapsed =
      Number.isFinite(started) && ACTIVE_STATES.includes(r.state)
        ? Math.max(0, Math.round((this.now() - started) / 1000))
        : null;
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
      attach: auto ? `orch logs ${r.issueNumber}` : attachCommand(r.issueNumber),
      mode: auto ? 'auto' : 'manual',
      startedAt: r.runStartedAt,
      timeoutSec: auto ? (r.timeoutSec ?? DEFAULT_TIMEOUT_SEC[r.size]) : null,
      elapsedSec: elapsed,
    };
  }

  views(): TaskView[] {
    return this.store.all().map((r) => this.view(r));
  }

  /** `hello.running` entries. */
  running(): { assignmentId: string; taskId: string; state: string; lastSeq: number }[] {
    return this.store
      .active()
      .filter((r) => r.pendingAcceptId === null)
      .map((r) => ({
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
    const existing = this.store.byIssue(issueNumber, fullName);
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
    // A duplicate ack replays the server's first answer: trust `ok`, not `duplicate`.
    const okAck = ack.ok;
    const waiting = this.store.all().find((r) => r.pendingAcceptId === replyTo);
    if (waiting) {
      const id = waiting.assignmentId;
      if (okAck) {
        this.store.update(id, { pendingAcceptId: null });
        this.log.info('auto offer accepted', { issue: waiting.issueNumber, assignmentId: id });
        this.track(this.prepare(id));
      } else {
        // Late or lost race (the server also sends task.cancel "taken"): nothing was started.
        this.log.info('auto offer acceptance refused', { assignmentId: id, error: ack.error });
        this.store.delete(id);
      }
      return;
    }
    const user = this.userAccepts.get(replyTo);
    if (user) {
      this.userAccepts.delete(replyTo);
      user(ack);
      return;
    }
    for (const [key, w] of this.claims) {
      if (w.entryId !== replyTo) continue;
      if (!ack.ok) {
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
        // An offer waiting for its config refresh is simply dropped (never accepted later).
        if (this.refreshing.delete(m.payload.assignmentId)) return true;
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
      case 'offer.request':
        this.requests.set(m.payload.assignmentId, m.payload);
        this.log.info('approval request received', {
          project: m.payload.task.project.fullName,
          issue: m.payload.task.issueNumber,
          hint: `orch accept ${m.payload.assignmentId}`,
        });
        return true;
      case 'offer.withdrawn':
        this.requests.delete(m.payload.assignmentId);
        return true;
      default:
        return false;
    }
  }

  private onOffer(p: TaskOfferPayload, replyTo?: string): void {
    if (p.kind === 'CLAIM') this.onClaimOffer(p, replyTo);
    else this.onAutoOffer(p);
  }

  private onClaimOffer(p: TaskOfferPayload, replyTo?: string): void {
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
    const rec = this.newRecord(p, 'MANUAL');
    this.store.put(rec);
    this.deps.enqueue('offer.accept', { assignmentId: p.assignmentId, execMode: 'MANUAL' });
    settle((w) => w.resolve(this.view(rec)));
    this.track(this.prepare(rec.assignmentId));
  }

  // ---------- auto mode: consent guard ----------

  /**
   * The agent is the last line of defense (PLAN 6, consent invariants): nothing runs unless the
   * offer is an AUTO_OFFER for a project this member runs in auto mode, or a CONSENT_REQUEST the
   * member accepted, and the machine is not paused and has a free slot.
   */
  autoGuard(p: TaskOfferPayload): { reason: RejectReason; detail: string } | null {
    if (p.kind !== 'AUTO_OFFER' && p.kind !== 'CONSENT_REQUEST') {
      return { reason: 'error', detail: `Unknown offer kind ${String(p.kind)}` };
    }
    if (p.kind === 'CONSENT_REQUEST' && p.accepted !== true) {
      return { reason: 'error', detail: 'The member has not accepted this request' };
    }
    if (p.execMode !== undefined && p.execMode !== 'AUTO') {
      return { reason: 'error', detail: `${p.kind} must run in AUTO mode (got ${p.execMode})` };
    }
    if (this.deps.isPaused()) return { reason: 'paused', detail: 'This machine is paused' };
    const used = this.store.active().length + this.claims.size;
    if (used >= this.cfg.maxConcurrent) {
      return {
        reason: 'concurrency',
        detail: `Already running ${used} task(s) (max ${this.cfg.maxConcurrent})`,
      };
    }
    const { task } = p;
    const part = this.deps
      .participations()
      .find(
        (x) =>
          x.projectId === task.project.id ||
          x.fullName.toLowerCase() === task.project.fullName.toLowerCase(),
      );
    if (!part) {
      return {
        reason: 'not_participating',
        detail: `No participation in ${task.project.fullName}`,
      };
    }
    if (p.kind === 'AUTO_OFFER' && part.mode !== 'AUTO') {
      return {
        reason: 'not_participating',
        detail: `Participation in ${task.project.fullName} is in ${part.mode} mode, not AUTO`,
      };
    }
    if (!part.allowedModels.includes(task.model)) {
      return { reason: 'model_not_allowed', detail: `Model ${task.model} is not allowed` };
    }
    if (!this.deps.readClaudeToken()) {
      return { reason: 'error', detail: 'No Claude token on this machine (run "orch login")' };
    }
    return null;
  }

  private onAutoOffer(p: TaskOfferPayload): void {
    const id = p.assignmentId;
    try {
      assertSafeId(id);
    } catch (e) {
      this.log.warn('ignoring an offer with an unsafe id', { error: errorMessage(e) });
      return;
    }
    if (this.store.get(id)) return; // re-sent offer: already accepted (or waiting for the ack)
    if (this.refreshing.has(id)) return; // re-sent while its config refresh is in flight
    if (p.expiresAt !== null && Date.parse(p.expiresAt) <= this.now()) {
      this.log.info('ignoring an expired offer', { assignmentId: id, expiresAt: p.expiresAt });
      return;
    }
    if (p.kind === 'CONSENT_REQUEST' && p.accepted !== true) {
      // Not consented yet: keep it as a request for "orch requests"; never run it.
      this.requests.set(id, {
        assignmentId: id,
        expiresAt: p.expiresAt,
        task: {
          taskId: p.task.taskId,
          project: { id: p.task.project.id, fullName: p.task.project.fullName },
          issueNumber: p.task.issueNumber,
          title: p.task.title,
          size: p.task.size,
          model: p.task.model,
          createdBy: p.task.createdBy,
        },
      });
      this.log.warn('consent request not accepted by the member: not running it', {
        assignmentId: id,
      });
      return;
    }
    const refusal = this.autoGuard(p);
    const refresh = this.deps.refreshConfig;
    if (refusal?.reason === 'not_participating' && refresh) {
      // The participation list may be stale (joined after connecting): resync once, re-check.
      this.refreshing.add(id);
      this.log.info('auto offer for an unknown participation: refreshing the config', {
        assignmentId: id,
        project: p.task.project.fullName,
      });
      this.track(
        refresh()
          .catch(() => false)
          .then(() => {
            if (!this.refreshing.delete(id)) return; // cancelled meanwhile
            if (this.store.get(id)) return;
            if (p.expiresAt !== null && Date.parse(p.expiresAt) <= this.now()) {
              this.log.info('ignoring an expired offer', { assignmentId: id });
              return;
            }
            this.decideAuto(p, this.autoGuard(p));
          }),
      );
      return;
    }
    this.decideAuto(p, refusal);
  }

  private decideAuto(
    p: TaskOfferPayload,
    refusal: { reason: RejectReason; detail: string } | null,
  ): void {
    const id = p.assignmentId;
    if (refusal) {
      this.log.info('auto offer rejected by the local guard', { assignmentId: id, ...refusal });
      this.deps.enqueue('offer.reject', { assignmentId: id, ...refusal });
      return;
    }
    this.requests.delete(id);
    const rec = this.newRecord(p, 'AUTO');
    this.store.put(rec);
    const msgId = this.deps.enqueue('offer.accept', { assignmentId: id, execMode: 'AUTO' });
    this.store.update(id, { pendingAcceptId: msgId });
    this.log.info('auto offer accepted locally, waiting for the server', {
      project: p.task.project.fullName,
      issue: p.task.issueNumber,
    });
  }

  // ---------- approval requests (orch requests / accept / reject) ----------

  requestViews(): RequestView[] {
    const now = this.now();
    for (const [id, r] of this.requests) {
      if (r.expiresAt !== null && Date.parse(r.expiresAt) <= now) this.requests.delete(id);
    }
    return [...this.requests.values()].map((r) => ({
      assignmentId: r.assignmentId,
      project: r.task.project.fullName,
      issueNumber: r.task.issueNumber,
      title: r.task.title,
      size: r.task.size,
      model: r.task.model,
      createdBy: r.task.createdBy.login,
      expiresAt: r.expiresAt,
    }));
  }

  /** `<assignmentId>`, `<n>` or `<owner/repo>#<n>` of a pending request. */
  private resolveRequest(ref: string): string {
    const list = this.requestViews();
    const exact = list.find((r) => r.assignmentId === ref);
    if (exact) return exact.assignmentId;
    const m = /^(?:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#)?(\d+)$/.exec(ref.trim());
    if (m) {
      const issue = Number(m[2]);
      const proj = m[1]?.toLowerCase();
      const hits = list.filter(
        (r) => r.issueNumber === issue && (!proj || r.project.toLowerCase() === proj),
      );
      if (hits.length === 1 && hits[0]) return hits[0].assignmentId;
      if (hits.length > 1) {
        throw new ExecError('ambiguous', `Several requests for #${issue}. Use the request id.`);
      }
      throw new ExecError('not_found', `No pending request for ${ref}. See "orch requests".`);
    }
    // An id the agent has not seen (e.g. after a restart): the server checks it.
    try {
      return assertSafeId(ref);
    } catch {
      throw new ExecError('not_found', `No pending request ${JSON.stringify(ref)}.`);
    }
  }

  /** `orch accept <id>`: the member consents; the server then sends the accepted task.offer. */
  async acceptRequest(ref: string): Promise<{ assignmentId: string; message: string }> {
    const id = this.resolveRequest(ref);
    if (this.deps.isPaused()) {
      throw new ExecError('paused', 'This machine is paused. Run "orch resume" first.');
    }
    const used = this.store.active().length + this.claims.size;
    if (used >= this.cfg.maxConcurrent) {
      throw new ExecError(
        'concurrency',
        `Already running ${used} task(s) (max ${this.cfg.maxConcurrent}).`,
      );
    }
    if (!this.deps.readClaudeToken()) {
      throw new ExecError('no_claude_token', 'No Claude token. Run "orch login" first.');
    }
    const msgId = this.deps.enqueue('offer.accept', { assignmentId: id, execMode: 'AUTO' });
    const ack = await new Promise<AckPayload | null>((resolve) => {
      const timer = setTimeout(() => {
        this.userAccepts.delete(msgId);
        resolve(null);
      }, this.cfg.acceptTimeoutMs ?? 15_000);
      this.userAccepts.set(msgId, (a) => {
        clearTimeout(timer);
        resolve(a);
      });
    });
    if (ack && !ack.ok) {
      this.requests.delete(id);
      throw new ExecError(
        ack.error?.code ?? 'refused',
        `The server refused: ${ack.error?.message ?? 'the request is no longer open'}`,
      );
    }
    this.requests.delete(id);
    return {
      assignmentId: id,
      message: ack
        ? 'Accepted. The task starts on this machine in auto mode ("orch status").'
        : 'Acceptance queued; it is sent when the agent is connected.',
    };
  }

  /** `orch reject <id>`. */
  rejectRequest(ref: string): { assignmentId: string; message: string } {
    const id = this.resolveRequest(ref);
    this.deps.enqueue('offer.reject', { assignmentId: id, reason: 'user_declined' });
    this.requests.delete(id);
    return { assignmentId: id, message: 'Rejected.' };
  }

  private newRecord(p: TaskOfferPayload, execMode: 'AUTO' | 'MANUAL'): TaskRecord {
    const { task } = p;
    const id = p.assignmentId;
    const taskDir = join(this.cfg.workDir, id);
    const now = new Date().toISOString();
    const branch = pickBranch(task.branchName, task.issueNumber, task.title);
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
      branch,
      state: 'preparing',
      seq: 0,
      taskDir,
      cloneDir: join(taskDir, 'src'),
      gitDir: join(this.cfg.dataDir, 'git', `${id}.git`),
      container: containerName(task.issueNumber, id),
      network: networkName(id),
      image: null,
      builtImage: null,
      composeProject: null,
      screen: screenName(
        task.issueNumber,
        task.project.fullName,
        this.store
          .active()
          .filter((r) => r.execMode === 'MANUAL')
          .map((r) => r.screen),
      ),
      prUrl: null,
      error: null,
      warnings: [],
      cleanupRequested: false,
      execMode,
      pendingAcceptId: null,
      workspaceFolder: '/workspace',
      timeoutSec: execMode === 'AUTO' ? (p.timeoutSec ?? DEFAULT_TIMEOUT_SEC[task.size]) : null,
      runStartedAt: null,
      logFile: null,
      prompt: execMode === 'AUTO' ? buildAutoPrompt(task, branch) : buildManualPrompt(task, branch),
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

  private async prepare(id: string): Promise<void> {
    const rec = () => this.store.get(id) as TaskRecord;
    const first = rec();
    let sidecars: string | null = null;
    // cancel()/cleanup() tore down what existed at that moment: a step still in flight may have
    // created more since (network, sidecars, container, screen session). Tear down again.
    const abandoned = async (): Promise<boolean> => {
      if (!this.cancelled(id)) return false;
      const last = this.store.get(id) ?? first;
      await this.teardown({ ...last, composeProject: last.composeProject ?? sidecars });
      return true;
    };
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
        this.deps.fs.mkdir(join(this.cfg.dataDir, 'git'));
        await this.deps.git.clone(mirror, remoteUrl, repoOf(r0), token);
      }
      const repo = repoOf(r0);
      await this.deps.git.createBranch(repo, r0.branch, r0.baseBranch);
      await this.deps.git.setIdentity(repo, this.cfg.identity);
      await this.deps.git.seedTaskGit(repo);
      // The task dir only (the private git dir lives in the agent's data dir and stays its own).
      this.deps.fs.chownR(r0.taskDir, this.cfg.uid, this.cfg.gid);
      if (await abandoned()) return;

      this.status(id, 'building');
      const env = selectDevEnv(r0.cloneDir, this.cfg.defaultImage);
      for (const w of env.warnings) this.log.warn(w, { issue: r0.issueNumber });
      this.store.update(id, { warnings: env.warnings, workspaceFolder: env.workspaceFolder });
      const labels = taskLabels(id, r0.issueNumber, this.cfg.agentId);
      await this.deps.docker.createNetwork(r0.network, labels);

      const compose = findComposeFile(r0.cloneDir);
      if (compose) {
        sidecars = composeProject(id);
        await this.startSidecars(id, compose, labels);
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
      if (await abandoned()) return;

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
      if (await abandoned()) return;

      const prompt = rec().prompt ?? '';
      if (r0.execMode === 'AUTO') {
        await this.runAuto(id, prompt);
        return;
      }
      await this.deps.screen.start(r0.screen, this.claudeArgv(rec(), prompt));
      if (await abandoned()) return;
      this.store.update(id, { prompt: null });
      this.status(id, 'running', `attach: ${attachCommand(r0.issueNumber)}`);
      this.log.info('task ready', { issue: r0.issueNumber, attach: attachCommand(r0.issueNumber) });
    } catch (err) {
      if (await abandoned()) return;
      await this.fail(id, err);
    }
  }

  /**
   * The compose files every invocation after validation uses (`up`, `down`): the checked model
   * (the repo file + the env_file override, resolved, validated and sanitized) and the network
   * override, with the clone as project directory. The raw repo file is only ever read by
   * `config`, always together with the env_file override when one is needed.
   */
  private sidecarTarget(r: TaskRecord): { files: string[]; cwd: string } {
    return {
      files: [join(r.taskDir, 'compose.orch.checked.json'), join(r.taskDir, 'compose.orch.yaml')],
      cwd: r.cloneDir,
    };
  }

  /**
   * Validates the repo's compose file (sources, then the resolved model), strips published ports
   * and container names, labels every service, and starts the sidecars from the checked model
   * (never the raw file). Failures name the file, the step and what to change.
   */
  private async startSidecars(
    id: string,
    compose: string,
    labels: Record<string, string>,
  ): Promise<void> {
    const r = this.store.get(id) as TaskRecord;
    const project = composeProject(id);
    const file = relative(r.cloneDir, compose) || compose;
    const early = scanComposeSources(r.cloneDir, compose);
    if (early.length > 0) throw new ComposeGuardError(early);
    // A gitignored .env is absent from a fresh clone: fall back to the example or drop the entry.
    const envFix = planEnvFileFallbacks(r.cloneDir, compose);
    const files = [compose];
    if (envFix.override !== null) {
      const fix = join(r.taskDir, 'compose.orch.envfix.yaml');
      this.deps.fs.writeFile(fix, envFix.override);
      files.push(fix);
      for (const w of envFix.warnings) this.warn(id, w);
    }
    let model: unknown;
    try {
      model = await this.deps.docker.composeConfig(project, files, r.cloneDir);
    } catch (err) {
      throw sidecarError(file, 'config', err);
    }
    const problems = checkComposeModel(model, r.cloneDir, project, r.network);
    if (problems.length > 0) throw new ComposeGuardError(problems);
    const safe = sanitizeComposeModel(model, labels);
    if (safe.stripped.length > 0) {
      this.warn(id, `compose: ${safe.stripped.join('; ')}`.slice(0, 1000));
    }
    const target = this.sidecarTarget(r);
    const [checked, override] = target.files as [string, string];
    this.deps.fs.writeFile(checked, JSON.stringify(safe.model, null, 2));
    this.deps.fs.writeFile(
      override,
      `# Written by orch: put the sidecars on the task network.\nnetworks:\n  default:\n    name: ${r.network}\n    external: true\n`,
    );
    this.store.update(id, { composeProject: project });
    try {
      await this.deps.docker.composeUp(project, target.files, target.cwd);
    } catch (err) {
      throw sidecarError(file, 'up', err);
    }
  }

  /** Logs a warning and records it on the task (shown by `orch status` and the run log). */
  private warn(id: string, w: string): void {
    const r = this.store.get(id) as TaskRecord;
    this.log.warn(w, { issue: r.issueNumber });
    this.store.update(id, { warnings: [...r.warnings, w] });
  }

  private claudeArgv(r: TaskRecord, prompt: string | null): string[] {
    const base = ['docker', 'exec', '-it', '-w', r.workspaceFolder, r.container];
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

  private async fail(id: string, err: unknown, usage: Usage = NO_USAGE): Promise<void> {
    const message = redact(errorMessage(err)).slice(0, 3000);
    this.log.error('task failed', { assignmentId: id, error: message });
    this.runs.get(id)?.kill();
    const rec = this.store.update(id, { state: 'failed', error: message, prompt: null });
    // Report first: the outbox persists at once, so a stop during the teardown cannot lose it
    // (the record is no longer active, a restart would not report it again).
    this.deps.enqueue('task.finished', {
      assignmentId: id,
      seq: this.nextSeq(id),
      outcome: 'failed',
      usage,
      error: message,
    });
    await this.teardown(rec);
  }

  // ---------- auto mode: headless run ----------

  /**
   * Runs `claude -p` in the task container, streams its output to the run log and enforces the
   * hard timeout (the container is removed, which kills the run). Then pushes and reports.
   */
  private async runAuto(id: string, prompt: string): Promise<void> {
    const r = this.store.get(id) as TaskRecord;
    const logDir = join(this.cfg.dataDir, 'logs');
    mkdirSync(logDir, { recursive: true, mode: 0o700 });
    const logFile = join(logDir, `${id}.log`);
    const out = createWriteStream(logFile, { flags: 'a', mode: 0o600 });
    out.on('error', (e) => this.log.warn('run log write failed', { error: e.message }));
    const timeoutSec = r.timeoutSec ?? DEFAULT_TIMEOUT_SEC[r.size];
    this.store.update(id, {
      logFile,
      timeoutSec,
      prompt: null,
      runStartedAt: new Date(this.now()).toISOString(),
    });
    this.status(id, 'running', `claude -p (auto mode, timeout ${Math.round(timeoutSec / 60)} min)`);
    const argv = buildAutoArgv({
      container: r.container,
      workspaceFolder: r.workspaceFolder,
      claudeBin: this.cfg.claudeBin,
      model: claudeModel(r.model),
      size: r.size,
    });
    this.log.info('auto run started', { issue: r.issueNumber, log: logFile });
    let result: ClaudeResult | null = null;
    let stderrTail = '';
    const proc = this.proc.spawnLines(
      argv,
      prompt,
      (line) => {
        out.write(`${redact(line)}\n`);
        const res = parseResultEvent(line);
        if (res) result = res;
      },
      (line) => {
        const clean = redact(line);
        out.write(`[stderr] ${clean}\n`);
        stderrTail = `${stderrTail}\n${clean}`.slice(-1500);
      },
    );
    this.runs.set(id, proc);
    let timedOut = false;
    const timer = setTimeout(
      () => {
        timedOut = true;
        this.log.warn('auto run timed out, stopping it', { issue: r.issueNumber, timeoutSec });
        proc.kill();
        void this.deps.docker.remove(r.container).catch(() => undefined);
      },
      timeoutSec * (this.cfg.timeoutUnitMs ?? 1000),
    );
    let code: number;
    try {
      code = await proc.exit;
    } finally {
      clearTimeout(timer);
      this.runs.delete(id);
      await new Promise<void>((res) => out.end(() => res()));
    }
    if (this.cancelled(id)) return; // cancel() already stopped and reported it
    const final = result as ClaudeResult | null;
    const usage = final ? this.weighResult(final, r.model) : await this.collectUsage(r);
    if (timedOut) {
      await this.fail(
        id,
        new Error(`Timed out after ${Math.round(timeoutSec / 60)} min; the run was stopped.`),
        usage,
      );
      return;
    }
    if (code !== 0 || !final || final.isError) {
      const detail = final?.text || stderrTail.trim() || 'no result event';
      const limited = isRateLimited(`${detail} ${stderrTail}`) ? 'rate limited: ' : '';
      await this.fail(
        id,
        new Error(
          `${limited}claude exited with code ${code}${final ? ` (${final.subtype})` : ''}: ${detail.slice(-1500)}`,
        ),
        usage,
      );
      return;
    }
    this.status(id, 'pushing');
    try {
      await this.pushAndReport(id, usage, final.text);
    } catch (err) {
      if (this.cancelled(id)) return;
      await this.fail(id, new Error(`Push failed: ${errorMessage(err)}`), usage);
      return;
    }
    if (this.cancelled(id)) return; // cancelled during the push: cancel() reported it
    const after = this.store.update(id, { state: 'finished', error: null });
    await this.teardown(after);
    this.log.info('auto run finished', { issue: r.issueNumber });
  }

  private weighResult(res: ClaudeResult, model: string): Usage {
    const factor = modelFactor(model, this.cfg.opusFactor ?? 5);
    return {
      weighted: Math.round(weigh(res.usage, factor)),
      input: res.usage.input,
      output: res.usage.output,
    };
  }

  /** Commits leftovers, pushes with a scoped token and sends task.pushed + task.finished. */
  private async pushAndReport(id: string, usage: Usage, claudeSummary = ''): Promise<void> {
    const rec = this.store.get(id) as TaskRecord;
    const git = this.deps.git;
    const repo = repoOf(rec);
    // The task's own commits live in its throwaway .git, which the agent never reads: their
    // subjects are read inside the sandbox, and the result is squashed into one agent commit.
    const taskSubjects = await this.taskSubjects(rec);
    const body = taskSubjects.map((t) => `- ${t}`).join('\n');
    // Freeze the task AND its sidecars (they mount the clone too) while staging, so nothing can
    // swap files between the checks and the commit. Fails closed when one cannot be frozen.
    const paused = await this.freeze(rec);
    try {
      await git.commitAll(
        repo,
        `orch: changes for #${rec.issueNumber}${body ? `\n\n${body}` : ''}`,
        this.cfg.identity,
      );
    } finally {
      for (const c of paused) await this.deps.docker.unpause(c).catch(() => undefined);
    }
    const ahead = await git.commitsAhead(repo, rec.baseBranch);
    // A cancel may land at any await below: then report nothing more (cancel() sent finished).
    if (this.cancelled(id)) return;
    if (ahead === 0) {
      this.deps.enqueue('task.finished', {
        assignmentId: id,
        seq: this.nextSeq(id),
        outcome: 'no_changes',
        usage,
      });
      return;
    }
    const token = await this.deps.requestToken(id, 'push');
    if (this.cancelled(id)) return;
    await git.push(repo, rec.branch, token);
    const [headSha, changedFiles, subjects] = await Promise.all([
      git.headSha(repo),
      git.changedFiles(repo, rec.baseBranch),
      git.subjects(repo, rec.baseBranch),
    ]);
    if (this.cancelled(id)) return;
    let summary = (taskSubjects.length > 0 ? taskSubjects : subjects)
      .map((s) => `- ${s}`)
      .join('\n');
    if (claudeSummary.trim()) summary += `\n\nClaude's summary:\n${redact(claudeSummary.trim())}`;
    this.deps.enqueue('task.pushed', {
      assignmentId: id,
      seq: this.nextSeq(id),
      branch: rec.branch,
      headSha,
      changedFiles,
      summary: summary.slice(0, 10_000),
    });
    this.deps.enqueue('task.finished', {
      assignmentId: id,
      seq: this.nextSeq(id),
      outcome: 'succeeded',
      usage,
    });
  }

  /**
   * Pauses the task container and every running sidecar of the task's compose project. A
   * container that is not running (stopped, removed) cannot write and is skipped; any other pause
   * failure, or a sidecar still running afterwards, unpauses everything and throws.
   */
  private async freeze(rec: TaskRecord): Promise<string[]> {
    const docker = this.deps.docker;
    const paused: string[] = [];
    try {
      const sidecars = rec.composeProject ? await docker.composeRunning(rec.composeProject) : [];
      for (const c of [rec.container, ...sidecars]) {
        try {
          await docker.pause(c);
          paused.push(c);
        } catch (err) {
          if (await docker.isRunning(c).catch(() => true)) {
            throw new Error(`could not pause ${c} before committing: ${errorMessage(err)}`);
          }
        }
      }
      if (rec.composeProject) {
        const still = await docker.composeRunning(rec.composeProject);
        if (still.length > 0) {
          throw new Error(`sidecars still running after pause: ${still.join(', ')}`);
        }
      }
      return paused;
    } catch (err) {
      for (const c of paused) await docker.unpause(c).catch(() => undefined);
      throw err;
    }
  }

  /**
   * Subjects of the commits the task made in its throwaway .git, read by git INSIDE the task
   * container (best effort: empty when the image has no git). Untrusted text, sanitized.
   */
  private async taskSubjects(rec: TaskRecord): Promise<string[]> {
    try {
      const res = await this.deps.docker.exec(rec.container, [
        'git',
        '-C',
        rec.workspaceFolder,
        'log',
        '--format=%s',
        '-n',
        '50',
        `refs/remotes/origin/${rec.baseBranch}..HEAD`,
        '--',
      ]);
      if (res.code !== 0) return [];
      return res.stdout
        .split('\n')
        .map((l) =>
          l
            .split('')
            .filter((c) => c >= ' ' && c !== '\x7f')
            .join('')
            .trim()
            .slice(0, 200),
        )
        .filter((l) => l !== '');
    } catch {
      return [];
    }
  }

  // ---------- done ----------

  private findTask(issueNumber: number, project?: string): TaskRecord {
    if (!project) {
      const active = this.store.active().filter((r) => r.issueNumber === issueNumber);
      if (new Set(active.map((r) => r.projectFullName)).size > 1) {
        throw new ExecError(
          'ambiguous',
          `Several projects have a task for #${issueNumber}. Use <owner/repo>#${issueNumber}.`,
        );
      }
    }
    const rec = this.store.byIssue(issueNumber, project);
    if (!rec)
      throw new ExecError('not_found', `No task for issue #${issueNumber} on this machine.`);
    return rec;
  }

  private findRunning(issueNumber: number, project?: string): TaskRecord {
    const rec = this.findTask(issueNumber, project);
    if (rec.state !== 'running') {
      throw new ExecError('bad_state', `Issue #${issueNumber} is ${rec.state}, not running.`);
    }
    return rec;
  }

  private findManual(issueNumber: number, project?: string): TaskRecord {
    const rec = this.findRunning(issueNumber, project);
    if (rec.execMode === 'AUTO') {
      throw new ExecError(
        'auto_mode',
        `Issue #${issueNumber} runs in auto mode: it pushes on its own. Follow it with "orch logs ${issueNumber}".`,
      );
    }
    return rec;
  }

  async done(issueNumber: number, project?: string): Promise<TaskView> {
    const rec = this.findManual(issueNumber, project);
    const id = rec.assignmentId;
    this.status(id, 'pushing');
    try {
      const usage = await this.collectUsage(rec);
      await this.pushAndReport(id, usage);
    } catch (err) {
      if (this.cancelled(id)) throw cancelledDuringDone(issueNumber);
      const message = redact(errorMessage(err));
      // commitAll removed the task's .git: give the still-running session a working copy back.
      // The task is frozen meanwhile: it cannot swap `.git` (or a sub-path) for a symlink between
      // the removal and the copy, which would make the agent write through it.
      const r = this.store.get(id) as TaskRecord;
      const frozen = await this.deps.docker.pause(r.container).then(
        () => true,
        () => false,
      );
      try {
        await this.deps.git.seedTaskGit(repoOf(r));
        this.deps.fs.chownR(join(r.cloneDir, '.git'), this.cfg.uid, this.cfg.gid);
      } catch (seedErr) {
        this.log.warn('could not restore the task git dir', { error: errorMessage(seedErr) });
      } finally {
        if (frozen) await this.deps.docker.unpause(r.container).catch(() => undefined);
      }
      this.status(id, 'running', `done failed: ${message}`);
      throw new ExecError('done_failed', `Push failed, the task is still running: ${message}`);
    }
    if (this.cancelled(id)) throw cancelledDuringDone(issueNumber);
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
    // The task writes these logs itself: the protocol wants integer token counts.
    usage.weighted = Math.round(usage.weighted);
    usage.input = Math.round(usage.input);
    usage.output = Math.round(usage.output);
    return usage;
  }

  // ---------- attach / shell ----------

  async attach(issueNumber: number, project?: string): Promise<string[]> {
    const rec = this.findManual(issueNumber, project);
    if (!(await this.deps.screen.exists(rec.screen))) {
      await this.deps.screen.start(rec.screen, this.claudeArgv(rec, null));
    }
    return ['screen', '-r', rec.screen];
  }

  shell(issueNumber: number, project?: string): string[] {
    const rec = this.findRunning(issueNumber, project);
    return [
      'docker',
      'exec',
      '-it',
      '-w',
      rec.workspaceFolder,
      rec.container,
      'sh',
      '-c',
      'command -v bash >/dev/null && exec bash || exec sh',
    ];
  }

  /** `orch logs <n>`: a `tail` of the auto run log. */
  logs(issueNumber: number, project?: string, follow = true, lines = 100): string[] {
    const rec = this.findTask(issueNumber, project);
    if (!rec.logFile) {
      throw new ExecError(
        'no_log',
        rec.execMode === 'AUTO'
          ? `Issue #${issueNumber} has not started running yet ("orch status").`
          : `Issue #${issueNumber} runs in manual mode: use "orch attach ${issueNumber}".`,
      );
    }
    const n = String(Math.max(1, Math.min(10_000, Math.floor(lines))));
    const live = follow && ACTIVE_STATES.includes(rec.state);
    return ['tail', '-n', n, ...(live ? ['-F'] : []), rec.logFile];
  }

  // ---------- cancel / cleanup / teardown ----------

  private async cancel(id: string, reason: string): Promise<void> {
    this.requests.delete(id);
    const rec = this.store.get(id);
    if (!rec || !ACTIVE_STATES.includes(rec.state)) return;
    if (rec.pendingAcceptId !== null) {
      // Expired, withdrawn or taken before the server confirmed our accept: nothing started.
      this.log.info('offer withdrawn before it started', { issue: rec.issueNumber, reason });
      this.store.delete(id);
      return;
    }
    this.log.info('task cancelled by the server', { issue: rec.issueNumber, reason });
    const after = this.store.update(id, {
      state: 'cancelled',
      error: `cancelled: ${reason}`,
      prompt: null,
    });
    this.runs.get(id)?.kill();
    this.deps.enqueue('task.finished', {
      assignmentId: id,
      seq: this.nextSeq(id),
      outcome: 'cancelled',
      usage: { weighted: 0, input: 0, output: 0 },
    });
    await this.teardown(after);
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
    if (rec.execMode === 'MANUAL') await step('screen', () => this.deps.screen.kill(rec.screen));
    await step('container', () => this.deps.docker.remove(rec.container));
    if (rec.composeProject) {
      const project = rec.composeProject;
      const target = this.sidecarTarget(rec);
      const known = target.files.every((f) => this.deps.fs.exists(f));
      await step('sidecars', () =>
        this.deps.docker.composeDown(project, known ? target : undefined),
      );
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
      this.runs.get(id)?.kill();
      if (rec.builtImage) await this.deps.docker.removeImage(rec.builtImage).catch(() => undefined);
      await this.deps.fs.remove(rec.taskDir);
      if (rec.gitDir) await this.deps.fs.remove(rec.gitDir);
      if (rec.logFile) rmSync(rec.logFile, { force: true });
      this.store.delete(id);
    } else {
      for (const c of await this.labeled('container')) {
        if (c.value === id) await this.deps.docker.remove(c.name).catch(() => undefined);
      }
      await this.deps.fs.remove(join(this.cfg.workDir, id));
      await this.deps.fs.remove(join(this.cfg.dataDir, 'git', `${id}.git`));
      rmSync(join(this.cfg.dataDir, 'logs', `${id}.log`), { force: true });
    }
    this.log.info('task cleaned up', { assignmentId: id });
  }

  private async labeled(kind: 'container' | 'network') {
    try {
      return await this.deps.docker.listLabeled(kind, TASK_LABEL, this.cfg.agentId);
    } catch (err) {
      this.log.warn(`could not list ${kind}s`, { error: errorMessage(err) });
      return [];
    }
  }

  /**
   * After a restart: finish pending cleanups, fail interrupted preparations, re-create screen
   * sessions of running tasks and remove orphaned containers, networks and sidecars. Only the
   * resources labeled with THIS agent's id are touched (several agents may share a daemon).
   */
  async reconcile(): Promise<void> {
    for (const rec of [...this.store.all()]) {
      try {
        if (rec.cleanupRequested) await this.cleanup(rec.assignmentId);
        else if (rec.pendingAcceptId !== null) {
          // Accept still waiting for the server's ack (it stays in the outbox): keep waiting.
          continue;
        } else if (rec.state === 'preparing' || rec.state === 'building') {
          await this.fail(rec.assignmentId, new Error('The agent restarted during preparation.'));
        } else if (
          rec.execMode === 'AUTO' &&
          (rec.state === 'running' || rec.state === 'pushing')
        ) {
          // The headless run died with the agent and cannot be re-attached: report a failure.
          await this.fail(
            rec.assignmentId,
            new Error('The agent restarted during the auto run; the run was lost.'),
          );
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
      const projects = await this.deps.docker.composeProjects(
        COMPOSE_PROJECT_PREFIX,
        this.cfg.agentId,
      );
      for (const p of projects) {
        if (!liveProjects.has(p)) await this.deps.docker.composeDown(p);
      }
    } catch (err) {
      this.log.warn('could not list compose projects', { error: errorMessage(err) });
    }
  }

  /** Kills the runs; their jobs then report and tear down (await `idle()` for that). */
  close(): void {
    for (const p of this.runs.values()) p.kill();
    for (const resolve of this.userAccepts.values()) {
      resolve({ ok: false, error: { code: 'stopping', message: 'Agent stopping' } });
    }
    this.userAccepts.clear();
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

/** `orch done` raced with a server cancel: cancel() already tore down and reported. */
const cancelledDuringDone = (issueNumber: number) =>
  new ExecError('cancelled', `Issue #${issueNumber} was cancelled by the server meanwhile.`);

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
/** The task's private git dir + worktree. */
function repoOf(r: TaskRecord): GitRepo {
  if (!r.gitDir) {
    throw new Error(
      'This task was prepared by an older agent version (git dir inside the clone). Cancel it and take it again.',
    );
  }
  return { gitDir: r.gitDir, workTree: r.cloneDir };
}

const safeName = (s: string) => s.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 100) || 'repo';

/**
 * A failed `docker compose` step of the sidecars, as an actionable message for `orch status` and
 * the task.finished reason: which file, which step, what to change, then docker's own words.
 */
export function sidecarError(file: string, step: 'config' | 'up', err: unknown): Error {
  const raw = errorMessage(err);
  const env = /env file (\S+) not found/.exec(raw)?.[1];
  let hint: string;
  if (env !== undefined) {
    hint =
      `env file ${env} does not exist in the clone (a gitignored .env is never cloned). ` +
      `Commit a .env.example next to it, or mark the entry "required: false" in ${file}.`;
  } else if (step === 'config') {
    hint = `${file} does not load; check it with "docker compose -f ${file} config".`;
  } else {
    hint = `a service of ${file} did not start; check it with "docker compose -f ${file} up".`;
  }
  return new Error(`Sidecars (${file}) failed at "docker compose ${step}": ${hint} [${raw}]`);
}
