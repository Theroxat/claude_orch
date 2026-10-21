import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { estimateUsage } from '../../src/usage/estimate';
import { modelFamily } from '../../src/usage/models';
import { parseRateLimit, parseResetTime } from '../../src/usage/ratelimit';
import { createUsageCache, scanUsage } from '../../src/usage/scanner';

const t = (s: string): number => Date.parse(s);
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

let seq = 0;
const line = (ts: string, model: string, output: number, extra: object = {}): string =>
  JSON.stringify({
    timestamp: ts,
    requestId: `r${++seq}`,
    message: { id: `m${seq}`, model, usage: { input_tokens: 0, output_tokens: output } },
    ...extra,
  });

function mkRoot(files: Record<string, string[]>): string {
  const root = mkdtempSync(join(tmpdir(), 'usage-'));
  dirs.push(root);
  mkdirSync(join(root, 'projects', 'p'), { recursive: true });
  for (const [name, lines] of Object.entries(files))
    writeFileSync(join(root, 'projects', 'p', name), `${lines.join('\n')}\n`);
  return root;
}

// 4 completed blocks (100, 300, 200, 50 sonnet output tokens) + a current one (60).
const HISTORY = [
  line('2026-10-10T00:10:00Z', 'claude-sonnet-5-5', 100),
  line('2026-10-11T00:10:00Z', 'claude-sonnet-5-5', 100),
  line('2026-10-11T01:10:00Z', 'claude-sonnet-5-5', 200),
  line('2026-10-12T00:10:00Z', 'claude-sonnet-5-5', 200),
  line('2026-10-13T00:10:00Z', 'claude-sonnet-5-5', 50),
  line('2026-10-21T10:10:00Z', 'claude-sonnet-5-5', 60),
];
const NOW = t('2026-10-21T12:00:00Z');

describe('limit calibration', () => {
  it('uses the max weighted total of completed blocks, never the current one', async () => {
    const root = mkRoot({ 'a.jsonl': HISTORY });
    const r = await estimateUsage({ root, now: NOW, cache: createUsageCache() });
    expect(r.budget.completedBlocks).toBe(4);
    expect(r.budget.limitSource).toBe('calibrated');
    expect(r.budget.limitWeighted).toBe(300);
    expect(r.weighted).toBe(60);
    expect(r.budget.usableWeighted).toBe(240); // reserve applied once
    expect(r.budget.marginFraction).toBeCloseTo(1 - 60 / 240);
  });

  it('applies the opus factor identically to calibration and the current block', async () => {
    const root = mkRoot({
      'a.jsonl': [
        line('2026-10-10T00:10:00Z', 'claude-opus-5-5', 10),
        line('2026-10-11T00:10:00Z', 'claude-opus-5-5', 20),
        line('2026-10-12T00:10:00Z', 'claude-sonnet-5-5', 30),
        line('2026-10-21T10:10:00Z', 'claude-opus-5-5', 10),
      ],
    });
    const r = await estimateUsage({ root, now: NOW, cache: createUsageCache() });
    expect(r.budget.limitWeighted).toBe(100); // 20 * 5
    expect(r.weighted).toBe(50);
  });

  it('a block over the limit gives margin 0, clamped', async () => {
    const root = mkRoot({
      'a.jsonl': [...HISTORY, line('2026-10-21T11:00:00Z', 'claude-sonnet-5-5', 5000)],
    });
    const r = await estimateUsage({ root, now: NOW, cache: createUsageCache() });
    expect(r.budget.marginFraction).toBe(0);
    expect(r.budget.usedFraction).toBeGreaterThan(1);
  });

  it('ORCH_USAGE_LIMIT override wins over calibration', async () => {
    const root = mkRoot({ 'a.jsonl': HISTORY });
    const r = await estimateUsage({
      root,
      now: NOW,
      limitWeighted: 1000,
      cache: createUsageCache(),
    });
    expect(r.budget.limitSource).toBe('override');
    expect(r.budget.plan).toBe('custom');
    expect(r.budget.usableWeighted).toBe(800);
  });

  it('override works even with no history', async () => {
    const root = mkRoot({ 'a.jsonl': [] });
    const r = await estimateUsage({
      root,
      now: NOW,
      limitWeighted: 100,
      cache: createUsageCache(),
    });
    expect(r.budget.marginFraction).toBe(1);
  });

  it('fewer than 3 completed blocks is unknown capacity, not 0%', async () => {
    const root = mkRoot({
      'a.jsonl': [
        line('2026-10-10T00:10:00Z', 'claude-sonnet-5-5', 100),
        line('2026-10-11T00:10:00Z', 'claude-sonnet-5-5', 100),
        line('2026-10-21T10:10:00Z', 'claude-sonnet-5-5', 60),
      ],
    });
    const r = await estimateUsage({ root, now: NOW, cache: createUsageCache() });
    expect(r.budget.completedBlocks).toBe(2);
    expect(r.budget.limitSource).toBe('unknown');
    expect(r.budget.limitWeighted).toBeNull();
    expect(r.budget.usableWeighted).toBeNull();
    expect(r.budget.marginFraction).toBeNull();
    expect(r.weighted).toBe(60);
  });
});

describe('modelFamily', () => {
  it.each([
    ['claude-opus-5-5', 'opus'],
    ['claude-opus-5', 'opus'],
    ['claude-opus-4-1-20250805', 'opus'],
    ['claude-3-opus-20240229', 'opus'],
    ['anthropic.claude-opus-5-5-v1:0', 'opus'],
    ['claude-opus-5-5[1m]', 'opus'],
    ['opus', 'opus'],
    ['claude-sonnet-5-5', 'sonnet'],
    ['sonnet', 'sonnet'],
    ['claude-haiku-5-5', 'haiku'],
    ['haiku', 'haiku'],
    ['unknown', 'other'],
    ['opusculum-1', 'other'],
    ['<synthetic>', 'other'],
  ])('%s -> %s', (id, fam) => {
    expect(modelFamily(id)).toBe(fam);
  });
});

describe('rate-limit detection', () => {
  const rec = (text: string, extra: object = {}) => ({
    isApiErrorMessage: true,
    message: { content: [{ type: 'text', text }] },
    ...extra,
  });

  it('parses epoch reset times', () => {
    expect(parseResetTime('Claude AI usage limit reached|1792000000', 0)).toBe(1_792_000_000_000);
  });

  it('parses a wall-clock reset with an IANA zone', () => {
    // 2026-10-21 is CEST (UTC+2): 3pm Paris = 13:00Z, the next one after 08:00Z.
    expect(
      parseResetTime(
        "You've hit your limit · resets 3pm (Europe/Paris)",
        t('2026-10-21T08:00:00Z'),
      ),
    ).toBe(t('2026-10-21T13:00:00Z'));
    // already past today -> tomorrow
    expect(
      parseResetTime('5-hour limit reached ∙ resets 3pm (Europe/Paris)', t('2026-10-21T14:00:00Z')),
    ).toBe(t('2026-10-22T13:00:00Z'));
    expect(parseResetTime('limit reached, resets 9:30am', t('2026-10-21T08:00:00Z'))).toBe(
      t('2026-10-21T09:30:00Z'),
    );
  });

  it('returns null when nothing is parseable', () => {
    expect(parseResetTime('usage limit reached', 0)).toBeNull();
    expect(parseResetTime('resets 3pm (Nowhere/Land)', 0)).toBeNull();
  });

  it('only API error records count, not conversation text', () => {
    const at = t('2026-10-21T08:00:00Z');
    expect(parseRateLimit(rec('usage limit reached|1792000000'), at)?.resetAt).toBe(
      1_792_000_000_000,
    );
    expect(parseRateLimit({ message: { content: 'usage limit reached 429' } }, at)).toBeNull();
    expect(parseRateLimit(rec('Login expired'), at)).toBeNull();
  });

  it('sets rateLimitedUntil from a future reset, ignores past ones', async () => {
    const mk = (resetEpoch: number) =>
      mkRoot({
        'a.jsonl': [
          ...HISTORY,
          JSON.stringify({
            timestamp: '2026-10-21T11:30:00Z',
            ...rec(`Claude AI usage limit reached|${resetEpoch}`),
          }),
        ],
      });
    const future = Math.floor(t('2026-10-21T15:00:00Z') / 1000);
    const r = await estimateUsage({ root: mk(future), now: NOW, cache: createUsageCache() });
    expect(r.rateLimitedUntil).toBe(future * 1000);
    const past = Math.floor(t('2026-10-21T11:45:00Z') / 1000);
    const r2 = await estimateUsage({ root: mk(past), now: NOW, cache: createUsageCache() });
    expect(r2.rateLimitedUntil).toBeNull();
  });
});

describe('scan cache and mtime skipping', () => {
  it('re-reads a file only when its mtime or size changes', async () => {
    const root = mkRoot({ 'a.jsonl': HISTORY });
    const cache = createUsageCache();
    const since = NOW - 30 * 86_400_000;
    const a = await scanUsage(root, since, cache);
    expect([a.filesScanned, a.filesParsed, a.entries.length]).toEqual([1, 1, 6]);
    const b = await scanUsage(root, since, cache);
    expect([b.filesScanned, b.filesParsed, b.entries.length]).toEqual([1, 0, 6]);

    const file = join(root, 'projects', 'p', 'a.jsonl');
    appendFileSync(file, `${line('2026-10-21T11:00:00Z', 'claude-sonnet-5-5', 1)}\n`);
    const c = await scanUsage(root, since, cache);
    expect([c.filesParsed, c.entries.length]).toEqual([1, 7]);
  });

  it('skips files older than the window and drops them from the cache', async () => {
    const root = mkRoot({ 'old.jsonl': HISTORY, 'new.jsonl': [] });
    const old = join(root, 'projects', 'p', 'old.jsonl');
    const cache = createUsageCache();
    await scanUsage(root, 0, cache);
    expect(cache.has(old)).toBe(true);
    const ancient = new Date('2020-01-01T00:00:00Z');
    utimesSync(old, ancient, ancient);
    const r = await scanUsage(root, NOW - 30 * 86_400_000, cache);
    expect(r.filesScanned).toBe(1);
    expect(r.entries).toHaveLength(0);
    expect(cache.has(old)).toBe(false);
  });
});
