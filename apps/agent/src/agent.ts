/**
 * The agent daemon: wires the WS client, outbox, inbound dedupe, pause state, usage loop,
 * heartbeat and control socket. All collaborators are injectable for tests.
 */
import { freemem, loadavg } from 'node:os';
import { join } from 'node:path';
import {
  SERVER_ACKED_TYPES,
  agentMessage,
  type AckPayload,
  type AgentConfigPayload,
  type ServerMessage,
  type TasksListPayload,
} from '@orch/shared';
import type { ControlResult, StatusInfo } from './cli/protocol';
import { ManualExecutor, type ExecutorConfig, type ExecutorDeps } from './exec/executor';
import { TokenBroker } from './exec/tokens';
import { startControlServer, type ControlServer } from './control/server';
import { InboundDedup } from './dedup';
import { errorMessage, type Logger } from './log';
import { Outbox } from './outbox';
import { PauseState } from './pause';
import { UsageLoop, type UsageSource } from './usage-loop';
import { AGENT_VERSION } from './version';
import type { BackoffOptions } from './ws/backoff';
import { WsClient } from './ws/client';

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
  logger: Logger;
  backoff?: Partial<BackoffOptions>;
  outboxRetryMs?: number;
  usageFirstDelayMs?: number;
  /** Manual-mode task execution. Without it, take/done/list answer "not configured". */
  exec?: {
    config: ExecutorConfig;
    deps: Pick<ExecutorDeps, 'git' | 'docker' | 'screen' | 'fs' | 'readClaudeToken'>;
  };
  tokenTimeoutMs?: number;
  listTimeoutMs?: number;
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
  private participations: AgentConfigPayload['participations'] = [];
  private readonly listWaiters = new Map<string, ListWaiter>();
  private control: ControlServer | undefined;
  private heartbeatTimer: NodeJS.Timeout | undefined;
  private agentId: string | null;
  private lastUsageReportAt: string | null = null;
  private readonly log: Logger;

  constructor(private readonly opts: AgentOptions) {
    this.log = opts.logger;
    this.agentId = opts.agentId;
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
        capabilities: this.executor ? ['manual', 'devcontainer'] : [],
        localPaused: this.pause.isPaused(),
        maxConcurrent: this.executor?.maxConcurrent ?? 1,
        running: this.executor?.running() ?? [],
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
          logger: this.log,
        })
      : undefined;
    this.usage = new UsageLoop({
      source: opts.usageSource,
      intervalMs: opts.usageIntervalSec * 1000,
      firstDelayMs: opts.usageFirstDelayMs,
      logger: this.log,
      onReport: (payload) => {
        this.outbox.enqueue('usage.report', payload, { replaceSameType: true });
        this.lastUsageReportAt = new Date().toISOString();
      },
    });

    this.client.on('welcome', (w) => {
      this.agentId = w.agentId;
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
        done: async (r) => ({ task: await this.exec().done(r.issue) }),
        attach: async (r) => ({ exec: await this.exec().attach(r.issue) }),
        shell: (r) => ({ exec: this.exec().shell(r.issue) }),
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
    this.client.start();
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

  async stop(): Promise<void> {
    this.tokens.close();
    this.executor?.close();
    for (const w of this.listWaiters.values()) clearTimeout(w.timer);
    this.listWaiters.clear();
    this.usage.stop();
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
      if (!m.payload.ok && !m.payload.duplicate) {
        this.log.warn('server refused a message', { replyTo: m.replyTo, error: m.payload.error });
      }
      this.executor?.onAck(m.replyTo, m.payload);
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
    if (m.type === 'error') {
      this.log.warn('server error', { code: m.payload.code, message: m.payload.message });
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
  }

  private apply(m: ServerMessage): void {
    switch (m.type) {
      case 'config.update':
        this.applyConfig(m.payload);
        if (this.client.ready) this.startHeartbeat(m.payload.heartbeatSec);
        return;
      case 'task.offer':
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
