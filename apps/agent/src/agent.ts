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
} from '@orch/shared';
import type { StatusInfo } from './cli/protocol';
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
}

export class Agent {
  readonly pause: PauseState;
  readonly outbox: Outbox;
  readonly dedup: InboundDedup;
  readonly client: WsClient;
  readonly usage: UsageLoop;
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
        capabilities: [],
        localPaused: this.pause.isPaused(),
        maxConcurrent: 1,
        running: [],
      }),
    });
    this.outbox.setSender((m) => this.client.ready && this.client.send(m));
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
        status: () => this.status(),
        pause: () => this.setPaused(true),
        resume: () => this.setPaused(false),
      },
      this.log,
    );
    this.client.start();
  }

  async stop(): Promise<void> {
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
          running: 0,
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
      this.outbox.ack(m.replyTo);
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
      default:
        // task.offer, task.cancel, pr.opened, cleanup: handled from M3.
        this.log.info('message type not handled yet', { type: m.type });
    }
  }

  private sendAck(replyTo: string, payload: AckPayload): void {
    this.client.send(agentMessage('ack', payload, { replyTo }));
  }
}
