import type { Agent } from '@prisma/client';
import { Prisma } from '@prisma/client';
import type { FastifyBaseLogger } from 'fastify';
import type { WebSocket } from 'ws';
import {
  AGENT_ACKED_TYPES,
  CloseCode,
  parseAgentMessage,
  serverMessage,
  type AckPayload,
  type AgentConfigPayload,
  type AgentMessage,
  type ServerMessage,
  type TaskOfferPayload,
} from '@orch/shared';
import { audit } from '../audit';
import type { Config } from '../config';
import type { PrismaClient } from '../db';
import { participationStatus } from '../projects/service';
import { purgeRetention, recordUsage } from '../usage';

interface Conn {
  agentId: string;
  userId: string;
  socket: WebSocket;
  /** True once the agent sent `hello`. */
  helloed: boolean;
  lastBeat: number;
  /** Frames are processed one at a time, in order. */
  queue: Promise<void>;
}

export type OfferRefusal = 'offline' | 'paused' | 'revoked';

export class OfferRefusedError extends Error {
  constructor(readonly reason: OfferRefusal) {
    super(`Offer refused: agent is ${reason}`);
  }
}

export interface GatewayDeps {
  prisma: PrismaClient;
  config: Config;
  log: FastifyBaseLogger;
}

/**
 * In-memory registry of live agent sockets (one per agent, per app instance) and the
 * server side of the agent protocol.
 *
 * Pause rule: the web route and the agent's `pause.set` both write Agent.paused (last writer
 * wins, `pauseSource` records who). On `hello` the server does not adopt `localPaused`: it sends
 * the DB state in `welcome`, and an agent paused offline replays its `pause.set` from its outbox.
 */
export class AgentGateway {
  private readonly conns = new Map<string, Conn>();
  private sweepTimer: NodeJS.Timeout | undefined;
  private purgeTimer: NodeJS.Timeout | undefined;

  constructor(private readonly deps: GatewayDeps) {}

  start(): void {
    const { config } = this.deps;
    this.sweepTimer = setInterval(() => this.sweep(), config.AGENT_SWEEP_INTERVAL_MS);
    this.sweepTimer.unref();
    this.purgeTimer = setInterval(() => {
      purgeRetention(this.deps.prisma).catch((err) => this.deps.log.warn({ err }, 'purge failed'));
    }, config.RETENTION_PURGE_INTERVAL_MS);
    this.purgeTimer.unref();
  }

  stop(): void {
    clearInterval(this.sweepTimer);
    clearInterval(this.purgeTimer);
    for (const c of this.conns.values()) c.socket.close(CloseCode.NORMAL, 'server shutting down');
    this.conns.clear();
  }

  isConnected(agentId: string): boolean {
    return this.conns.get(agentId)?.helloed === true;
  }

  /** Closes the live socket of an agent, if any. */
  disconnect(agentId: string, code: number, reason: string): void {
    const c = this.conns.get(agentId);
    if (!c) return;
    this.conns.delete(agentId);
    c.socket.close(code, reason);
  }

  /** Registers an authenticated socket. A newer connection supersedes the old one. */
  attach(socket: WebSocket, agent: Agent): void {
    this.disconnect(agent.id, CloseCode.SUPERSEDED, 'superseded');
    const conn: Conn = {
      agentId: agent.id,
      userId: agent.userId,
      socket,
      helloed: false,
      lastBeat: Date.now(),
      queue: Promise.resolve(),
    };
    this.conns.set(agent.id, conn);
    socket.on('message', (data, isBinary) => {
      const raw = isBinary ? '' : data.toString();
      conn.queue = conn.queue
        .then(() => this.onFrame(conn, raw))
        .catch((err) => this.deps.log.error({ err, agentId: conn.agentId }, 'agent frame failed'));
    });
    socket.on('close', () => {
      if (this.conns.get(agent.id) === conn) this.conns.delete(agent.id);
    });
    socket.on('error', (err) => this.deps.log.warn({ err, agentId: agent.id }, 'agent socket'));
  }

  /** Effective config sent in `welcome` and `config.update`. */
  async configFor(agentId: string): Promise<AgentConfigPayload> {
    const { prisma, config } = this.deps;
    const agent = await prisma.agent.findUniqueOrThrow({
      where: { id: agentId },
      include: { user: true },
    });
    const parts = await prisma.participation.findMany({
      where: { userId: agent.userId, active: true, project: { archivedAt: null } },
      include: { project: true },
      orderBy: { createdAt: 'asc' },
    });
    return {
      heartbeatSec: config.AGENT_HEARTBEAT_SEC,
      usageSec: config.AGENT_USAGE_SEC,
      paused: agent.paused || agent.user.paused,
      participations: parts
        .filter((p) => participationStatus(p, p.project.requireParticipantApproval) === 'active')
        .map((p) => ({
          projectId: p.projectId,
          fullName: p.project.fullName,
          percent: p.percent,
          mode: p.mode,
          allowedModels: p.allowedModels,
        })),
    };
  }

  /** Pushes `config.update` to the live socket. Returns false when the agent is offline. */
  async pushConfig(agentId: string): Promise<boolean> {
    const c = this.conns.get(agentId);
    if (!c) return false;
    const payload = await this.configFor(agentId);
    return this.send(c, serverMessage('config.update', payload));
  }

  /**
   * Sends `task.offer`. Throws OfferRefusedError when the agent is offline, paused or revoked:
   * the server never offers work to a paused agent.
   */
  async sendOffer(agentId: string, payload: TaskOfferPayload): Promise<void> {
    const agent = await this.deps.prisma.agent.findUnique({
      where: { id: agentId },
      include: { user: true },
    });
    if (!agent || agent.revokedAt) throw new OfferRefusedError('revoked');
    if (agent.paused || agent.user.paused) throw new OfferRefusedError('paused');
    const c = this.conns.get(agentId);
    if (!c || !c.helloed) throw new OfferRefusedError('offline');
    if (!this.send(c, serverMessage('task.offer', payload))) throw new OfferRefusedError('offline');
  }

  /** Closes sockets whose last hello/heartbeat is older than the timeout. */
  sweep(now: number = Date.now()): void {
    const timeout = this.deps.config.AGENT_HEARTBEAT_TIMEOUT_MS;
    for (const c of [...this.conns.values()]) {
      if (now - c.lastBeat > timeout) {
        this.disconnect(c.agentId, CloseCode.HEARTBEAT_TIMEOUT, 'heartbeat timeout');
      }
    }
  }

  private send(c: Conn, msg: ServerMessage): boolean {
    if (c.socket.readyState !== c.socket.OPEN) return false;
    c.socket.send(JSON.stringify(msg));
    return true;
  }

  private sendError(c: Conn, code: string, message: string, replyTo?: string) {
    this.send(c, serverMessage('error', { code, message, ...(replyTo ? { replyTo } : {}) }));
  }

  private ack(c: Conn, replyTo: string, payload: AckPayload) {
    this.send(c, serverMessage('ack', payload, { replyTo }));
  }

  private async onFrame(c: Conn, raw: string): Promise<void> {
    if (this.conns.get(c.agentId) !== c) return; // superseded or closed
    const r = parseAgentMessage(raw);
    if (!r.ok) {
      this.sendError(c, r.code, r.error, r.id);
      if (r.code === 'version_mismatch') {
        this.disconnect(c.agentId, CloseCode.VERSION_MISMATCH, 'protocol version mismatch');
      } else if (r.code !== 'invalid_message') {
        this.disconnect(c.agentId, CloseCode.PROTOCOL_ERROR, 'protocol error');
      }
      return;
    }
    const m = r.message;
    if (m.type === 'hello') return this.onHello(c, m);
    if (!c.helloed) return this.sendError(c, 'hello_required', 'Send hello first', m.id);
    if (m.type === 'heartbeat') {
      c.lastBeat = Date.now();
      await this.deps.prisma.agent.update({
        where: { id: c.agentId },
        data: { lastSeenAt: new Date() },
      });
      return;
    }
    if (m.type === 'ack') return; // acks of config.update etc.: nothing to retry server-side yet
    if (m.type === 'token.request') {
      this.send(
        c,
        serverMessage(
          'token.deny',
          { requestId: m.payload.requestId, reason: 'not_implemented' },
          { replyTo: m.id },
        ),
      );
      return;
    }
    if (!AGENT_ACKED_TYPES.includes(m.type)) return;

    const { prisma } = this.deps;
    try {
      await prisma.agentMessageSeen.create({ data: { agentId: c.agentId, messageId: m.id } });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        return this.ack(c, m.id, { ok: true, duplicate: true });
      }
      throw err;
    }
    let result: AckPayload;
    try {
      result = await this.process(c, m);
    } catch (err) {
      // Let the agent retry with the same id.
      await prisma.agentMessageSeen.deleteMany({ where: { agentId: c.agentId, messageId: m.id } });
      throw err;
    }
    this.ack(c, m.id, result);
  }

  private async onHello(c: Conn, m: Extract<AgentMessage, { type: 'hello' }>) {
    c.lastBeat = Date.now();
    await this.deps.prisma.agent.update({
      where: { id: c.agentId },
      data: { agentVersion: m.payload.agentVersion, lastSeenAt: new Date() },
    });
    const cfg = await this.configFor(c.agentId);
    c.helloed = true;
    this.send(
      c,
      serverMessage(
        'welcome',
        { ...cfg, agentId: c.agentId, serverTime: new Date().toISOString() },
        { replyTo: m.id },
      ),
    );
  }

  private async process(c: Conn, m: AgentMessage): Promise<AckPayload> {
    const { prisma } = this.deps;
    const refuse = (code: string, message: string): AckPayload => ({
      ok: false,
      error: { code, message },
    });
    switch (m.type) {
      case 'usage.report':
        await recordUsage(prisma, { id: c.agentId, userId: c.userId }, m.payload);
        return { ok: true };
      case 'pause.set': {
        const paused = m.payload.paused;
        await prisma.agent.update({
          where: { id: c.agentId },
          data: { paused, pausedAt: paused ? new Date() : null, pauseSource: 'agent' },
        });
        await audit(prisma, {
          actorType: 'AGENT',
          actorUserId: c.userId,
          actorAgentId: c.agentId,
          agentId: c.agentId,
          action: paused ? 'agent.paused' : 'agent.resumed',
          data: { source: 'agent' },
        });
        return { ok: true };
      }
      case 'offer.accept':
      case 'task.claim': {
        const agent = await prisma.agent.findUniqueOrThrow({
          where: { id: c.agentId },
          include: { user: true },
        });
        if (agent.paused || agent.user.paused) return refuse('paused', 'The agent is paused');
        return refuse('not_implemented', 'Tasks are not available yet');
      }
      default:
        return refuse('not_implemented', `${m.type} is not available yet`);
    }
  }
}
