/**
 * Budget arithmetic of the dispatcher (PLAN section 6). Pure functions, every figure an ESTIMATE.
 *
 *   B(u,p)      = percent(u,p)/100 x C_u x (1 - s)          (5-hour window only)
 *   margin(u,p) = B(u,p) - used(u,p) - reserved(u,p)
 *   global      = C_u x (1 - s) - totalUsed(u) - reservedAll(u)
 *   E(task)     = sizeBudget[size] x modelFactor
 *
 * C_u is the agent's `capacityEstimate`, s the server safety reserve.
 */
import type { Model, TaskSize } from '@prisma/client';

export interface UsageSnapshot {
  reportedAt: Date;
  windowStart: Date | null;
  windowResetAt: Date | null;
  /** Weighted tokens in the current window, all projects plus personal use. */
  weighted: number;
  capacity: number | null;
  /** Weighted tokens per projectId (and "personal") in the current window. */
  byProject: Record<string, number>;
  rateLimitedUntil: Date | null;
}

export type UsageState = 'none' | 'stale' | 'fresh';

export function usageState(u: UsageSnapshot | null, now: Date, staleMs: number): UsageState {
  if (!u) return 'none';
  return now.getTime() - u.reportedAt.getTime() > staleMs ? 'stale' : 'fresh';
}

/** True when the reported window is over: its usage no longer counts. */
export function windowOver(u: UsageSnapshot, now: Date): boolean {
  return u.windowResetAt !== null && u.windowResetAt.getTime() <= now.getTime();
}

/** Start of the current window, for counting orch usage the report may not include yet. */
export function windowStartOf(u: UsageSnapshot | null, now: Date): Date {
  if (u && u.windowStart && !windowOver(u, now)) return u.windowStart;
  return new Date(now.getTime() - 5 * 3600_000);
}

export const projectBudget = (percent: number, capacity: number, reserve: number) =>
  (Math.max(0, Math.min(100, percent)) / 100) * capacity * (1 - reserve);

export interface MarginInput {
  usage: UsageSnapshot;
  now: Date;
  projectId: string;
  percent: number;
  reserve: number;
  /** Weighted usage of finished orch attempts for this project in the window (server side). */
  orchUsedInWindow: number;
  /** Estimates of the member's accepted/running/offered tasks of this project. */
  reservedProject: number;
  /** Same, every project. */
  reservedAll: number;
}

export interface Margin {
  budget: number;
  used: number;
  reserved: number;
  margin: number;
  /** Whole-plan margin (personal use included). */
  globalMargin: number;
}

/** Null when the capacity is unknown. */
export function computeMargin(i: MarginInput): Margin | null {
  const cap = i.usage.capacity;
  if (cap === null || cap <= 0) return null;
  const over = windowOver(i.usage, i.now);
  const reported = over ? 0 : (i.usage.byProject[i.projectId] ?? 0);
  const total = over ? 0 : i.usage.weighted;
  const used = Math.max(reported, i.orchUsedInWindow);
  const budget = projectBudget(i.percent, cap, i.reserve);
  return {
    budget,
    used,
    reserved: i.reservedProject,
    margin: budget - used - i.reservedProject,
    globalMargin: cap * (1 - i.reserve) - Math.max(total, used) - i.reservedAll,
  };
}

export interface EstimateOptions {
  /** Weighted tokens of a Pro 5h window. */
  proWindow: number;
  opusFactor: number;
  /** Project override `{ S, M, L }` in weighted tokens (sonnet). */
  sizeBudgets?: unknown;
  /** Median of >= 5 past attempts for (project, size), weighted (already model-weighted). */
  median?: number | null;
}

const DEFAULT_FRACTION: Record<TaskSize, number> = { S: 0.1, M: 0.25, L: 0.5 };

export function taskEstimate(size: TaskSize, model: Model, o: EstimateOptions): number {
  if (o.median !== undefined && o.median !== null && o.median > 0) return o.median;
  const factor = model === 'OPUS' ? o.opusFactor : 1;
  const override =
    o.sizeBudgets && typeof o.sizeBudgets === 'object'
      ? (o.sizeBudgets as Record<string, unknown>)[size]
      : undefined;
  const base =
    typeof override === 'number' && override > 0 ? override : DEFAULT_FRACTION[size] * o.proWindow;
  return base * factor;
}

export function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

export interface RankKey {
  /** margin / budget; null when unknown (ranked last). */
  marginFraction: number | null;
  running: number;
  resetAt: Date | null;
  lastAssignedAt: Date | null;
  userId: string;
}

/**
 * PLAN ranking: highest margin/B, then fewest running tasks, then reset soonest, then least
 * recently assigned. The user id breaks remaining ties so the order is deterministic.
 */
export function compareCandidates(a: RankKey, b: RankKey): number {
  const fa = a.marginFraction ?? Number.NEGATIVE_INFINITY;
  const fb = b.marginFraction ?? Number.NEGATIVE_INFINITY;
  if (fa !== fb) return fb - fa;
  if (a.running !== b.running) return a.running - b.running;
  const ra = a.resetAt?.getTime() ?? Number.POSITIVE_INFINITY;
  const rb = b.resetAt?.getTime() ?? Number.POSITIVE_INFINITY;
  if (ra !== rb) return ra - rb;
  const la = a.lastAssignedAt?.getTime() ?? 0;
  const lb = b.lastAssignedAt?.getTime() ?? 0;
  if (la !== lb) return la - lb;
  return a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0;
}

export const EXEC_TIMEOUT_MIN: Record<TaskSize, number> = { S: 30, M: 90, L: 180 };
