import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildBlocks, currentBlock, BLOCK_MS } from '../../src/usage/blocks';
import { estimateUsage } from '../../src/usage/estimate';
import { readTaskUsage, recordTaskUsage } from '../../src/usage/task-ledger';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { UsageEntry } from '../../src/usage/types';

const fx = (n: string): string => join(dirname(fileURLToPath(import.meta.url)), 'fixtures', n);
const t = (s: string): number => Date.parse(s);
const entry = (ts: string): UsageEntry => ({
  timestamp: t(ts),
  model: 'm',
  input: 1,
  output: 1,
  cacheWrite: 0,
  cacheRead: 0,
});

// "now" is pinned near the fixture timestamps. The scanner only skips files whose mtime is older
// than now - 7d, and fixture files are always newer than that.
const NOW = t('2026-10-21T13:00:00Z');

describe('estimateUsage', () => {
  it('dedupes by message id + requestId across files and sums per model', async () => {
    const r = await estimateUsage({ root: fx('basic'), now: NOW, plan: 'pro' });
    expect(r.estimate).toBe(true);
    expect(r.tokens).toEqual({ input: 111, output: 71, cacheWrite: 10, cacheRead: 1000 });
    expect(Object.keys(r.byModel).sort()).toEqual(['claude-opus-4', 'claude-sonnet-4']);
    expect(r.byModel['claude-opus-4']?.output).toBe(20);
    expect(r.byModel['claude-opus-4']?.weighted).toBe(150); // (10+20)*5
    expect(r.byModel['claude-sonnet-4']?.weighted).toBe(101 + 51 + 10 + 100);
    expect(r.linesSkipped).toBe(0);
  });

  it('reports window start floored to the hour and reset = start + 5h', async () => {
    const r = await estimateUsage({ root: fx('basic'), now: NOW });
    expect(r.window).toEqual({
      start: t('2026-10-21T10:00:00Z'),
      resetAt: t('2026-10-21T15:00:00Z'),
    });
  });

  it('returns no window once the block has expired', async () => {
    const r = await estimateUsage({ root: fx('basic'), now: t('2026-10-21T15:00:00Z') });
    expect(r.window).toBeNull();
    expect(r.weighted).toBe(0);
    expect(r.weekly.tokens.input).toBe(111);
    expect(r.weekly.informationalOnly).toBe(true);
  });

  it('starts a new block after a gap of more than 5h', async () => {
    const r = await estimateUsage({ root: fx('gap'), now: t('2026-10-21T08:00:00Z') });
    expect(r.window?.start).toBe(t('2026-10-21T06:00:00Z'));
    expect(r.tokens.input).toBe(10);
    expect(r.weekly.tokens.input).toBe(15);
  });

  it('tolerates malformed lines and counts them', async () => {
    const r = await estimateUsage({ root: fx('malformed'), now: NOW });
    expect(r.linesSkipped).toBe(3);
    expect(r.tokens.input).toBe(4);
  });

  it('handles empty and missing roots', async () => {
    for (const root of [fx('empty'), fx('does-not-exist')]) {
      const r = await estimateUsage({ root, now: NOW });
      expect(r.window).toBeNull();
      expect(r.weighted).toBe(0);
      expect(r.budget.limitSource).toBe('unknown');
      expect(r.budget.usableWeighted).toBeNull();
      expect(r.budget.marginFraction).toBeNull();
    }
  });

  it('applies the safety margin and custom limit', async () => {
    const r = await estimateUsage({
      root: fx('malformed'),
      now: NOW,
      limitWeighted: 100,
      safetyMargin: 0.2,
    });
    expect(r.budget.plan).toBe('custom');
    expect(r.budget.usableWeighted).toBe(80);
    expect(r.budget.remainingWeighted).toBe(70);
    expect(r.budget.usedFraction).toBeCloseTo(10 / 80);
  });

  it('clamps remaining margin at 0 when over budget', async () => {
    const r = await estimateUsage({ root: fx('basic'), now: NOW, limitWeighted: 100 });
    expect(r.budget.remainingWeighted).toBe(0);
    expect(r.budget.usedFraction).toBeGreaterThan(1);
  });
});

describe('buildBlocks', () => {
  it('splits at the 5h block end even without a gap', () => {
    const b = buildBlocks([
      entry('2026-10-21T10:30:00Z'),
      entry('2026-10-21T13:30:00Z'),
      entry('2026-10-21T15:00:00Z'),
    ]);
    expect(b).toHaveLength(2);
    expect(b[1]?.start).toBe(t('2026-10-21T15:00:00Z'));
  });

  it('keeps an entry before the block end in the same block', () => {
    const b = buildBlocks([entry('2026-10-21T10:59:00Z'), entry('2026-10-21T14:59:00Z')]);
    expect(b).toHaveLength(1);
  });

  it('splits when the gap exceeds 5h', () => {
    const b = buildBlocks([entry('2026-10-21T00:00:00Z'), entry('2026-10-21T05:00:01Z')]);
    expect(b).toHaveLength(2);
  });

  it('currentBlock is null for empty input', () => {
    expect(currentBlock([], 0)).toBeNull();
    expect(BLOCK_MS).toBe(18_000_000);
  });
});

describe('task usage ledger (v0.6.2)', () => {
  const withLedger = async (fn: (file: string) => Promise<void>) => {
    const dir = mkdtempSync(join(tmpdir(), 'orch-ledger-'));
    try {
      await fn(join(dir, 'sub', 'task-usage.jsonl'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  const e = (ts: string, model: string, input: number): UsageEntry => ({
    timestamp: t(ts),
    model,
    input,
    output: 0,
    cacheWrite: 0,
    cacheRead: 0,
  });

  it('merges task runs into the window: total, byModel and byProject', async () => {
    await withLedger(async (file) => {
      recordTaskUsage(file, {
        assignmentId: 'asg_1',
        projectId: 'prj_1',
        entries: [e('2026-10-21T11:00:00Z', 'claude-sonnet-4', 1_000)],
      });
      const base = await estimateUsage({ root: fx('basic'), now: NOW });
      const r = await estimateUsage({ root: fx('basic'), now: NOW, taskLedger: file });
      expect(r.weighted).toBe(base.weighted + 1_000);
      expect(r.byProject).toEqual({ personal: base.weighted, prj_1: 1_000 });
      expect(r.byModel['claude-sonnet-4']?.weighted).toBe(
        (base.byModel['claude-sonnet-4']?.weighted ?? 0) + 1_000,
      );
    });
  });

  it('a later record of the same run replaces the earlier one; bad lines are skipped', async () => {
    await withLedger(async (file) => {
      const rec = (input: number) => ({
        assignmentId: 'asg_1',
        projectId: 'prj_1',
        entries: [e('2026-10-21T11:00:00Z', 'sonnet', input)],
      });
      recordTaskUsage(file, rec(10));
      writeFileSync(file, 'garbage\n{"assignmentId":1}\n', { flag: 'a' });
      recordTaskUsage(file, rec(30));
      expect(readTaskUsage(file, 0).map((x) => x.input)).toEqual([30]);
      expect(readTaskUsage(file, t('2026-10-21T12:00:00Z'))).toEqual([]);
    });
  });

  it('a task run alone opens a window', async () => {
    await withLedger(async (file) => {
      recordTaskUsage(file, {
        assignmentId: 'asg_2',
        projectId: 'prj_9',
        entries: [e('2026-10-21T12:30:00Z', 'claude-opus-4', 100)],
      });
      const r = await estimateUsage({ root: fx('missing-root'), now: NOW, taskLedger: file });
      expect(r.window).toEqual({
        start: t('2026-10-21T12:00:00Z'),
        resetAt: t('2026-10-21T17:00:00Z'),
      });
      expect(r.byProject).toEqual({ personal: 0, prj_9: 500 });
    });
  });
});
