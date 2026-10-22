/**
 * What one dispatcher tick reads, loaded with a fixed number of batched queries (about ten,
 * whatever the number of tasks and members) instead of a few queries per task and per member.
 *
 * The decisions are computed in memory from this snapshot. When the tick creates an offer it
 * calls `recordOffer` so that the following tasks of the same tick see the slot and the budget
 * that offer holds, exactly as if they had queried the database again. The writes themselves stay
 * guarded in the database (task row lock, partial unique indexes, consent and slot re-checks in
 * the offer transaction): a stale snapshot can only cause a skipped offer, never a forbidden one.
 */
import { Prisma, type Assignment, type Model, type TaskSize } from '@prisma/client';
import type { PrismaClient } from '../db';
import {
  computeMargin,
  median,
  taskEstimate,
  windowStartOf,
  type Margin,
  type UsageSnapshot,
} from './budget';

/** Assignment statuses that hold one of the member's concurrency slots. */
export const HOLDS_SLOT = ['ACCEPTED', 'RUNNING'] as const;
/**
 * A member who rejected, let expire or lost a task is not asked again for 24 h (except a
 * `not_participating` rejection by the agent's guard or a failed run: see the dispatcher).
 */
export const SHUT_OUT = ['REJECTED', 'EXPIRED', 'FAILED', 'LOST'] as const;
export const SHUT_OUT_MS = 24 * 3600_000;
/** Past successful runs used for the median estimate of a (project, size, model). */
const MEDIAN_SAMPLES = 50;
const MEDIAN_MIN_SAMPLES = 5;

export interface EstimateConfig {
  proWindow: number;
  opusFactor: number;
  /** Extra server reserve (BUDGET_SAFETY_RESERVE). */
  reserve: number;
}

const participantInclude = {
  user: { include: { agents: true } },
} satisfies Prisma.ParticipationInclude;
export type Participant = Prisma.ParticipationGetPayload<{ include: typeof participantInclude }>;

const historySelect = {
  id: true,
  taskId: true,
  userId: true,
  kind: true,
  status: true,
  reason: true,
  failureClass: true,
  respondedAt: true,
  finishedAt: true,
  updatedAt: true,
} satisfies Prisma.AssignmentSelect;
/** A pending or recently closed assignment of a task (offers, rejections, failures). */
export type TaskHistory = Prisma.AssignmentGetPayload<{ select: typeof historySelect }>;

/** An assignment that reserves budget: accepted, running, pushed or a live auto offer. */
interface HeldRun {
  id: string;
  userId: string;
  agentId: string | null;
  taskId: string;
  /** False for PUSHED runs: they still reserve budget but no longer hold a slot. */
  holdsSlot: boolean;
  task: { projectId: string; size: TaskSize; model: Model; sizeBudgets: unknown };
}

interface FinishedRun {
  projectId: string;
  finishedAt: Date;
  weighted: number;
}

export interface SlotCounts {
  total: number;
  perAgent: Map<string, number>;
}

type TaskLike = { projectId: string; size: TaskSize; model: Model };
const medianKey = (t: TaskLike) => `${t.projectId}:${t.size}:${t.model}`;

function groupBy<T>(rows: T[], key: (r: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const r of rows) {
    const k = key(r);
    const list = out.get(k);
    if (list) list.push(r);
    else out.set(k, [r]);
  }
  return out;
}

/**
 * Budget and concurrency state of a set of members: their held runs, the usage of their
 * finished runs in the current window and the median estimates. In memory once loaded.
 */
export class BudgetLedger {
  private constructor(
    private readonly cfg: EstimateConfig,
    private readonly now: Date,
    private readonly held: Map<string, HeldRun[]>,
    private readonly finished: Map<string, FinishedRun[]>,
    private readonly medians: Map<string, number | null>,
  ) {}

  /**
   * Loads the ledger of `userIds`. `usage` gives each member's latest report (its window start
   * bounds the finished runs to read); `projectIds` are the projects whose tasks will be
   * estimated besides the held ones.
   */
  static async load(
    prisma: PrismaClient,
    cfg: EstimateConfig,
    now: Date,
    scope: { userIds: string[]; usage: Map<string, UsageSnapshot>; projectIds: string[] },
  ): Promise<BudgetLedger> {
    const { userIds, usage } = scope;
    const withUsage = userIds.filter((id) => usage.has(id));
    let since: Date | null = null;
    for (const id of withUsage) {
      const s = windowStartOf(usage.get(id)!, now);
      if (!since || s < since) since = s;
    }
    const [heldRows, finishedRows] = await Promise.all([
      userIds.length === 0
        ? []
        : prisma.assignment.findMany({
            where: {
              userId: { in: userIds },
              OR: [
                // A pushed run is not over yet (its usage is only known at task.finished): held.
                { status: { in: [...HOLDS_SLOT, 'PUSHED'] } },
                { status: 'PENDING', kind: 'AUTO_OFFER', expiresAt: { gt: now } },
              ],
            },
            select: {
              id: true,
              userId: true,
              agentId: true,
              taskId: true,
              status: true,
              task: {
                select: {
                  projectId: true,
                  size: true,
                  model: true,
                  project: { select: { sizeBudgets: true } },
                },
              },
            },
          }),
      since === null
        ? []
        : prisma.assignment.findMany({
            where: {
              userId: { in: withUsage },
              finishedAt: { gte: since },
              usageWeighted: { not: null },
            },
            select: {
              userId: true,
              finishedAt: true,
              usageWeighted: true,
              task: { select: { projectId: true } },
            },
          }),
    ]);
    const held: HeldRun[] = heldRows.map((a) => ({
      id: a.id,
      userId: a.userId,
      agentId: a.agentId,
      taskId: a.taskId,
      holdsSlot: a.status !== 'PUSHED',
      task: {
        projectId: a.task.projectId,
        size: a.task.size,
        model: a.task.model,
        sizeBudgets: a.task.project.sizeBudgets,
      },
    }));
    const finished = finishedRows.map((a) => ({
      userId: a.userId,
      projectId: a.task.projectId,
      finishedAt: a.finishedAt!,
      weighted: Number(a.usageWeighted ?? 0),
    }));
    const projectIds = new Set([...scope.projectIds, ...held.map((h) => h.task.projectId)]);
    const medians = await loadMedians(prisma, [...projectIds]);
    return new BudgetLedger(
      cfg,
      now,
      groupBy(held, (h) => h.userId),
      groupBy(finished, (f) => f.userId),
      medians,
    );
  }

  /** Estimate of a task (ESTIMATE): the median of past runs once there are enough of them. */
  estimate(t: TaskLike, sizeBudgets: unknown): number {
    return taskEstimate(t.size, t.model, {
      proWindow: this.cfg.proWindow,
      opusFactor: this.cfg.opusFactor,
      sizeBudgets,
      median: this.medians.get(medianKey(t)) ?? null,
    });
  }

  /** Slots used per agent and per user: accepted/running runs plus live auto offers. */
  slotCounts(userId: string): SlotCounts {
    const perAgent = new Map<string, number>();
    let total = 0;
    for (const h of this.held.get(userId) ?? []) {
      if (!h.holdsSlot) continue;
      total++;
      if (h.agentId) perAgent.set(h.agentId, (perAgent.get(h.agentId) ?? 0) + 1);
    }
    return { total, perAgent };
  }

  /**
   * Margin of a member on a project (ESTIMATE). Null when the capacity is unknown. Excludes
   * `excludeTaskId` from the reservations (the task being placed).
   */
  marginOf(
    userId: string,
    projectId: string,
    percent: number,
    usage: UsageSnapshot,
    excludeTaskId?: string,
  ): Margin | null {
    let reservedProject = 0;
    let reservedAll = 0;
    for (const h of this.held.get(userId) ?? []) {
      if (excludeTaskId && h.taskId === excludeTaskId) continue;
      const e = this.estimate(h.task, h.task.sizeBudgets);
      reservedAll += e;
      if (h.task.projectId === projectId) reservedProject += e;
    }
    const since = windowStartOf(usage, this.now);
    let used = 0;
    let usedAll = 0;
    for (const f of this.finished.get(userId) ?? []) {
      if (f.finishedAt < since) continue;
      usedAll += f.weighted;
      if (f.projectId === projectId) used += f.weighted;
    }
    return computeMargin({
      usage,
      now: this.now,
      projectId,
      percent,
      reserve: this.cfg.reserve,
      orchUsedInWindow: used,
      orchUsedAllInWindow: usedAll,
      reservedProject,
      reservedAll,
    });
  }

  /** A live auto offer was just created: it holds a slot and reserves its estimate. */
  recordOffer(a: Assignment, task: TaskLike & { project: { sizeBudgets: unknown } }): void {
    if (a.kind !== 'AUTO_OFFER' || a.status !== 'PENDING') return;
    if (!a.expiresAt || a.expiresAt.getTime() <= this.now.getTime()) return;
    const list = this.held.get(a.userId) ?? [];
    list.push({
      id: a.id,
      userId: a.userId,
      agentId: a.agentId,
      taskId: a.taskId,
      holdsSlot: true,
      task: {
        projectId: task.projectId,
        size: task.size,
        model: task.model,
        sizeBudgets: task.project.sizeBudgets,
      },
    });
    this.held.set(a.userId, list);
  }

  /** The offer was closed right away (undeliverable): it holds nothing any more. */
  release(a: Assignment): void {
    const list = this.held.get(a.userId);
    if (list)
      this.held.set(
        a.userId,
        list.filter((h) => h.id !== a.id),
      );
  }
}

/** Medians of the latest successful runs per (project, size, model); null below 5 samples. */
async function loadMedians(
  prisma: PrismaClient,
  projectIds: string[],
): Promise<Map<string, number | null>> {
  const out = new Map<string, number | null>();
  if (projectIds.length === 0) return out;
  // Same rows as `findMany({ orderBy: { finishedAt: 'desc' }, take: 50 })` per key.
  const rows = await prisma.$queryRaw<
    Array<{ projectId: string; size: TaskSize; model: Model; usageWeighted: bigint | number }>
  >`
    SELECT "projectId", "size", "model", "usageWeighted"
    FROM (
      SELECT t."projectId", t."size"::text AS "size", t."model"::text AS "model",
             a."usageWeighted",
             ROW_NUMBER() OVER (
               PARTITION BY t."projectId", t."size", t."model" ORDER BY a."finishedAt" DESC
             ) AS rn
      FROM "Assignment" a JOIN "Task" t ON t."id" = a."taskId"
      WHERE a."status" = 'SUCCEEDED' AND a."usageWeighted" > 0
        AND t."projectId" IN (${Prisma.join(projectIds)})
    ) s
    WHERE rn <= ${MEDIAN_SAMPLES}`;
  const samples = groupBy(rows, (r) => medianKey(r));
  for (const [k, list] of samples) {
    out.set(
      k,
      list.length >= MEDIAN_MIN_SAMPLES ? median(list.map((r) => Number(r.usageWeighted))) : null,
    );
  }
  return out;
}

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

/** Latest usage report of each member (any age: the caller decides whether it is fresh). */
export async function loadLatestUsage(
  prisma: PrismaClient,
  userIds: string[],
): Promise<Map<string, UsageSnapshot>> {
  const out = new Map<string, UsageSnapshot>();
  if (userIds.length === 0) return out;
  const latest = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT DISTINCT ON ("userId") "id" FROM "UsageReport"
    WHERE "userId" IN (${Prisma.join(userIds)})
    ORDER BY "userId", "reportedAt" DESC`;
  if (latest.length === 0) return out;
  const rows = await prisma.usageReport.findMany({
    where: { id: { in: latest.map((r) => r.id) } },
  });
  for (const r of rows) out.set(r.userId, toSnapshot(r));
  return out;
}

/** Everything the offer path of one tick (or one "why not running?") reads. */
export class TickSnapshot {
  /** Owner access decisions, asked once per member and tick. */
  readonly ownerAllowed = new Map<string, boolean>();

  private constructor(
    readonly ledger: BudgetLedger,
    private readonly participants: Map<string, Participant[]>,
    private readonly history: Map<string, TaskHistory[]>,
    private readonly usage: Map<string, UsageSnapshot>,
    private readonly lastAssigned: Map<string, Date>,
  ) {}

  static async load(
    prisma: PrismaClient,
    cfg: EstimateConfig,
    now: Date,
    tasks: Array<{ id: string; projectId: string }>,
  ): Promise<TickSnapshot> {
    const projectIds = [...new Set(tasks.map((t) => t.projectId))];
    const taskIds = tasks.map((t) => t.id);
    const parts =
      projectIds.length === 0
        ? []
        : await prisma.participation.findMany({
            where: { projectId: { in: projectIds }, active: true },
            include: participantInclude,
            orderBy: { createdAt: 'asc' },
          });
    const userIds = [...new Set(parts.map((p) => p.userId))];
    const [history, usage, lastAssigned] = await Promise.all([
      taskIds.length === 0
        ? []
        : prisma.assignment.findMany({
            where: {
              taskId: { in: taskIds },
              OR: [
                { status: 'PENDING' },
                {
                  status: { in: [...SHUT_OUT] },
                  updatedAt: { gt: new Date(now.getTime() - SHUT_OUT_MS) },
                },
              ],
            },
            select: historySelect,
          }),
      loadLatestUsage(prisma, userIds),
      userIds.length === 0
        ? []
        : prisma.assignment.groupBy({
            by: ['userId'],
            where: {
              userId: { in: userIds },
              respondedAt: { not: null },
              status: { notIn: ['PENDING', 'REJECTED', 'EXPIRED', 'CANCELLED'] },
            },
            _max: { respondedAt: true },
          }),
    ]);
    const ledger = await BudgetLedger.load(prisma, cfg, now, { userIds, usage, projectIds });
    const last = new Map<string, Date>();
    for (const r of lastAssigned) if (r._max.respondedAt) last.set(r.userId, r._max.respondedAt);
    return new TickSnapshot(
      ledger,
      groupBy(parts, (p) => p.projectId),
      groupBy(history, (a) => a.taskId),
      usage,
      last,
    );
  }

  /** Active participations of a project, oldest first (approval not checked yet). */
  participantsOf(projectId: string): Participant[] {
    return this.participants.get(projectId) ?? [];
  }

  /** Pending and recently closed (24 h) assignments of a task. */
  historyOf(taskId: string): TaskHistory[] {
    return this.history.get(taskId) ?? [];
  }

  pendingOf(taskId: string): TaskHistory[] {
    return this.historyOf(taskId).filter((a) => a.status === 'PENDING');
  }

  latestUsage(userId: string): UsageSnapshot | null {
    return this.usage.get(userId) ?? null;
  }

  /** When the member last accepted (or claimed) a task: the last ranking tie-breaker. */
  lastAssignedAt(userId: string): Date | null {
    return this.lastAssigned.get(userId) ?? null;
  }

  /** The tick created this offer or request: later tasks of the tick must see it. */
  recordOffer(a: Assignment, task: TaskLike & { project: { sizeBudgets: unknown } }): void {
    const list = this.history.get(a.taskId) ?? [];
    list.push({
      id: a.id,
      taskId: a.taskId,
      userId: a.userId,
      kind: a.kind,
      status: a.status,
      reason: a.reason,
      failureClass: a.failureClass,
      respondedAt: a.respondedAt,
      finishedAt: a.finishedAt,
      updatedAt: a.updatedAt,
    });
    this.history.set(a.taskId, list);
    this.ledger.recordOffer(a, task);
  }

  /** The offer was closed at once (undeliverable): forget it. */
  releaseOffer(a: Assignment): void {
    const list = this.history.get(a.taskId);
    if (list) {
      this.history.set(
        a.taskId,
        list.filter((h) => h.id !== a.id),
      );
    }
    this.ledger.release(a);
  }
}
