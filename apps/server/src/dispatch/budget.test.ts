import { describe, expect, it } from 'vitest';
import {
  compareCandidates,
  computeMargin,
  median,
  taskEstimate,
  usageState,
  type RankKey,
  type UsageSnapshot,
} from './budget';

const now = new Date('2026-10-21T12:00:00Z');
const usage = (over: Partial<UsageSnapshot> = {}): UsageSnapshot => ({
  reportedAt: now,
  windowStart: new Date(now.getTime() - 3600_000),
  windowResetAt: new Date(now.getTime() + 4 * 3600_000),
  weighted: 0,
  capacity: 100_000,
  byProject: {},
  rateLimitedUntil: null,
  ...over,
});

describe('budget', () => {
  it('B = percent x C x (1 - s); margin subtracts used and reserved', () => {
    const m = computeMargin({
      usage: usage({ weighted: 30_000, byProject: { p: 5_000 } }),
      now,
      projectId: 'p',
      percent: 50,
      reserve: 0.2,
      orchUsedInWindow: 2_000,
      reservedProject: 10_000,
      reservedAll: 12_000,
    })!;
    expect(m.budget).toBe(40_000);
    expect(m.used).toBe(5_000);
    expect(m.margin).toBe(25_000);
    expect(m.globalMargin).toBe(80_000 - 30_000 - 12_000);
  });

  it("with the default (no extra server reserve), B is percent x the agent's net capacity", () => {
    // The agent reports capacityEstimate = limit x 0.8: 100k limit -> 80k.
    const m = computeMargin({
      usage: usage({ weighted: 0, byProject: {}, capacity: 80_000 }),
      now,
      projectId: 'p',
      percent: 50,
      reserve: 0,
      orchUsedInWindow: 0,
      reservedProject: 0,
      reservedAll: 0,
    })!;
    expect(m.budget).toBe(40_000); // 50 % x 100k x 0.8: the 20 % counted once
    expect(m.globalMargin).toBe(80_000);
  });

  it('uses the server-side orch usage when the report lags behind', () => {
    const m = computeMargin({
      usage: usage({ byProject: { p: 1_000 } }),
      now,
      projectId: 'p',
      percent: 100,
      reserve: 0,
      orchUsedInWindow: 9_000,
      reservedProject: 0,
      reservedAll: 0,
    })!;
    expect(m.used).toBe(9_000);
  });

  it('a window that already reset counts as unused; unknown capacity gives null', () => {
    const over = usage({
      weighted: 99_000,
      byProject: { p: 99_000 },
      windowResetAt: new Date(now.getTime() - 1),
    });
    const m = computeMargin({
      usage: over,
      now,
      projectId: 'p',
      percent: 100,
      reserve: 0,
      orchUsedInWindow: 0,
      reservedProject: 0,
      reservedAll: 0,
    })!;
    expect(m.margin).toBe(100_000);
    expect(
      computeMargin({
        usage: usage({ capacity: null }),
        now,
        projectId: 'p',
        percent: 100,
        reserve: 0,
        orchUsedInWindow: 0,
        reservedProject: 0,
        reservedAll: 0,
      }),
    ).toBeNull();
  });

  it('stale and missing reports are detected', () => {
    expect(usageState(null, now, 900_000)).toBe('none');
    expect(usageState(usage({ reportedAt: new Date(now.getTime() - 901_000) }), now, 900_000)).toBe(
      'stale',
    );
    expect(usageState(usage({ reportedAt: new Date(now.getTime() - 60_000) }), now, 900_000)).toBe(
      'fresh',
    );
  });

  it('task estimates: S/M/L of a Pro window, opus factor, project override, median', () => {
    const o = { proWindow: 40_000, opusFactor: 5 };
    expect(taskEstimate('S', 'SONNET', o)).toBe(4_000);
    expect(taskEstimate('M', 'SONNET', o)).toBe(10_000);
    expect(taskEstimate('L', 'OPUS', o)).toBe(100_000);
    expect(taskEstimate('S', 'SONNET', { ...o, sizeBudgets: { S: 123 } })).toBe(123);
    expect(taskEstimate('S', 'SONNET', { ...o, median: 777 })).toBe(777);
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });

  it('ranks by margin fraction, then running, reset soonest, least recently assigned', () => {
    const k = (over: Partial<RankKey>): RankKey => ({
      marginFraction: 0.5,
      running: 0,
      resetAt: null,
      lastAssignedAt: null,
      userId: 'u',
      ...over,
    });
    const sorted = [
      k({ userId: 'low', marginFraction: 0.1 }),
      k({ userId: 'unknown', marginFraction: null }),
      k({ userId: 'busy', marginFraction: 0.9, running: 1 }),
      k({ userId: 'late', marginFraction: 0.9, resetAt: new Date(now.getTime() + 2e6) }),
      k({ userId: 'soon', marginFraction: 0.9, resetAt: new Date(now.getTime() + 1e6) }),
      k({
        userId: 'recent',
        marginFraction: 0.9,
        resetAt: new Date(now.getTime() + 1e6),
        lastAssignedAt: now,
      }),
    ].sort(compareCandidates);
    expect(sorted.map((s) => s.userId)).toEqual([
      'soon',
      'recent',
      'late',
      'busy',
      'low',
      'unknown',
    ]);
  });
});
