/**
 * The dispatcher (PLAN section 6): an in-process scheduler whose state lives in Postgres.
 *
 * Every tick (and every kick after an event) it
 *   1. expires PENDING offers and requests whose `expiresAt` passed,
 *   2. declares LOST the accepted runs whose lease lapsed (S/M/L timeout, or agent gone),
 *   3. offers every open TODO task (dependencies DONE) to the best eligible member.
 *
 * Safe across restarts and instances: nothing is kept in memory but the live sockets. Offers are
 * created inside a transaction that locks the task row with `FOR UPDATE SKIP LOCKED`, the partial
 * unique indexes `one_live_assignment` and `one_pending_auto_offer` arbitrate races, and expiry is
 * computed from the stored `expiresAt` / `leaseExpiresAt`.
 *
 * Consent: an AUTO_OFFER is created only after `assertAutoConsent` inside the same transaction,
 * and the gateway checks it again before sending. Approval-mode members only ever receive
 * CONSENT_REQUESTs; their task starts after they accept.
 */
import { Prisma, type Assignment, type TaskSize, type Model } from '@prisma/client';
import type { FastifyBaseLogger } from 'fastify';
import { serverMessage, type OfferRequestPayload, type TaskOfferPayload } from '@orch/shared';
import type { AgentGateway } from '../agents/gateway';
import { OfferRefusedError } from '../agents/gateway';
import { audit } from '../audit';
import type { Config } from '../config';
import type { PrismaClient } from '../db';
import { participationStatus } from '../projects/service';
import { buildPrompt } from '../tasks/service';
import { branchNameFor } from '../tasks/meta';
import {
  EXEC_TIMEOUT_MIN,
  compareCandidates,
  computeMargin,
  median,
  taskEstimate,
  usageState,
  windowStartOf,
  type Margin,
  type UsageSnapshot,
} from './budget';
import { ConsentError, assertAutoConsent, assertParticipates } from './consent';

export interface DispatcherDeps {
  prisma: PrismaClient;
  config: Config;
  gateway: AgentGateway;
  log: FastifyBaseLogger;
}

const HOLDS_SLOT = ['ACCEPTED', 'RUNNING'] as const;
const LIVE = ['ACCEPTED', 'RUNNING', 'PUSHED'] as const;
/** A member who rejected, let expire, failed or lost a task is not asked again for 24 h. */
const SHUT_OUT = ['REJECTED', 'EXPIRED', 'FAILED', 'LOST'] as const;
const SHUT_OUT_MS = 24 * 3600_000;

const dispatchTaskInclude = {
  project: true,
  createdBy: true,
  targets: true,
} satisfies Prisma.TaskInclude;
type DispatchTask = Prisma.TaskGetPayload<{ include: typeof dispatchTaskInclude }>;

export interface Candidate {
  userId: string;
  login: string;
  agentId: string;
  mode: 'AUTO' | 'APPROVAL';
  estimate: number;
  margin: Margin | null;
  marginFraction: number | null;
  running: number;
  resetAt: Date | null;
  lastAssignedAt: Date | null;
}

export type ActResult =
  { ok: true; assignment: Assignment } | { ok: false; code: string; message: string };

export interface Actor {
  userId: string;
  /** Set when the agent answered; absent for the web. */
  agentId?: string;
  via: 'agent' | 'web';
}

class Refusal extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const refusal = (code: string, message: string): ActResult => ({ ok: false, code, message });

export function toSnapshot(r: {
  reportedAt: Date;
  windowStart: Date | null;
  windowResetAt: Date | null;
  weightedTokens: bigint;
  capacityEstimate: bigint | null;
  byProject: Prisma.JsonValue;
  rateLimitedUntil: Date | null;
}): UsageSnapshot {
  const byProject: Record<string, number> = {};
  if (r.byProject && typeof r.byProject === 'object' && !Array.isArray(r.byProject)) {
    for (const [k, v] of Object.entries(r.byProject)) if (typeof v === 'number') byProject[k] = v;
  }
  return {
    reportedAt: r.reportedAt,
    windowStart: r.windowStart,
    windowResetAt: r.windowResetAt,
    weighted: Number(r.weightedTokens),
    capacity: r.capacityEstimate === null ? null : Number(r.capacityEstimate),
    byProject,
    rateLimitedUntil: r.rateLimitedUntil,
  };
}

export class Dispatcher {
  private timer: NodeJS.Timeout | undefined;
  private chain: Promise<unknown> = Promise.resolve();
  private kicked = false;
  private stopped = false;

  constructor(private readonly deps: DispatcherDeps) {}

  private get prisma() {
    return this.deps.prisma;
  }
  private get gateway() {
    return this.deps.gateway;
  }

  start(): void {
    if (!this.deps.config.DISPATCHER_ENABLED) return;
    this.timer = setInterval(() => this.kick(), this.deps.config.DISPATCHER_INTERVAL_MS);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearInterval(this.timer);
    await this.settle();
  }

  /** Schedules a tick soon. Several kicks before it runs collapse into one. */
  kick(): void {
    if (!this.deps.config.DISPATCHER_ENABLED || this.stopped || this.kicked) return;
    this.kicked = true;
    this.enqueue(async () => {
      this.kicked = false;
      await this.runTick(new Date());
    });
  }

  /** Waits until queued ticks are done. */
  async settle(): Promise<void> {
    let last: Promise<unknown>;
    do {
      last = this.chain;
      await last;
    } while (last !== this.chain);
  }

  /** Runs one tick now (serialized with the others). `now` lets tests move the clock. */
  tick(now: Date = new Date()): Promise<void> {
    return this.enqueue(() => this.runTick(now));
  }

  private enqueue(fn: () => Promise<void>): Promise<void> {
    const p = this.chain.then(fn).catch((err) => {
      if (!this.stopped) this.deps.log.error({ err }, 'dispatcher tick failed');
    });
    this.chain = p;
    return p;
  }

  private async runTick(now: Date): Promise<void> {
    if (this.stopped) return;
    await this.expireOffers(now);
    await this.expireLeases(now);
    await this.dispatchOpenTasks(now);
  }

  // ---------- estimates ----------

  private medianCache = new Map<string, number | null>();

  private async estimateFor(
    t: { projectId: string; size: TaskSize; model: Model },
    sizeBudgets: unknown,
  ): Promise<number> {
    const key = `${t.projectId}:${t.size}:${t.model}`;
    let med = this.medianCache.get(key);
    if (med === undefined) {
      const samples = await this.prisma.assignment.findMany({
        where: {
          status: 'SUCCEEDED',
          usageWeighted: { gt: 0 },
          task: { projectId: t.projectId, size: t.size, model: t.model },
        },
        select: { usageWeighted: true },
        orderBy: { finishedAt: 'desc' },
        take: 50,
      });
      med = samples.length >= 5 ? median(samples.map((s) => Number(s.usageWeighted))) : null;
      this.medianCache.set(key, med);
    }
    return taskEstimate(t.size, t.model, {
      proWindow: this.deps.config.PRO_WINDOW_WEIGHTED,
      opusFactor: this.deps.config.OPUS_FACTOR,
      sizeBudgets,
      median: med,
    });
  }

  async latestUsage(userId: string): Promise<UsageSnapshot | null> {
    const r = await this.prisma.usageReport.findFirst({
      where: { userId },
      orderBy: { reportedAt: 'desc' },
    });
    return r ? toSnapshot(r) : null;
  }

  /**
   * Margin of a member on a project (ESTIMATE). Null when the capacity is unknown. Excludes
   * `excludeTaskId` from the reservations (the task being placed).
   */
  async marginOf(
    userId: string,
    projectId: string,
    percent: number,
    usage: UsageSnapshot,
    now: Date,
    excludeTaskId?: string,
  ): Promise<Margin | null> {
    const held = await this.prisma.assignment.findMany({
      where: {
        userId,
        ...(excludeTaskId ? { taskId: { not: excludeTaskId } } : {}),
        OR: [
          { status: { in: [...HOLDS_SLOT] } },
          { status: 'PENDING', kind: 'AUTO_OFFER', expiresAt: { gt: now } },
        ],
      },
      include: { task: { include: { project: true } } },
    });
    let reservedProject = 0;
    let reservedAll = 0;
    for (const a of held) {
      const e = await this.estimateFor(a.task, a.task.project.sizeBudgets);
      reservedAll += e;
      if (a.task.projectId === projectId) reservedProject += e;
    }
    const finished = await this.prisma.assignment.aggregate({
      where: {
        userId,
        task: { projectId },
        finishedAt: { gte: windowStartOf(usage, now) },
      },
      _sum: { usageWeighted: true },
    });
    return computeMargin({
      usage,
      now,
      projectId,
      percent,
      reserve: this.deps.config.BUDGET_SAFETY_RESERVE,
      orchUsedInWindow: Number(finished._sum.usageWeighted ?? 0),
      reservedProject,
      reservedAll,
    });
  }

  // ---------- eligibility ----------

  /** Slots used per agent and per user: accepted/running runs plus live auto offers. */
  private async slotCounts(userId: string, now: Date) {
    const rows = await this.prisma.assignment.findMany({
      where: {
        userId,
        OR: [
          { status: { in: [...HOLDS_SLOT] } },
          { status: 'PENDING', kind: 'AUTO_OFFER', expiresAt: { gt: now } },
        ],
      },
      select: { agentId: true },
    });
    const perAgent = new Map<string, number>();
    for (const r of rows)
      if (r.agentId) perAgent.set(r.agentId, (perAgent.get(r.agentId) ?? 0) + 1);
    return { total: rows.length, perAgent };
  }

  /** The member's agent that can take one more task now, or null. */
  private async freeAgent(
    user: {
      id: string;
      maxConcurrent: number;
      agents: Array<{ id: string; revokedAt: Date | null; paused: boolean }>;
    },
    now: Date,
  ): Promise<{ agentId: string; running: number } | null> {
    const counts = await this.slotCounts(user.id, now);
    if (counts.total >= user.maxConcurrent) return null;
    let best: { agentId: string; running: number } | null = null;
    for (const a of user.agents) {
      if (a.revokedAt || a.paused || !this.gateway.isConnected(a.id)) continue;
      const used = counts.perAgent.get(a.id) ?? 0;
      if (used >= this.gateway.maxConcurrentOf(a.id)) continue;
      if (!best || used < best.running) best = { agentId: a.id, running: used };
    }
    return best ? { agentId: best.agentId, running: counts.total } : null;
  }

  /** Eligible members for a task, best first (PLAN section 6). */
  async candidatesFor(task: DispatchTask, now: Date): Promise<Candidate[]> {
    const { prisma } = this;
    const staleMs = this.deps.config.USAGE_STALE_SEC * 1000;
    const parts = await prisma.participation.findMany({
      where: { projectId: task.projectId, active: true },
      include: { user: { include: { agents: true } } },
    });
    const targets = new Set(task.targets.map((t) => t.userId));
    const previous = await prisma.assignment.findMany({
      where: {
        taskId: task.id,
        OR: [
          { status: 'PENDING' },
          {
            status: { in: [...SHUT_OUT] },
            updatedAt: { gt: new Date(now.getTime() - SHUT_OUT_MS) },
          },
        ],
      },
      select: { userId: true },
    });
    const excluded = new Set(previous.map((p) => p.userId));
    const estimate = await this.estimateFor(task, task.project.sizeBudgets);
    const out: Candidate[] = [];
    for (const p of parts) {
      if (participationStatus(p, task.project.requireParticipantApproval) !== 'active') continue;
      if (task.dispatchMode === 'MEMBERS' && !targets.has(p.userId)) continue;
      if (p.user.paused) continue;
      if (!p.allowedModels.includes(task.model)) continue;
      if (excluded.has(p.userId)) continue;
      const agent = await this.freeAgent(p.user, now);
      if (!agent) continue;
      const usage = await this.latestUsage(p.userId);
      const state = usageState(usage, now, staleMs);
      let margin: Margin | null = null;
      if (usage && state === 'fresh') {
        if (usage.rateLimitedUntil && usage.rateLimitedUntil.getTime() > now.getTime()) continue;
        margin = await this.marginOf(p.userId, task.projectId, p.percent, usage, now, task.id);
        if (margin && (margin.margin < estimate || margin.globalMargin < estimate)) continue;
      }
      // Auto mode needs a fresh report with a known capacity: no blind starts.
      if (p.mode === 'AUTO' && margin === null) continue;
      const last = await prisma.assignment.findFirst({
        where: {
          userId: p.userId,
          respondedAt: { not: null },
          status: { notIn: ['PENDING', 'REJECTED', 'EXPIRED', 'CANCELLED'] },
        },
        orderBy: { respondedAt: 'desc' },
        select: { respondedAt: true },
      });
      out.push({
        userId: p.userId,
        login: p.user.login,
        agentId: agent.agentId,
        mode: p.mode,
        estimate,
        margin,
        marginFraction: margin && margin.budget > 0 ? margin.margin / margin.budget : null,
        running: agent.running,
        resetAt: usage?.windowResetAt ?? null,
        lastAssignedAt: last?.respondedAt ?? null,
      });
    }
    return out.sort(compareCandidates);
  }

  // ---------- dispatch ----------

  private async dispatchOpenTasks(now: Date): Promise<void> {
    this.medianCache.clear();
    // Only members with a connected machine can be candidates: skip the other projects early.
    const online = this.gateway.connectedUserIds();
    if (online.length === 0) return;
    const tasks = await this.prisma.task.findMany({
      where: {
        status: 'TODO',
        project: {
          archivedAt: null,
          installation: { suspendedAt: null },
          participations: { some: { active: true, userId: { in: online } } },
        },
        dependsOn: { every: { dependsOn: { status: 'DONE' } } },
      },
      include: dispatchTaskInclude,
      orderBy: { createdAt: 'asc' },
    });
    for (const task of tasks) {
      if (this.stopped) return;
      try {
        await this.dispatchTask(task, now);
      } catch (err) {
        this.deps.log.error({ err, taskId: task.id }, 'dispatch failed');
      }
    }
  }

  private async dispatchTask(task: DispatchTask, now: Date): Promise<void> {
    const pending = await this.prisma.assignment.findMany({
      where: { taskId: task.id, status: 'PENDING' },
    });
    if (task.dispatchMode !== 'BROADCAST') {
      if (pending.length > 0) return;
      const [best] = await this.candidatesFor(task, now);
      if (best)
        await this.createOffer(
          task,
          best,
          best.mode === 'AUTO' ? 'AUTO_OFFER' : 'CONSENT_REQUEST',
          now,
        );
      return;
    }
    // Broadcast: one auto offer at a time (best auto candidate) plus a request to every
    // eligible approval-mode member, all at once. The first acceptance wins.
    const cands = await this.candidatesFor(task, now);
    if (!pending.some((a) => a.kind === 'AUTO_OFFER')) {
      const bestAuto = cands.find((c) => c.mode === 'AUTO');
      if (bestAuto) await this.createOffer(task, bestAuto, 'AUTO_OFFER', now);
    }
    for (const c of cands) {
      if (c.mode === 'APPROVAL') await this.createOffer(task, c, 'CONSENT_REQUEST', now);
    }
  }

  private ttlMs(kind: 'AUTO_OFFER' | 'CONSENT_REQUEST'): number {
    const c = this.deps.config;
    return (kind === 'AUTO_OFFER' ? c.AUTO_OFFER_TTL_SEC : c.CONSENT_REQUEST_TTL_SEC) * 1000;
  }

  private async createOffer(
    task: DispatchTask,
    c: Candidate,
    kind: 'AUTO_OFFER' | 'CONSENT_REQUEST',
    now: Date,
  ): Promise<void> {
    // Consent by construction: approval-mode members never get an AUTO_OFFER.
    if (kind === 'AUTO_OFFER' && c.mode !== 'AUTO') return;
    const expiresAt = new Date(now.getTime() + this.ttlMs(kind));
    let a: Assignment | null;
    try {
      a = await this.prisma.$transaction(async (tx) => {
        const locked = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT "id" FROM "Task" WHERE "id" = ${task.id} AND "status" = 'TODO'
          FOR UPDATE SKIP LOCKED`;
        if (locked.length === 0) return null;
        const clash = await tx.assignment.count({
          where: {
            taskId: task.id,
            status: 'PENDING',
            ...(task.dispatchMode === 'BROADCAST'
              ? {
                  OR: [
                    { userId: c.userId },
                    ...(kind === 'AUTO_OFFER' ? [{ kind: 'AUTO_OFFER' as const }] : []),
                  ],
                }
              : {}),
          },
        });
        if (clash > 0) return null;
        if (kind === 'AUTO_OFFER') await assertAutoConsent(tx, c.userId, task.projectId, c.agentId);
        else await assertParticipates(tx, c.userId, task.projectId);
        return tx.assignment.create({
          data: {
            taskId: task.id,
            userId: c.userId,
            agentId: kind === 'AUTO_OFFER' ? c.agentId : null,
            kind,
            status: 'PENDING',
            offeredAt: now,
            expiresAt,
          },
        });
      });
    } catch (err) {
      if (err instanceof ConsentError) {
        this.deps.log.warn(
          { taskId: task.id, userId: c.userId, code: err.code },
          'offer skipped: no consent',
        );
        return;
      }
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return;
      throw err;
    }
    if (!a) return;
    await audit(this.prisma, {
      actorType: 'SYSTEM',
      action: kind === 'AUTO_OFFER' ? 'offer.created' : 'offer.requested',
      projectId: task.projectId,
      taskId: task.id,
      targetUserId: c.userId,
      agentId: a.agentId ?? undefined,
      data: {
        assignmentId: a.id,
        kind,
        dispatch: task.dispatchMode,
        expiresAt: expiresAt.toISOString(),
        estimate: true,
        taskEstimate: Math.round(c.estimate),
        margin: c.margin ? Math.round(c.margin.margin) : null,
        marginFraction: c.marginFraction,
      },
    });
    if (kind === 'AUTO_OFFER') {
      try {
        await this.gateway.sendOffer(c.agentId, this.offerPayload(task, a, 'AUTO_OFFER'));
      } catch (err) {
        if (!(err instanceof OfferRefusedError)) throw err;
        await this.closePending([a], 'CANCELLED', `undeliverable:${err.reason}`, now);
      }
    } else {
      this.gateway.sendToUser(
        c.userId,
        serverMessage('offer.request', this.requestPayload(task, a)),
      );
    }
  }

  offerPayload(
    task: DispatchTask,
    a: Assignment,
    kind: 'AUTO_OFFER' | 'CONSENT_REQUEST',
  ): TaskOfferPayload {
    return {
      assignmentId: a.id,
      kind,
      expiresAt: a.status === 'PENDING' && a.expiresAt ? a.expiresAt.toISOString() : null,
      execMode: 'AUTO',
      accepted: a.status !== 'PENDING',
      timeoutSec: EXEC_TIMEOUT_MIN[task.size] * 60,
      task: {
        taskId: task.id,
        project: {
          id: task.project.id,
          fullName: task.project.fullName,
          defaultBranch: task.project.defaultBranch,
        },
        issueNumber: task.githubIssueNumber,
        title: task.title,
        prompt: buildPrompt(task),
        bodyHash: task.bodyHash,
        acceptanceCriteria: task.acceptanceCriteria,
        size: task.size,
        model: task.model,
        baseBranch: task.integrationBranch ?? task.baseBranch,
        branchName: task.branchName ?? branchNameFor(task.githubIssueNumber, task.title),
        createdBy: { login: task.createdBy.login },
        integrationBranch: task.integrationBranch,
      },
    };
  }

  requestPayload(task: DispatchTask, a: Assignment): OfferRequestPayload {
    return {
      assignmentId: a.id,
      expiresAt: a.expiresAt?.toISOString() ?? null,
      task: {
        taskId: task.id,
        project: { id: task.project.id, fullName: task.project.fullName },
        issueNumber: task.githubIssueNumber,
        title: task.title,
        size: task.size,
        model: task.model,
        createdBy: { login: task.createdBy.login },
      },
    };
  }

  private loadTask(id: string) {
    return this.prisma.task.findUniqueOrThrow({ where: { id }, include: dispatchTaskInclude });
  }

  // ---------- closing offers ----------

  /** Tells the agents an offer or request is gone. */
  notifyWithdrawn(list: Assignment[], reason: string): void {
    for (const a of list) {
      if (a.kind === 'AUTO_OFFER' && a.agentId) {
        this.gateway.sendTo(
          a.agentId,
          serverMessage('task.cancel', { assignmentId: a.id, reason }),
        );
      } else if (a.kind === 'CONSENT_REQUEST') {
        this.gateway.sendToUser(
          a.userId,
          serverMessage('offer.withdrawn', { assignmentId: a.id, reason }),
        );
      }
    }
  }

  /** Moves PENDING assignments to a closed status, then audits and notifies. */
  private async closePending(
    list: Assignment[],
    status: 'EXPIRED' | 'CANCELLED',
    reason: string,
    now: Date,
  ): Promise<Assignment[]> {
    const closed: Assignment[] = [];
    for (const a of list) {
      const r = await this.prisma.assignment.updateMany({
        where: { id: a.id, status: 'PENDING' },
        data: { status, reason, respondedAt: now },
      });
      if (r.count !== 1) continue;
      closed.push(a);
      await audit(this.prisma, {
        actorType: 'SYSTEM',
        action: status === 'EXPIRED' ? 'offer.expired' : 'offer.withdrawn',
        taskId: a.taskId,
        targetUserId: a.userId,
        agentId: a.agentId ?? undefined,
        data: { assignmentId: a.id, kind: a.kind, reason },
      });
    }
    this.notifyWithdrawn(closed, status === 'EXPIRED' ? 'expired' : reason);
    return closed;
  }

  private async expireOffers(now: Date): Promise<void> {
    const due = await this.prisma.assignment.findMany({
      where: { status: 'PENDING', expiresAt: { lte: now } },
    });
    if (due.length) await this.closePending(due, 'EXPIRED', 'timeout', now);
  }

  /** Withdraws the pending offers and requests of a task (taken, cancelled, edited...). */
  async withdrawForTask(taskId: string, reason: string, now = new Date()): Promise<void> {
    const list = await this.prisma.assignment.findMany({ where: { taskId, status: 'PENDING' } });
    await this.closePending(list, 'CANCELLED', reason, now);
  }

  /** Pause or resume from the web or `orch pause`: a paused machine keeps no pending offer. */
  async onAgentPauseChanged(agentId: string, paused: boolean): Promise<void> {
    if (!paused) return this.kick();
    const agent = await this.prisma.agent.findUnique({ where: { id: agentId } });
    if (!agent) return;
    const now = new Date();
    const offers = await this.prisma.assignment.findMany({
      where: { agentId, status: 'PENDING', kind: 'AUTO_OFFER' },
    });
    await this.closePending(offers, 'CANCELLED', 'paused', now);
    const available = await this.prisma.agent.count({
      where: { userId: agent.userId, revokedAt: null, paused: false },
    });
    if (available === 0) {
      const requests = await this.prisma.assignment.findMany({
        where: { userId: agent.userId, status: 'PENDING', kind: 'CONSENT_REQUEST' },
      });
      await this.closePending(requests, 'CANCELLED', 'paused', now);
    }
  }

  /** Revoked machine: its pending offers go. */
  async onAgentRevoked(agentId: string): Promise<void> {
    await this.onAgentPauseChanged(agentId, true);
  }

  /**
   * Participation edited (member) or approval decided (owner): withdraw what the member no
   * longer consents to. Leaving AUTO mode withdraws pending auto offers at once.
   */
  async onParticipationChanged(userId: string, projectId: string): Promise<void> {
    const now = new Date();
    const p = await this.prisma.participation.findUnique({
      where: { userId_projectId: { userId, projectId } },
      include: { project: true },
    });
    const active = !!p && participationStatus(p, p.project.requireParticipantApproval) === 'active';
    if (active && p.mode === 'AUTO') return this.kick();
    const where: Prisma.AssignmentWhereInput = {
      userId,
      status: 'PENDING',
      task: { projectId },
      // Still participating in approval mode: only auto offers go; requests stay.
      ...(active ? { kind: 'AUTO_OFFER' } : {}),
    };
    const list = await this.prisma.assignment.findMany({ where });
    await this.closePending(list, 'CANCELLED', active ? 'mode_changed' : 'not_participating', now);
    this.kick();
  }

  // ---------- leases ----------

  private async expireLeases(now: Date): Promise<void> {
    const lapsed = await this.prisma.assignment.findMany({
      where: { status: { in: [...HOLDS_SLOT] }, leaseExpiresAt: { lte: now } },
    });
    for (const a of lapsed) await this.lose(a, 'timeout', now);
    const cutoff = new Date(now.getTime() - this.deps.config.AGENT_LEASE_SEC * 1000);
    const orphaned = await this.prisma.assignment.findMany({
      where: {
        status: { in: [...HOLDS_SLOT] },
        agent: { OR: [{ lastSeenAt: { lt: cutoff } }, { revokedAt: { not: null } }] },
      },
    });
    for (const a of orphaned) {
      if (a.agentId && this.gateway.isConnected(a.agentId)) continue;
      await this.lose(a, 'agent_offline', now);
    }
  }

  /** LOST: the run is abandoned and the task goes back to the pool. */
  private async lose(a: Assignment, reason: string, now: Date): Promise<void> {
    const done = await this.prisma.$transaction(async (tx) => {
      const r = await tx.assignment.updateMany({
        where: { id: a.id, status: { in: [...HOLDS_SLOT] } },
        data: { status: 'LOST', reason, finishedAt: now, cleanupPending: true },
      });
      if (r.count !== 1) return false;
      await tx.task.updateMany({
        where: { id: a.taskId, status: 'IN_PROGRESS', assigneeAgentId: a.agentId },
        data: { status: 'TODO', assigneeId: null, assigneeAgentId: null },
      });
      return true;
    });
    if (!done) return;
    await audit(this.prisma, {
      actorType: 'SYSTEM',
      action: 'task.lost',
      taskId: a.taskId,
      targetUserId: a.userId,
      agentId: a.agentId ?? undefined,
      data: { assignmentId: a.id, reason },
    });
    if (a.agentId) {
      this.gateway.sendTo(a.agentId, serverMessage('task.cancel', { assignmentId: a.id, reason }));
    }
  }

  // ---------- accept / reject ----------

  /** An agent (offer.accept, `orch accept`) or the web accepts an offer or request. */
  async accept(assignmentId: string, by: Actor, now = new Date()): Promise<ActResult> {
    const { prisma } = this;
    const a = await prisma.assignment.findUnique({ where: { id: assignmentId } });
    if (!a || a.userId !== by.userId) return refusal('not_found', 'No such offer');
    // Idempotent: the assignment is already this agent's (CLAIM, accepted request, replay).
    if (
      (HOLDS_SLOT as readonly string[]).includes(a.status) &&
      by.agentId &&
      a.agentId === by.agentId
    ) {
      return { ok: true, assignment: a };
    }
    if (a.kind === 'CLAIM') return refusal('offer_closed', 'The claim is over');
    if (a.status !== 'PENDING') return refusal('offer_closed', 'The offer is no longer open');
    // An auto offer belongs to the agent it was sent to; the web only answers requests.
    if (a.kind === 'AUTO_OFFER' && a.agentId !== (by.agentId ?? null)) {
      return refusal('not_found', 'No such offer');
    }
    let agentId = by.agentId ?? null;
    if (!agentId) {
      const user = await prisma.user.findUniqueOrThrow({
        where: { id: a.userId },
        include: { agents: true },
      });
      if (user.paused) return refusal('paused', 'You are paused');
      const anyAgent = user.agents.some(
        (x) => !x.revokedAt && !x.paused && this.gateway.isConnected(x.id),
      );
      const free = await this.freeAgent(user, now);
      if (!free) {
        return anyAgent
          ? refusal('concurrency', 'Your machines are busy with other tasks')
          : refusal('no_agent_online', 'None of your machines is online and unpaused');
      }
      agentId = free.agentId;
    }
    const chosen = agentId;
    let withdrawn: Assignment[] = [];
    let accepted: Assignment;
    try {
      accepted = await prisma.$transaction(async (tx) => {
        const locked = await tx.$queryRaw<Array<{ status: string }>>`
          SELECT "status"::text AS "status" FROM "Task" WHERE "id" = ${a.taskId} FOR UPDATE`;
        const cur = await tx.assignment.findUniqueOrThrow({ where: { id: a.id } });
        if (
          cur.status !== 'PENDING' ||
          (cur.expiresAt && cur.expiresAt.getTime() <= now.getTime())
        ) {
          throw new Refusal('offer_closed', 'The offer is no longer open');
        }
        if (locked[0]?.status !== 'TODO') throw new Refusal('offer_closed', 'The task was taken');
        const task = await tx.task.findUniqueOrThrow({ where: { id: a.taskId } });
        try {
          if (cur.kind === 'AUTO_OFFER')
            await assertAutoConsent(tx, a.userId, task.projectId, chosen);
          else await assertParticipates(tx, a.userId, task.projectId);
        } catch (err) {
          if (!(err instanceof ConsentError)) throw err;
          throw new Refusal(err.code === 'paused' ? 'paused' : 'not_participating', err.message);
        }
        const agent = await tx.agent.findUniqueOrThrow({
          where: { id: chosen },
          include: { user: true },
        });
        if (agent.userId !== a.userId || agent.revokedAt)
          throw new Refusal('not_found', 'No such agent');
        if (agent.paused || agent.user.paused) throw new Refusal('paused', 'The agent is paused');
        const slots = await tx.assignment.count({
          where: { userId: a.userId, status: { in: [...HOLDS_SLOT] } },
        });
        const agentSlots = await tx.assignment.count({
          where: { agentId: chosen, status: { in: [...HOLDS_SLOT] } },
        });
        if (
          slots >= agent.user.maxConcurrent ||
          agentSlots >= this.gateway.maxConcurrentOf(chosen)
        ) {
          throw new Refusal('concurrency', 'Too many tasks are already running');
        }
        const lease = new Date(
          now.getTime() +
            (EXEC_TIMEOUT_MIN[task.size] * 60 + this.deps.config.EXEC_LEASE_GRACE_SEC) * 1000,
        );
        const updated = await tx.assignment.update({
          where: { id: a.id },
          data: {
            status: 'ACCEPTED',
            agentId: chosen,
            execMode: 'AUTO',
            respondedAt: now,
            leaseExpiresAt: lease,
          },
        });
        await tx.task.update({
          where: { id: a.taskId },
          data: { status: 'IN_PROGRESS', assigneeId: a.userId, assigneeAgentId: chosen },
        });
        withdrawn = await tx.assignment.findMany({
          where: { taskId: a.taskId, status: 'PENDING' },
        });
        if (withdrawn.length) {
          await tx.assignment.updateMany({
            where: { id: { in: withdrawn.map((w) => w.id) } },
            data: { status: 'CANCELLED', reason: 'taken', respondedAt: now },
          });
        }
        return updated;
      });
    } catch (err) {
      if (err instanceof Refusal) {
        if (err.code === 'not_participating' || err.code === 'offer_closed') {
          await this.closePending([a], 'CANCELLED', err.code, now);
        }
        return refusal(err.code, err.message);
      }
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        return refusal('offer_closed', 'The task was taken');
      }
      throw err;
    }
    const task = await this.loadTask(a.taskId);
    await audit(prisma, {
      actorType: by.via === 'agent' ? 'AGENT' : 'USER',
      actorUserId: by.userId,
      actorAgentId: by.agentId,
      agentId: chosen,
      action: 'offer.accepted',
      projectId: task.projectId,
      taskId: task.id,
      data: { assignmentId: a.id, kind: a.kind, via: by.via, withdrawn: withdrawn.length },
    });
    for (const w of withdrawn) {
      await audit(prisma, {
        actorType: 'SYSTEM',
        action: 'offer.withdrawn',
        projectId: task.projectId,
        taskId: task.id,
        targetUserId: w.userId,
        agentId: w.agentId ?? undefined,
        data: { assignmentId: w.id, kind: w.kind, reason: 'taken' },
      });
    }
    this.notifyWithdrawn(withdrawn, 'taken');
    if (a.kind === 'CONSENT_REQUEST') {
      // The member consented: hand the run to the chosen machine (auto execution).
      await this.deliverAccepted(task, accepted);
    }
    return { ok: true, assignment: accepted };
  }

  private async deliverAccepted(task: DispatchTask, a: Assignment): Promise<void> {
    if (!a.agentId) return;
    try {
      await this.gateway.sendOffer(
        a.agentId,
        this.offerPayload(task, a, a.kind === 'AUTO_OFFER' ? 'AUTO_OFFER' : 'CONSENT_REQUEST'),
      );
    } catch (err) {
      if (!(err instanceof OfferRefusedError)) throw err;
      // Offline: re-sent on the next hello. Paused or no consent any more: back to the pool.
      if (err.reason !== 'offline') {
        await this.reject(
          a.id,
          { userId: a.userId, agentId: a.agentId, via: 'agent' },
          'error',
          err.reason,
        );
      }
    }
  }

  /** The member (web, `orch reject`) or the agent's guard declines. */
  async reject(
    assignmentId: string,
    by: Actor,
    reason: string,
    detail?: string,
    now = new Date(),
  ): Promise<ActResult> {
    const { prisma } = this;
    const a = await prisma.assignment.findUnique({
      where: { id: assignmentId },
      include: { task: true },
    });
    if (!a || a.userId !== by.userId) return refusal('not_found', 'No such offer');
    if (a.kind === 'AUTO_OFFER' && by.agentId && a.agentId !== by.agentId) {
      return refusal('not_found', 'No such offer');
    }
    const data = {
      status: 'REJECTED' as const,
      reason: `${reason}${detail ? `: ${detail.slice(0, 500)}` : ''}`.slice(0, 1000),
      respondedAt: now,
    };
    let afterAccept = false;
    if (a.status === 'PENDING') {
      const r = await prisma.assignment.updateMany({
        where: { id: a.id, status: 'PENDING' },
        data,
      });
      if (r.count !== 1) return refusal('offer_closed', 'The offer is no longer open');
    } else if (a.status === 'ACCEPTED' && !a.startedAt && by.agentId && a.agentId === by.agentId) {
      // The machine's guard refused after acceptance (pause, budget...): back to the pool.
      afterAccept = true;
      await prisma
        .$transaction(async (tx) => {
          const r = await tx.assignment.updateMany({
            where: { id: a.id, status: 'ACCEPTED' },
            data,
          });
          if (r.count !== 1) throw new Refusal('offer_closed', 'The offer is no longer open');
          await tx.task.updateMany({
            where: { id: a.taskId, status: 'IN_PROGRESS', assigneeAgentId: a.agentId },
            data: { status: 'TODO', assigneeId: null, assigneeAgentId: null },
          });
        })
        .catch((err) => {
          if (err instanceof Refusal) afterAccept = false;
          else throw err;
        });
      if (!afterAccept) return refusal('offer_closed', 'The offer is no longer open');
    } else {
      return refusal('offer_closed', 'The offer is no longer open');
    }
    await audit(prisma, {
      actorType: by.via === 'agent' ? 'AGENT' : 'USER',
      actorUserId: by.userId,
      actorAgentId: by.agentId,
      agentId: a.agentId ?? undefined,
      action: 'offer.rejected',
      projectId: a.task.projectId,
      taskId: a.taskId,
      data: { assignmentId: a.id, kind: a.kind, reason, via: by.via, afterAccept },
    });
    this.kick();
    return { ok: true, assignment: { ...a, ...data } };
  }

  // ---------- agent (re)connection ----------

  /**
   * PLAN 4.5 reconciliation on `hello`: cancel runs the server no longer considers live, re-send
   * open offers and accepted-but-not-started runs, re-send requests and pending cleanups.
   */
  async onAgentHello(
    agentId: string,
    running: Array<{ assignmentId: string; taskId: string }>,
  ): Promise<void> {
    const { prisma } = this;
    const now = new Date();
    const agent = await prisma.agent.findUnique({ where: { id: agentId } });
    if (!agent) return;
    const known = new Set(running.map((r) => r.assignmentId));
    for (const r of running) {
      const a = await prisma.assignment.findUnique({ where: { id: r.assignmentId } });
      if (!a || a.agentId !== agentId || !(LIVE as readonly string[]).includes(a.status)) {
        this.gateway.sendTo(
          agentId,
          serverMessage('task.cancel', { assignmentId: r.assignmentId, reason: 'not_live' }),
        );
      }
    }
    const resend = await prisma.assignment.findMany({
      where: {
        agentId,
        kind: { in: ['AUTO_OFFER', 'CONSENT_REQUEST'] },
        OR: [
          { status: 'PENDING', expiresAt: { gt: now } },
          { status: 'ACCEPTED', startedAt: null },
        ],
      },
    });
    for (const a of resend) {
      if (known.has(a.id)) continue;
      const task = await this.loadTask(a.taskId);
      try {
        await this.gateway.sendOffer(
          agentId,
          this.offerPayload(task, a, a.kind === 'AUTO_OFFER' ? 'AUTO_OFFER' : 'CONSENT_REQUEST'),
        );
      } catch (err) {
        if (!(err instanceof OfferRefusedError)) throw err;
        if (a.status === 'PENDING')
          await this.closePending([a], 'CANCELLED', `undeliverable:${err.reason}`, now);
      }
    }
    const requests = await prisma.assignment.findMany({
      where: {
        userId: agent.userId,
        kind: 'CONSENT_REQUEST',
        status: 'PENDING',
        expiresAt: { gt: now },
      },
    });
    for (const a of requests) {
      const task = await this.loadTask(a.taskId);
      this.gateway.sendTo(agentId, serverMessage('offer.request', this.requestPayload(task, a)));
    }
    const cleanups = await prisma.assignment.findMany({
      where: { agentId, cleanupPending: true },
      select: { id: true },
    });
    for (const c of cleanups) this.gateway.sendCleanup(agentId, c.id);
    this.kick();
  }
}
