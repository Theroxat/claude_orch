/**
 * The agent daemon: wires the WS client, outbox, inbound dedupe, pause state, usage loop,
 * heartbeat and control socket. All collaborators are injectable for tests.
 */
import { freemem, loadavg } from 'node:os';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import {
  SERVER_ACKED_TYPES,
  agentMessage,
  compareVersions,
  normalizeVersion,
  type AckPayload,
  type AgentConfigPayload,
  type ClaudeAuthErrorClass,
  type ClaudeAuthPayload,
  type ServerMessage,
  type TasksListPayload,
} from '@orch/shared';
import type { ControlResult, StatusInfo } from './cli/protocol';
import { ManualExecutor, type ExecutorConfig, type ExecutorDeps } from './exec/executor';
import { TokenBroker } from './exec/tokens';
import { startControlServer, type ControlServer } from './control/server';
import { ClaudeAuthState } from './claude-auth';
import type { ClaudeCheckOutcome } from './claude-check';
import { InboundDedup } from './dedup';
import { errorMessage, type Logger } from './log';
import { Outbox } from './outbox';
import { PauseState } from './pause';
import { UsageLoop, type UsageSource } from './usage-loop';
import { Updater, type UpdaterOptions } from './update/updater';
import { AGENT_VERSION } from './version';
import type { BackoffOptions } from './ws/backoff';
import { WsClient } from './ws/client';

/** How long `stop()` waits for the executor's jobs (killed runs reporting) before going offline. */
const STOP_DRAIN_MS = 3_000;
/** Check classes that say nothing about the token: retried after `retryMs`. */
const INCONCLUSIVE: ReadonlySet<ClaudeAuthErrorClass> = new Set(['timeout', 'network', 'error']);

/** Real Claude login check (`claude-check.ts`), wired by main.ts; injectable for tests. */
export interface ClaudeCheckOptions {
  run: () => Promise<ClaudeCheckOutcome>;
  /** Cheap fingerprint of the token file (mtime + size), null when it is missing. */
  tokenStat: () => string | null;
  /** sha256 of the trimmed token file content, null when missing or empty. */
  tokenHash: () => string | null;
  /** Removes leftover check containers (startup). */
  cleanup?: () => Promise<void>;
  /** Token file watch period (default 30 s). */
  watchMs?: number;
  /** Re-check after an inconclusive result (timeout, network, error) after this long (15 min). */
  retryMs?: number;
}

export interface AgentOptions {
  serverUrl: string;
  wsUrl: string;
  credential: string;
  agentId: string | null;
  dataDir: string;
  socketPath: string;
  usageIntervalSec: number;
  usageIntervalExplicit: boolean;
  usageSource: UsageSource;
  /** Whether the Claude token file exists and is non-empty (never reads its value). */
  claudeTokenPresent?: () => boolean;
  logger: Logger;
  backoff?: Partial<BackoffOptions>;
  outboxRetryMs?: number;
  usageFirstDelayMs?: number;
  /** Manual-mode task execution. Without it, take/done/list answer "not configured". */
  exec?: {
    config: ExecutorConfig;
    deps: Pick<ExecutorDeps, 'git' | 'docker' | 'screen' | 'fs' | 'readClaudeToken' | 'proc'>;
  };
  tokenTimeoutMs?: number;
  listTimeoutMs?: number;
  /** How long to wait for the answer to `config.request` (default 5 s). */
  configRequestTimeoutMs?: number;
  /** Real Claude login check. Without it `claude.check` answers "unsupported". */
  claudeCheck?: ClaudeCheckOptions;
  /** Self-update (`agent.update`, `orch update`). Without it the agent does not offer it. */
  update?: Pick<
    UpdaterOptions,
    'runner' | 'selfId' | 'imageRepo' | 'dockerBin' | 'helperDelaySec' | 'idlePollMs'
  > & { currentVersion?: string };
}

interface ConfigWaiter {
  id: string;
  promise: Promise<boolean>;
  resolve: (ok: boolean) => void;
  timer: NodeJS.Timeout;
}

interface ListWaiter {
  resolve: (p: TasksListPayload) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

export class Agent {
  readonly pause: PauseState;
  readonly outbox: Outbox;
  readonly dedup: InboundDedup;
  readonly client: WsClient;
  readonly usage: UsageLoop;
  readonly tokens: TokenBroker;
  readonly executor: ManualExecutor | undefined;
  readonly updater: Updater | undefined;
  /** The server accepts `task.log` (from `welcome`). */
  private liveLogs = false;
  /** Version the server recommends (from `welcome`). */
  private latestAgentVersion: string | null = null;
  private participations: AgentConfigPayload['participations'] = [];
  private readonly listWaiters = new Map<string, ListWaiter>();
  /** In-flight `config.request` (concurrent refreshes share it). */
  private configWaiter: ConfigWaiter | undefined;
  private control: ControlServer | undefined;
  private heartbeatTimer: NodeJS.Timeout | undefined;
  private agentId: string | null;
  private lastUsageReportAt: string | null = null;
  private readonly log: Logger;
  private readonly claudeAuth: ClaudeAuthState;
  private authInflight: { hash: string | null; promise: Promise<ClaudeAuthPayload> } | undefined;
  private lastTokenStat: string | null | undefined;
  private tokenWatchTimer: NodeJS.Timeout | undefined;
  /** Set by `stop()`: a token watch whose startup cleanup settles afterwards does not start. */
  private stopped = false;
  /** An old server rejected `claude.auth` (logged once). */
  private claudeAuthUnsupportedLogged = false;

  /** `claudeTokenPresent` (file exists) and `claudeAuthValid` (last task did not fail on auth). */
  private tokenFlag(): { claudeTokenPresent?: boolean; claudeAuthValid: boolean } {
    const claudeAuthValid = this.claudeAuth.isValid();
    if (!this.opts.claudeTokenPresent) return { claudeAuthValid };
    try {
      return { claudeTokenPresent: this.opts.claudeTokenPresent(), claudeAuthValid };
    } catch {
      return { claudeAuthValid };
    }
  }

  constructor(private readonly opts: AgentOptions) {
    this.log = opts.logger;
    this.agentId = opts.agentId;
    this.claudeAuth = new ClaudeAuthState(opts.dataDir);
    this.pause = new PauseState(join(opts.dataDir, 'state.json'));
    this.outbox = new Outbox(join(opts.dataDir, 'outbox.json'), {
      retryMs: opts.outboxRetryMs,
      logger: this.log,
    });
    this.dedup = new InboundDedup(join(opts.dataDir, 'inbound-ids.json'));
    this.client = new WsClient({
      url: opts.wsUrl,
      credential: opts.credential,
      logger: this.log,
      backoff: opts.backoff,
      hello: () => ({
        agentVersion: AGENT_VERSION,
        capabilities: this.executor ? ['auto', 'manual', 'devcontainer'] : [],
        localPaused: this.pause.isPaused(),
        maxConcurrent: this.executor?.maxConcurrent ?? 1,
        running: this.executor?.running() ?? [],
        ...this.tokenFlag(),
        ...(this.updater ? { selfUpdate: true } : {}),
      }),
    });
    this.outbox.setSender((m) => this.client.ready && this.client.send(m));
    this.tokens = new TokenBroker(
      (m) => this.client.ready && this.client.send(m),
      opts.tokenTimeoutMs,
    );
    this.executor = opts.exec
      ? new ManualExecutor(opts.exec.config, {
          ...opts.exec.deps,
          requestToken: (id, purpose) => this.tokens.request(id, purpose),
          enqueue: (type, payload) => this.outbox.enqueue(type, payload as never).id,
          isPaused: () => this.pause.isPaused(),
          participations: () => this.participations,
          refreshConfig: () => this.refreshConfig(),
          sendLiveLog: (payload) =>
            this.liveLogs && this.client.sendBestEffort(agentMessage('task.log', payload)),
          knownSecrets: () => [opts.credential],
          logger: this.log,
        })
      : undefined;
    this.updater = opts.update
      ? new Updater({
          ...opts.update,
          currentVersion: opts.update.currentVersion ?? AGENT_VERSION,
          dataDir: opts.dataDir,
          runningTasks: () => this.executor?.running().length ?? 0,
          report: (p) => this.outbox.enqueue('update.status', p),
          logger: this.log,
        })
      : undefined;
    this.usage = new UsageLoop({
      source: opts.usageSource,
      intervalMs: opts.usageIntervalSec * 1000,
      firstDelayMs: opts.usageFirstDelayMs,
      logger: this.log,
      onReport: (payload) => {
        this.outbox.enqueue(
          'usage.report',
          { ...payload, ...this.tokenFlag() },
          { replaceSameType: true },
        );
        this.lastUsageReportAt = new Date().toISOString();
      },
    });

    this.client.on('welcome', (w) => {
      this.agentId = w.agentId;
      this.latestAgentVersion = normalizeVersion(w.latestAgentVersion);
      this.liveLogs = w.liveLogs === true;
      this.log.info('connected', { agentId: w.agentId, paused: w.paused });
      this.applyConfig(w);
      this.startHeartbeat(w.heartbeatSec);
      this.outbox.setOnline(true);
      this.usage.start();
    });
    this.client.on('disconnected', () => {
      clearInterval(this.heartbeatTimer);
      this.outbox.setOnline(false);
    });
    this.client.on('message', (m) => this.onMessage(m));
  }

  isPaused(): boolean {
    return this.pause.isPaused();
  }

  async start(): Promise<void> {
    this.control = await startControlServer(
      this.opts.socketPath,
      {
        status: () => ({ status: this.status(), tasks: this.executor?.views() ?? [] }),
        pause: () => ({ status: this.setPaused(true) }),
        resume: () => ({ status: this.setPaused(false) }),
        list: (r) => this.listTasks(r.project),
        take: async (r) => ({ task: await this.exec().take(r.issue, r.project) }),
        done: async (r) => ({ task: await this.exec().done(r.issue, r.project) }),
        attach: async (r) => ({ exec: await this.exec().attach(r.issue, r.project) }),
        shell: (r) => ({ exec: this.exec().shell(r.issue, r.project) }),
        logs: (r) => ({
          exec: this.exec().logs(r.issue, r.project, r.follow ?? true, r.lines ?? 100),
        }),
        requests: () => ({ requests: this.exec().requestViews() }),
        accept: async (r) => ({ message: (await this.exec().acceptRequest(r.id)).message }),
        reject: (r) => ({ message: this.exec().rejectRequest(r.id).message }),
        update: (r) => this.localUpdate(r.version, r.whenIdle ?? false),
        'claude.check': async (r) => ({
          claudeAuth: await this.checkClaudeAuth(r.reason ?? 'cli'),
        }),
      },
      this.log,
    );
    if (this.executor) {
      await this.executor
        .reconcile()
        .catch((err: unknown) =>
          this.log.warn('task reconciliation failed', { error: errorMessage(err) }),
        );
    }
    this.updater?.resumeAfterRestart();
    this.client.start();
    this.startTokenWatch();
  }

  /**
   * Runs the real Claude check (single-flight per token: a caller arriving while a check of the
   * same token runs joins it; a check of an older token is awaited, then a new one runs),
   * records it in ClaudeAuthState and reports `claude.auth` through the outbox.
   */
  async checkClaudeAuth(reason: string): Promise<ClaudeAuthPayload> {
    const c = this.opts.claudeCheck;
    if (!c) {
      const err = new Error('The Claude check is not available here (task execution disabled).');
      throw Object.assign(err, { code: 'unsupported' });
    }
    const hash = this.safeTokenHash();
    const cur = this.authInflight;
    if (cur) {
      if (cur.hash === hash) return cur.promise;
      await cur.promise.catch(() => undefined);
      return this.checkClaudeAuth(reason);
    }
    const promise: Promise<ClaudeAuthPayload> = (async () => {
      const out = await c.run();
      this.claudeAuth.recordCheck(out.payload, out.tokenHash);
      this.outbox.enqueue('claude.auth', out.payload, { replaceSameType: true });
      const fields = {
        reason,
        valid: out.payload.valid,
        ...(out.payload.errorClass ? { errorClass: out.payload.errorClass } : {}),
        ...(out.payload.detail ? { detail: out.payload.detail } : {}),
      };
      if (out.payload.valid) this.log.info('Claude login check passed', fields);
      else this.log.warn('Claude login check failed', fields);
      return out.payload;
    })().finally(() => {
      if (this.authInflight?.promise === promise) this.authInflight = undefined;
    });
    this.authInflight = { hash, promise };
    return promise;
  }

  private safeTokenHash(): string | null {
    try {
      return this.opts.claudeCheck?.tokenHash() ?? null;
    } catch {
      return null;
    }
  }

  private startTokenWatch(): void {
    const c = this.opts.claudeCheck;
    if (!c) return;
    const begin = () => {
      if (this.stopped) return;
      this.watchToken();
      this.tokenWatchTimer = setInterval(() => this.watchToken(), c.watchMs ?? 30_000);
      this.tokenWatchTimer.unref();
    };
    if (!c.cleanup) return begin();
    // The leftover cleanup removes every check container of this agent: it must settle before
    // the first check creates a fresh one, or it could remove that one too.
    void Promise.resolve()
      .then(() => c.cleanup?.())
      .catch((err: unknown) =>
        this.log.debug('check container cleanup failed', { error: errorMessage(err) }),
      )
      .finally(begin);
  }

  /**
   * Checks the token when its hash differs from the one last checked (cheap: the hash is only
   * computed when mtime / size changed), and retries an inconclusive check after `retryMs`.
   */
  watchToken(): void {
    const c = this.opts.claudeCheck;
    if (!c || this.authInflight) return;
    let stat: string | null;
    try {
      stat = c.tokenStat();
    } catch {
      stat = null;
    }
    const st = this.claudeAuth.read();
    const retryDue =
      st.errorClass !== undefined &&
      INCONCLUSIVE.has(st.errorClass) &&
      st.checkedAt !== undefined &&
      Date.now() - Date.parse(st.checkedAt) >= (c.retryMs ?? 15 * 60_000);
    if (stat === this.lastTokenStat && !retryDue) return;
    this.lastTokenStat = stat;
    const hash = this.safeTokenHash();
    const changed = hash !== (st.tokenHash ?? null);
    if (!changed && !(retryDue && hash !== null)) return;
    void this.checkClaudeAuth(changed ? 'token changed' : 'retry').catch((err: unknown) =>
      this.log.warn('Claude login check crashed', { error: errorMessage(err) }),
    );
  }

  /**
   * `orch update [--version X] [--when-idle]`: same path as `agent.update`, with the version the
   * server announced (or the explicit one) and the configured repository.
   */
  private localUpdate(version: string | undefined, whenIdle: boolean): ControlResult {
    const updater = this.updater;
    if (!updater) {
      const err = new Error(
        'Self-update is not available here (no docker socket or not running in a container).',
      );
      throw Object.assign(err, { code: 'unsupported' });
    }
    const explicit = version !== undefined;
    const target = explicit ? normalizeVersion(version) : this.latestAgentVersion;
    if (!target) {
      const err = new Error(
        explicit
          ? `"${version}" is not a release version (e.g. 0.4.3).`
          : 'The server has not announced a version (not connected yet, or it runs a dev build). Pass --version <x.y.z>.',
      );
      throw Object.assign(err, { code: 'no_target' });
    }
    const cmp = compareVersions(AGENT_VERSION, target);
    if (cmp === 0 || (!explicit && cmp !== null && cmp > 0)) {
      return { message: `Already up to date (v${AGENT_VERSION}).` };
    }
    const state = updater.request({
      updateId: `local-${randomBytes(8).toString('hex')}`,
      targetVersion: target,
      image: `${this.opts.update!.imageRepo}:${target}`,
      whenIdle,
    });
    if (state.status === 'failed') {
      const err = new Error(state.detail ?? 'The update failed.');
      throw Object.assign(err, { code: state.code ?? 'failed' });
    }
    const message =
      state.status === 'deferred'
        ? `Update to v${target} deferred: ${state.detail ?? 'waiting for the running tasks'}`
        : `Updating to v${target}: pulling the image, then the agent restarts.`;
    return { message, update: state };
  }

  private exec(): ManualExecutor {
    if (!this.executor) {
      const err = new Error('Task execution is not configured (set ORCH_WORK_DIR).');
      throw Object.assign(err, { code: 'not_configured' });
    }
    return this.executor;
  }

  /** `orch list`: `tasks.list.request` -> `tasks.list` (replyTo = request id). Online only. */
  private listTasks(project?: string): Promise<ControlResult> {
    const msg = agentMessage('tasks.list.request', project ? { projectFullName: project } : {});
    return new Promise((resolve, reject) => {
      if (!this.client.ready || !this.client.send(msg)) {
        reject(Object.assign(new Error('Not connected to the server.'), { code: 'offline' }));
        return;
      }
      const timer = setTimeout(() => {
        this.listWaiters.delete(msg.id);
        reject(new Error('The server did not answer the task list request.'));
      }, this.opts.listTimeoutMs ?? 15_000);
      this.listWaiters.set(msg.id, {
        timer,
        reject,
        resolve: (p) => resolve({ available: p.tasks }),
      });
    });
  }

  /**
   * `config.request` -> `config.update` (replyTo = request id), applied before this resolves
   * true. Resolves false when offline, on timeout, or when an older server answers `error`.
   */
  refreshConfig(): Promise<boolean> {
    if (this.configWaiter) return this.configWaiter.promise;
    const msg = agentMessage('config.request', { reason: 'participation' });
    if (!this.client.ready || !this.client.send(msg)) return Promise.resolve(false);
    let resolve!: (ok: boolean) => void;
    const promise = new Promise<boolean>((r) => (resolve = r));
    const timer = setTimeout(() => {
      this.log.warn('no answer to config.request; keeping the current config');
      this.settleConfigWaiter(msg.id, false);
    }, this.opts.configRequestTimeoutMs ?? 5_000);
    this.configWaiter = { id: msg.id, promise, resolve, timer };
    return promise;
  }

  private settleConfigWaiter(replyTo: string | undefined, ok: boolean): void {
    const w = this.configWaiter;
    if (!w || replyTo !== w.id) return;
    clearTimeout(w.timer);
    this.configWaiter = undefined;
    w.resolve(ok);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.configWaiter) {
      clearTimeout(this.configWaiter.timer);
      this.configWaiter.resolve(false);
      this.configWaiter = undefined;
    }
    this.tokens.close();
    this.updater?.close();
    if (this.executor) {
      this.executor.close();
      // Let the killed runs report (task.finished) while the outbox is still online. Bounded:
      // main.ts force-exits after 5 s, and what is enqueued by then is on disk anyway.
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        this.executor.idle(),
        new Promise<void>((r) => (timer = setTimeout(r, STOP_DRAIN_MS))),
      ]);
      clearTimeout(timer);
    }
    for (const w of this.listWaiters.values()) clearTimeout(w.timer);
    this.listWaiters.clear();
    this.usage.stop();
    clearInterval(this.tokenWatchTimer);
    clearInterval(this.heartbeatTimer);
    this.outbox.close();
    await this.client.stop();
    await this.control?.close();
  }

  status(): StatusInfo {
    return {
      agentId: this.agentId,
      version: AGENT_VERSION,
      connected: this.client.ready,
      paused: this.pause.isPaused(),
      serverUrl: this.opts.serverUrl,
      lastUsageReportAt: this.lastUsageReportAt,
      outboxPending: this.outbox.pending().length,
      maxConcurrent: this.executor?.maxConcurrent ?? 1,
      latestAgentVersion: this.latestAgentVersion,
      update: this.updater?.current() ?? null,
      claudeAuthValid: this.claudeAuth.isValid(),
    };
  }

  /** `orch pause|resume`: local state first (works offline), then `pause.set` via the outbox. */
  setPaused(paused: boolean): StatusInfo {
    this.pause.set(paused, 'local');
    this.outbox.enqueue('pause.set', { paused });
    this.log.info(paused ? 'paused locally' : 'resumed locally');
    return this.status();
  }

  private applyConfig(c: AgentConfigPayload): void {
    this.participations = c.participations;
    // A pending local pause.set wins until the server acks it (the server value is stale).
    if (!this.outbox.hasPending('pause.set') && this.pause.set(c.paused, 'server')) {
      this.log.info(c.paused ? 'paused from the server' : 'resumed from the server');
    }
    if (!this.opts.usageIntervalExplicit) this.usage.setIntervalMs(c.usageSec * 1000);
  }

  private startHeartbeat(sec: number): void {
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      this.client.send(
        agentMessage('heartbeat', {
          running: this.executor?.running().length ?? 0,
          localPaused: this.pause.isPaused(),
          load: { cpu: loadavg()[0] ?? 0, memFreeMb: Math.round(freemem() / 1048576) },
        }),
      );
    }, sec * 1000);
  }

  private onMessage(m: ServerMessage): void {
    if (m.type === 'ack') {
      if (!m.payload.ok) {
        this.log.warn('server refused a message', { replyTo: m.replyTo, error: m.payload.error });
      }
      this.executor?.onAck(m.replyTo, m.payload);
      this.updater?.checkIdle();
      this.outbox.ack(m.replyTo);
      return;
    }
    if (this.tokens.handle(m)) return;
    if (m.type === 'tasks.list') {
      const w = m.replyTo !== undefined ? this.listWaiters.get(m.replyTo) : undefined;
      if (w && m.replyTo !== undefined) {
        clearTimeout(w.timer);
        this.listWaiters.delete(m.replyTo);
        w.resolve(m.payload);
      }
      return;
    }
    if (m.type === 'offer.request' || m.type === 'offer.withdrawn') {
      // Notifications without ack (approval requests for `orch requests`).
      this.executor?.handle(m);
      return;
    }
    if (m.type === 'error') {
      const replyTo = m.payload.replyTo ?? m.replyTo;
      // A 0.5.1 server does not know `claude.auth`: it answers `error` (invalid_message) and never
      // acks, so the outbox would resend it forever. Drop it; the server just lacks the feature.
      if (
        m.payload.code === 'invalid_message' &&
        replyTo !== undefined &&
        this.outbox.pending().some((e) => e.id === replyTo && e.type === 'claude.auth')
      ) {
        this.outbox.ack(replyTo);
        if (!this.claudeAuthUnsupportedLogged) {
          this.claudeAuthUnsupportedLogged = true;
          this.log.info('server does not support claude.auth (older version); not reporting it');
        }
        return;
      }
      this.log.warn('server error', { code: m.payload.code, message: m.payload.message });
      // An older server does not know `config.request`: give up at once (guard rejects).
      this.settleConfigWaiter(replyTo, false);
      return;
    }
    if (!SERVER_ACKED_TYPES.includes(m.type)) {
      this.log.debug('ignoring message', { type: m.type });
      return;
    }
    if (this.dedup.has(m.id)) {
      this.sendAck(m.id, { ok: true, duplicate: true });
      return;
    }
    let ack: AckPayload = { ok: true };
    try {
      this.apply(m);
    } catch (err) {
      ack = { ok: false, error: { code: 'apply_failed', message: errorMessage(err) } };
    }
    this.dedup.remember(m.id);
    this.sendAck(m.id, ack);
    if (m.type === 'config.update') this.settleConfigWaiter(m.replyTo, ack.ok);
  }

  private apply(m: ServerMessage): void {
    switch (m.type) {
      case 'config.update':
        this.applyConfig(m.payload);
        this.log.info('config updated', {
          participations: m.payload.participations.map((p) => `${p.fullName}:${p.mode}`),
        });
        if (this.client.ready) this.startHeartbeat(m.payload.heartbeatSec);
        return;
      case 'agent.update':
        if (!this.updater) {
          this.outbox.enqueue('update.status', {
            updateId: m.payload.updateId,
            targetVersion: m.payload.targetVersion,
            status: 'failed',
            code: 'unsupported',
            detail: 'Self-update is not available on this machine; update it manually.',
          });
          return;
        }
        this.updater.request(m.payload);
        return;
      case 'task.offer':
        // A deferred update waits for idleness: take no new automatic work meanwhile.
        if (m.payload.kind === 'AUTO_OFFER' && !m.payload.accepted && this.updater?.isDeferred()) {
          this.outbox.enqueue('offer.reject', {
            assignmentId: m.payload.assignmentId,
            reason: 'concurrency',
            detail: 'An agent update is waiting for the running tasks to finish.',
          });
          return;
        }
      // falls through
      case 'task.cancel':
      case 'pr.opened':
      case 'cleanup':
        if (!this.executor) {
          if (m.type === 'task.offer') {
            this.outbox.enqueue('offer.reject', {
              assignmentId: m.payload.assignmentId,
              reason: 'error',
              detail: 'Task execution is not configured on this machine.',
            });
          }
          return;
        }
        this.executor.handle(m);
        return;
      default:
        this.log.debug('message type not handled', { type: m.type });
    }
  }

  private sendAck(replyTo: string, payload: AckPayload): void {
    this.client.send(agentMessage('ack', payload, { replyTo }));
  }
}
