import type { Agent, User } from '@prisma/client';
import { Prisma } from '@prisma/client';
import type { FastifyBaseLogger } from 'fastify';
import type { WebSocket } from 'ws';
import {
  AGENT_ACKED_TYPES,
  CloseCode,
  normalizeVersion,
  parseAgentMessage,
  serverMessage,
  type AckPayload,
  type AgentConfigPayload,
  type AgentMessage,
  type AgentUpdatePayload,
  type ServerMessage,
  type TaskOfferPayload,
} from '@orch/shared';
import { audit } from '../audit';
import { ConsentError, assertAutoConsent, assertParticipates } from '../dispatch/consent';
import type { Dispatcher } from '../dispatch/dispatcher';
import type { Config } from '../config';
import type { PrismaClient } from '../db';
import type { GithubClient } from '../github';
import { participationStatus } from '../projects/service';
import { TaskService } from '../tasks/service';
import { claudeAuthUpdate, purgeRetention, recordUsage } from '../usage';

interface Conn {
  agentId: string;
  userId: string;
  socket: WebSocket;
  /** True once the agent sent `hello`. */
  helloed: boolean;
  lastBeat: number;
  /** Concurrency announced in `hello` (M4). */
  maxConcurrent: number;
  /** True when `hello` announced `selfUpdate` (understands `agent.update`). */
  selfUpdate: boolean;
  /** Frames are processed one at a time, in order. */
  queue: Promise<void>;
}

/** A duplicate seen this recently without a stored ack is still being processed (no answer). */
const DUPLICATE_IN_FLIGHT_MS = 5 * 60_000;

export type OfferRefusal = 'offline' | 'paused' | 'revoked' | 'no_consent' | 'access_suspended';

export class OfferRefusedError extends Error {
  constructor(readonly reason: OfferRefusal) {
    super(`Offer refused: agent is ${reason}`);
  }
}

export interface GatewayDeps {
  prisma: PrismaClient;
  config: Config;
  log: FastifyBaseLogger;
  github?: GithubClient;
  /**
   * Sign-in allowlist decision for the agent's owner (false when refused, or unknown past the
   * GitHub outage grace period). Checked on every frame (cached by the allowlist), before every
   * offer and every manual claim, so removing someone's access also cuts off their agents.
   */
  isAllowed?: (user: User) => Promise<boolean>;
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

  private readonly tasks: TaskService;
  private dispatcher: Dispatcher | undefined;
  /** Message id of a sent `cleanup` -> assignment id, cleared when the agent acks it. */
  private readonly cleanupAcks = new Map<string, string>();

  constructor(private readonly deps: GatewayDeps) {
    this.tasks = new TaskService({
      prisma: deps.prisma,
      config: deps.config,
      github: deps.github,
    });
  }

  setDispatcher(d: Dispatcher): void {
    this.dispatcher = d;
  }

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

  /** Connected and able to update itself on request (`agent.update`). */
  canSelfUpdate(agentId: string): boolean {
    const c = this.conns.get(agentId);
    return c?.helloed === true && c.selfUpdate;
  }

  /** Sends `agent.update` to one agent. False when it is offline. */
  sendUpdate(agentId: string, payload: AgentUpdatePayload): boolean {
    return this.sendTo(agentId, serverMessage('agent.update', payload));
  }

  /** Users with at least one connected agent. */
  connectedUserIds(): string[] {
    const ids = new Set<string>();
    for (const c of this.conns.values()) if (c.helloed) ids.add(c.userId);
    return [...ids];
  }

  /** Concurrency the agent announced in `hello` (1 when unknown). */
  maxConcurrentOf(agentId: string): number {
    return this.conns.get(agentId)?.maxConcurrent ?? 1;
  }

  /** Sends a message to one connected agent. False when it is offline. */
  sendTo(agentId: string, msg: ServerMessage): boolean {
    const c = this.conns.get(agentId);
    if (!c || !c.helloed) return false;
    return this.send(c, msg);
  }

  /** Sends a message to every connected agent of a user. Returns how many got it. */
  sendToUser(userId: string, msg: ServerMessage): number {
    let n = 0;
    for (const c of this.conns.values()) {
      if (c.userId === userId && c.helloed && this.send(c, msg)) n++;
    }
    return n;
  }

  /** Sends `cleanup` and clears `cleanupPending` once the agent acks it. */
  sendCleanup(agentId: string, assignmentId: string): boolean {
    const msg = serverMessage('cleanup', { assignmentId });
    if (!this.sendTo(agentId, msg)) return false;
    this.cleanupAcks.set(msg.id, assignmentId);
    return true;
  }

  /** Whether the owner may still use orch (always true without an allowlist dependency). */
  async ownerAllowed(user: User): Promise<boolean> {
    return this.deps.isAllowed ? this.deps.isAllowed(user) : true;
  }

  /**
   * Closes the agent with the non-fatal ACCESS_SUSPENDED code: the agent keeps its credential
   * and retries with a long backoff, so approving the owner again brings it back.
   */
  suspend(agentId: string): void {
    const c = this.conns.get(agentId);
    if (!c) return;
    this.sendError(c, 'access_suspended', 'Access to this server was removed by an admin');
    this.disconnect(agentId, CloseCode.ACCESS_SUSPENDED, 'access_suspended');
  }

  /**
   * Re-checks the owner's access now (after an admin denied or removed it) and suspends their
   * connected agents when it is refused, without waiting for their next frame.
   */
  async recheckUser(userId: string): Promise<void> {
    const ids = [...this.conns.values()].filter((c) => c.userId === userId).map((c) => c.agentId);
    if (ids.length === 0) return;
    const user = await this.deps.prisma.user.findUnique({ where: { id: userId } });
    if (user && (await this.ownerAllowed(user))) return;
    for (const id of ids) this.suspend(id);
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
      maxConcurrent: 1,
      selfUpdate: false,
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
   * Pushes `config.update` (fresh participation list) to every connected agent of a user. Called
   * whenever one of the user's participations, or a project setting that affects it, changes.
   * Never throws: a failed push is logged; the agent re-syncs on its next hello or request.
   */
  async pushConfigToUser(userId: string): Promise<number> {
    let n = 0;
    for (const c of [...this.conns.values()]) {
      if (c.userId !== userId || !c.helloed) continue;
      try {
        if (await this.pushConfig(c.agentId)) n++;
      } catch (err) {
        this.deps.log.warn({ err, agentId: c.agentId }, 'config push failed');
      }
    }
    return n;
  }

  /** Same for several users (project-wide changes). */
  async pushConfigToUsers(userIds: Iterable<string>): Promise<void> {
    for (const id of new Set(userIds)) await this.pushConfigToUser(id);
  }

  /**
   * Sends `task.offer`. Throws OfferRefusedError when the agent is offline, paused or revoked:
   * the server never offers work to a paused agent. Second consent check (the dispatcher did the
   * first): an AUTO_OFFER needs an active, approved AUTO-mode participation; an accepted
   * CONSENT_REQUEST needs an active, approved participation.
   */
  async sendOffer(agentId: string, payload: TaskOfferPayload): Promise<void> {
    const agent = await this.deps.prisma.agent.findUnique({
      where: { id: agentId },
      include: { user: true },
    });
    if (!agent || agent.revokedAt) throw new OfferRefusedError('revoked');
    if (agent.paused || agent.user.paused) throw new OfferRefusedError('paused');
    // Consent invariant: no offer (title, repository, prompt) reaches a user who lost access.
    if (!(await this.ownerAllowed(agent.user))) {
      this.suspend(agentId);
      throw new OfferRefusedError('access_suspended');
    }
    const live = this.conns.get(agentId);
    if (!live || !live.helloed) throw new OfferRefusedError('offline');
    if (payload.kind !== 'CLAIM') {
      try {
        if (payload.kind === 'AUTO_OFFER') {
          await assertAutoConsent(this.deps.prisma, agent.userId, payload.task.project.id, agentId);
        } else {
          if (payload.accepted !== true) throw new ConsentError('not_auto');
          await assertParticipates(this.deps.prisma, agent.userId, payload.task.project.id);
        }
      } catch (err) {
        if (err instanceof ConsentError) throw new OfferRefusedError('no_consent');
        throw err;
      }
    }
    const c = this.conns.get(agentId);
    if (!c || !c.helloed) throw new OfferRefusedError('offline');
    if (!this.send(c, serverMessage('task.offer', payload))) throw new OfferRefusedError('offline');
  }

  /**
   * M5 `take_task`: the member claims a task for one of their online, unpaused machines through
   * the same claim path as `orch take` (manual mode), then the server tells that agent to start
   * it with `task.offer` kind CLAIM, `initiatedBy: "server"`. If the offer cannot be delivered the
   * claim is undone (task back to TODO).
   */
  async claimForUser(
    userId: string,
    payload: { projectFullName: string; issueNumber: number },
  ): Promise<
    | { ok: true; assignmentId: string; agentId: string; machineName: string }
    | { ok: false; code: string; message: string }
  > {
    const { prisma } = this.deps;
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: userId },
      include: { agents: true },
    });
    if (!(await this.ownerAllowed(user))) {
      return {
        ok: false,
        code: 'access_suspended',
        message: 'Your access to this server was removed by an admin.',
      };
    }
    const online = user.agents.filter((a) => !a.revokedAt && this.isConnected(a.id));
    if (online.length === 0) {
      return {
        ok: false,
        code: 'no_agent_online',
        message: 'None of your machines is online. Start the orch agent, then try again.',
      };
    }
    const ready = user.paused ? [] : online.filter((a) => !a.paused);
    if (ready.length === 0) {
      return {
        ok: false,
        code: 'paused',
        message: 'Your machines are paused. Resume one (orch resume, or the web) first.',
      };
    }
    let best = ready[0]!;
    let bestLoad = Number.POSITIVE_INFINITY;
    for (const a of ready) {
      const load = await prisma.assignment.count({
        where: { agentId: a.id, status: { in: ['ACCEPTED', 'RUNNING'] } },
      });
      if (load < bestLoad) {
        best = a;
        bestLoad = load;
      }
    }
    const agent = { ...best, user };
    const r = await this.tasks.claim(agent, payload, 'server');
    if (!r.ack.ok || !r.offer) {
      const e = r.ack.ok ? { code: 'claim_failed', message: 'The claim failed' } : r.ack.error;
      return { ok: false, code: e?.code ?? 'claim_failed', message: e?.message ?? 'Claim failed' };
    }
    if (r.withdrawn?.length && this.dispatcher) {
      this.dispatcher.notifyWithdrawn(r.withdrawn, 'taken');
    }
    const offer = r.offer;
    try {
      await this.sendOffer(best.id, offer);
    } catch (err) {
      if (!(err instanceof OfferRefusedError)) throw err;
      await prisma.$transaction([
        prisma.assignment.updateMany({
          where: { id: offer.assignmentId, status: 'ACCEPTED' },
          data: { status: 'CANCELLED', reason: `undeliverable:${err.reason}` },
        }),
        prisma.task.updateMany({
          where: { id: offer.task.taskId, status: 'IN_PROGRESS', assigneeAgentId: best.id },
          data: { status: 'TODO', assigneeId: null, assigneeAgentId: null },
        }),
      ]);
      await audit(prisma, {
        actorUserId: userId,
        agentId: best.id,
        action: 'task.claim_undone',
        projectId: offer.task.project.id,
        taskId: offer.task.taskId,
        data: { assignmentId: offer.assignmentId, reason: err.reason, via: 'mcp' },
      });
      this.dispatcher?.kick();
      return {
        ok: false,
        code:
          err.reason === 'paused' || err.reason === 'access_suspended'
            ? err.reason
            : 'no_agent_online',
        message: `Your machine could not be reached (${err.reason}); the task is open again.`,
      };
    }
    return { ok: true, assignmentId: offer.assignmentId, agentId: best.id, machineName: best.name };
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
    if (m.type !== 'ack' && this.deps.isAllowed) {
      // GitHub outages are handled by the allowlist (last known decision for a grace period,
      // then deny); any other failure throws and the frame is not processed (fail closed).
      const owner = await this.deps.prisma.user.findUnique({ where: { id: c.userId } });
      if (!owner || !(await this.deps.isAllowed(owner))) {
        this.suspend(c.agentId);
        return;
      }
    }
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
    if (m.type === 'ack') {
      const assignmentId = this.cleanupAcks.get(m.replyTo);
      if (assignmentId !== undefined) {
        this.cleanupAcks.delete(m.replyTo);
        await this.deps.prisma.assignment.updateMany({
          where: { id: assignmentId, agentId: c.agentId },
          data: { cleanupPending: false },
        });
      }
      return;
    }
    if (m.type === 'token.request') return this.onTokenRequest(c, m);
    if (m.type === 'config.request') {
      const cfg = await this.configFor(c.agentId);
      this.send(c, serverMessage('config.update', cfg, { replyTo: m.id }));
      return;
    }
    if (m.type === 'tasks.list.request') {
      const agent = await this.loadAgent(c);
      const list = await this.tasks.takeable(agent, m.payload.projectFullName);
      this.send(c, serverMessage('tasks.list', list, { replyTo: m.id }));
      return;
    }
    if (!AGENT_ACKED_TYPES.includes(m.type)) return;

    const { prisma } = this.deps;
    try {
      await prisma.agentMessageSeen.create({ data: { agentId: c.agentId, messageId: m.id } });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        return this.ackDuplicate(c, m.id);
      }
      throw err;
    }
    let result: AckPayload;
    const after: Array<() => void> = [];
    try {
      result = await this.process(c, m, after);
    } catch (err) {
      // Let the agent retry with the same id.
      await prisma.agentMessageSeen.deleteMany({ where: { agentId: c.agentId, messageId: m.id } });
      throw err;
    }
    // Kept so a resend (reply lost on reconnect) gets the same answer, never a blind ok.
    await prisma.agentMessageSeen.updateMany({
      where: { agentId: c.agentId, messageId: m.id },
      data: { ack: result as Prisma.InputJsonValue },
    });
    this.ack(c, m.id, result);
    for (const f of after) f();
  }

  /**
   * Replays the first answer. Still being processed: no ack, the agent outbox resends later.
   * A row without a stored ack long after it was seen (written before acks were stored, or the
   * process died mid-way) keeps the old plain duplicate answer.
   */
  private async ackDuplicate(c: Conn, messageId: string): Promise<void> {
    const seen = await this.deps.prisma.agentMessageSeen.findUnique({
      where: { agentId_messageId: { agentId: c.agentId, messageId } },
    });
    if (seen?.ack) {
      this.ack(c, messageId, { ...(seen.ack as AckPayload), duplicate: true });
      return;
    }
    if (seen && Date.now() - seen.seenAt.getTime() < DUPLICATE_IN_FLIGHT_MS) return;
    this.ack(c, messageId, { ok: true, duplicate: true });
  }

  private loadAgent(c: Conn) {
    return this.deps.prisma.agent.findUniqueOrThrow({
      where: { id: c.agentId },
      include: { user: true },
    });
  }

  private async onTokenRequest(c: Conn, m: Extract<AgentMessage, { type: 'token.request' }>) {
    const agent = await this.loadAgent(c);
    const r = await this.tasks.mintToken(agent, m.payload);
    const reply = r.ok
      ? serverMessage(
          'token.grant',
          {
            requestId: m.payload.requestId,
            token: r.token,
            expiresAt: r.expiresAt.toISOString(),
            repository: r.repository,
            permissions: r.permissions,
          },
          { replyTo: m.id },
        )
      : serverMessage(
          'token.deny',
          { requestId: m.payload.requestId, reason: r.reason },
          { replyTo: m.id },
        );
    this.send(c, reply);
  }

  private async onHello(c: Conn, m: Extract<AgentMessage, { type: 'hello' }>) {
    c.lastBeat = Date.now();
    const prev = await this.deps.prisma.agent.findUnique({ where: { id: c.agentId } });
    // The agent came back running the version it was asked to update to: the update is done.
    const updated =
      !!prev?.updateTargetVersion &&
      !!prev.updateStatus &&
      prev.updateStatus !== 'done' &&
      normalizeVersion(m.payload.agentVersion) === prev.updateTargetVersion;
    await this.deps.prisma.agent.update({
      where: { id: c.agentId },
      data: {
        agentVersion: m.payload.agentVersion,
        ...(updated && {
          updateStatus: 'done',
          updateUpdatedAt: new Date(),
          updateCode: null,
          updateDetail: null,
        }),
        lastSeenAt: new Date(),
        ...(m.payload.claudeTokenPresent !== undefined && {
          claudeTokenPresent: m.payload.claudeTokenPresent,
        }),
        // A reported false sets the flag; a reported true never clears it (only `claude.auth`
        // with a real check, or a succeeded run, does).
        ...claudeAuthUpdate(prev, m.payload.claudeAuthValid),
      },
    });
    if (updated) {
      await audit(this.deps.prisma, {
        actorType: 'AGENT',
        actorUserId: c.userId,
        actorAgentId: c.agentId,
        agentId: c.agentId,
        action: 'agent.update_done',
        data: { targetVersion: prev.updateTargetVersion! },
      });
    }
    const cfg = await this.configFor(c.agentId);
    c.helloed = true;
    c.maxConcurrent = m.payload.maxConcurrent;
    c.selfUpdate = m.payload.selfUpdate === true;
    const latest = normalizeVersion(this.deps.config.ORCH_VERSION);
    this.send(
      c,
      serverMessage(
        'welcome',
        {
          ...cfg,
          agentId: c.agentId,
          serverTime: new Date().toISOString(),
          ...(latest && { latestAgentVersion: latest }),
        },
        { replyTo: m.id },
      ),
    );
    await this.dispatcher?.onAgentHello(c.agentId, m.payload.running);
  }

  private async process(c: Conn, m: AgentMessage, after: Array<() => void>): Promise<AckPayload> {
    const { prisma } = this.deps;
    const refuse = (code: string, message: string): AckPayload => ({
      ok: false,
      error: { code, message },
    });
    switch (m.type) {
      case 'usage.report':
        await recordUsage(prisma, { id: c.agentId, userId: c.userId }, m.payload);
        return { ok: true };
      case 'claude.auth': {
        const p = m.payload;
        const prev = await prisma.agent.findUnique({
          where: { id: c.agentId },
          select: { claudeAuthValid: true, claudeAuthInvalidAt: true },
        });
        const checkedAt = new Date(p.checkedAt);
        const definitive =
          !p.valid && (p.errorClass === 'unauthorized' || p.errorClass === 'no_token');
        const wasValid = prev?.claudeAuthValid ?? true;
        if (p.valid) {
          await prisma.agent.update({
            where: { id: c.agentId },
            data: {
              claudeAuthValid: true,
              claudeAuthInvalidAt: null,
              claudeAuthCheckedAt: checkedAt,
              claudeAuthError: null,
            },
          });
          if (!wasValid) {
            const d = this.dispatcher;
            if (d) after.push(() => d.kick());
          }
        } else if (definitive) {
          await prisma.agent.update({
            where: { id: c.agentId },
            data: {
              claudeAuthValid: false,
              ...(wasValid && { claudeAuthInvalidAt: new Date() }),
              claudeAuthCheckedAt: checkedAt,
              claudeAuthError: p.errorClass,
            },
          });
        } else {
          // Inconclusive (rate limit, timeout, network, check error): the flag stays as it is.
          await prisma.agent.update({
            where: { id: c.agentId },
            data: { claudeAuthCheckedAt: checkedAt, claudeAuthError: p.errorClass ?? 'error' },
          });
        }
        const flag = p.valid ? true : definitive ? false : wasValid;
        if (flag !== wasValid) {
          this.deps.log.info(
            { agentId: c.agentId, claudeAuthValid: flag, errorClass: p.errorClass ?? null },
            'claude auth check changed the agent login state',
          );
        }
        return { ok: true };
      }
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
        const d = this.dispatcher;
        if (d) after.push(() => void d.onAgentPauseChanged(c.agentId, paused));
        return { ok: true };
      }
      case 'task.claim': {
        const agent = await this.loadAgent(c);
        const r = await this.tasks.claim(agent, m.payload);
        const { offer, withdrawn } = r;
        if (offer) {
          after.push(() => this.send(c, serverMessage('task.offer', offer, { replyTo: m.id })));
        }
        if (withdrawn?.length && this.dispatcher) {
          const d = this.dispatcher;
          after.push(() => d.notifyWithdrawn(withdrawn, 'taken'));
        }
        return r.ack;
      }
      case 'task.status':
        return this.tasks.onStatus(await this.loadAgent(c), m.payload);
      case 'task.pushed': {
        const r = await this.tasks.onPushed(await this.loadAgent(c), m.payload);
        const pr = r.prOpened;
        if (pr) after.push(() => this.send(c, serverMessage('pr.opened', pr)));
        return r.ack;
      }
      case 'task.finished': {
        const r = await this.tasks.onFinished(await this.loadAgent(c), m.payload);
        const d = this.dispatcher;
        if (d) after.push(() => d.kick());
        return r;
      }
      case 'done.request':
        return this.tasks.onDoneRequest(await this.loadAgent(c), m.payload.assignmentId);
      case 'offer.accept': {
        const agent = await this.loadAgent(c);
        if (agent.paused || agent.user.paused) return refuse('paused', 'The agent is paused');
        if (!this.dispatcher) return refuse('not_implemented', 'Offers are not available');
        const r = await this.dispatcher.accept(m.payload.assignmentId, {
          userId: c.userId,
          agentId: c.agentId,
          via: 'agent',
        });
        if (!r.ok) {
          if (r.code === 'offer_closed') {
            // PLAN 4.5: a second accept for the same task is answered with a cancel.
            const id = m.payload.assignmentId;
            after.push(() =>
              this.send(c, serverMessage('task.cancel', { assignmentId: id, reason: 'taken' })),
            );
          }
          return refuse(r.code, r.message);
        }
        return { ok: true };
      }
      case 'offer.reject': {
        if (!this.dispatcher) return refuse('not_implemented', 'Offers are not available');
        const r = await this.dispatcher.reject(
          m.payload.assignmentId,
          { userId: c.userId, agentId: c.agentId, via: 'agent' },
          m.payload.reason,
          m.payload.detail,
        );
        return r.ok ? { ok: true } : refuse(r.code, r.message);
      }
      case 'update.status': {
        const p = m.payload;
        const agent = await prisma.agent.findUniqueOrThrow({ where: { id: c.agentId } });
        const local = p.updateId.startsWith('local-');
        // Stale ids are acked and ignored. Only progress is stored: never the image or anything else.
        if (p.updateId !== agent.updateId && !local) return { ok: true };
        // Already done for this update and version (set by `hello` when the agent reconnected on
        // the target version): the queued `done` is a replay, not a second completion (#31).
        if (
          p.status === 'done' &&
          agent.updateStatus === 'done' &&
          p.updateId === agent.updateId &&
          normalizeVersion(p.targetVersion) === normalizeVersion(agent.updateTargetVersion)
        ) {
          return { ok: true };
        }
        const now = new Date();
        const fresh = p.updateId !== agent.updateId;
        await prisma.agent.update({
          where: { id: c.agentId },
          data: {
            updateId: p.updateId,
            updateTargetVersion: p.targetVersion,
            ...(fresh && { updateRequestedAt: now }),
            updateStatus: p.status,
            updateCode: p.code ?? null,
            updateDetail: p.detail ?? null,
            updateUpdatedAt: now,
          },
        });
        if (p.status === 'failed' || p.status === 'done') {
          await audit(prisma, {
            actorType: 'AGENT',
            actorUserId: c.userId,
            actorAgentId: c.agentId,
            agentId: c.agentId,
            action: p.status === 'failed' ? 'agent.update_failed' : 'agent.update_done',
            data: {
              targetVersion: p.targetVersion,
              ...(p.code && { code: p.code }),
            },
          });
        }
        return { ok: true };
      }
      default:
        return refuse('not_implemented', `${m.type} is not available yet`);
    }
  }
}
