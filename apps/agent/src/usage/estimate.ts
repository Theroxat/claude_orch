import { buildBlocks, currentBlock } from './blocks';
import { modelFamily } from './models';
import { createUsageCache, scanUsage } from './scanner';
import { readTaskUsage } from './task-ledger';
import type { EstimateOptions, TokenTotals, UsageCache, UsageEntry, UsageEstimate } from './types';

const DAY_MS = 24 * 3_600_000;
const WEEK_MS = 7 * DAY_MS;
export const DEFAULT_HISTORY_DAYS = 30;
export const DEFAULT_MIN_BLOCKS = 3;

/** Process-wide cache so the 5-minute loop only re-reads files that changed. */
const defaultCache: UsageCache = createUsageCache();

const zero = (): TokenTotals => ({ input: 0, output: 0, cacheWrite: 0, cacheRead: 0 });

export const modelFactor = (model: string, opusFactor: number): number =>
  modelFamily(model) === 'opus' ? opusFactor : 1;

/** PLAN 5.7: (input + output + cacheWrite + 0.1 * cacheRead) * modelFactor. */
export function weigh(t: TokenTotals, factor: number): number {
  return (t.input + t.output + t.cacheWrite + 0.1 * t.cacheRead) * factor;
}

function add(t: TokenTotals, e: UsageEntry): void {
  t.input += e.input;
  t.output += e.output;
  t.cacheWrite += e.cacheWrite;
  t.cacheRead += e.cacheRead;
}

function summarize(entries: UsageEntry[], opusFactor: number) {
  const tokens = zero();
  const byModel: UsageEstimate['byModel'] = {};
  let weighted = 0;
  for (const e of entries) {
    add(tokens, e);
    const m = (byModel[e.model] ??= { ...zero(), weighted: 0 });
    add(m, e);
    const w = weigh({ ...e }, modelFactor(e.model, opusFactor));
    m.weighted += w;
    weighted += w;
  }
  return { tokens, byModel, weighted };
}

const weighEntry = (e: UsageEntry, opusFactor: number): number =>
  weigh(e, modelFactor(e.model, opusFactor));

/**
 * ccusage `--token-limit max`: the largest weighted total of any COMPLETED block. Same weighting as
 * the current block, so the opus factor cancels out of the ratio.
 */
function calibrate(
  completed: { entries: UsageEntry[] }[],
  opusFactor: number,
  minBlocks: number,
): number | null {
  if (completed.length < minBlocks) return null;
  let max = 0;
  for (const b of completed) {
    let w = 0;
    for (const e of b.entries) w += weighEntry(e, opusFactor);
    if (w > max) max = w;
  }
  return max > 0 ? max : null;
}

/** Compute the (estimated) current 5h window usage and remaining margin from local Claude logs. */
export async function estimateUsage(opts: EstimateOptions = {}): Promise<UsageEstimate> {
  const root = opts.root ?? '/host-claude';
  const now = opts.now ?? Date.now();
  const opusFactor = opts.opusFactor ?? 5;
  const safetyMargin = opts.safetyMargin ?? 0.2;
  const plan = opts.plan ?? 'pro';
  const minBlocks = opts.minBlocks ?? DEFAULT_MIN_BLOCKS;
  const historySince = now - (opts.historyDays ?? DEFAULT_HISTORY_DAYS) * DAY_MS;

  const scan = await scanUsage(root, historySince, opts.cache ?? defaultCache);
  // orch task runs log inside their containers, never under `root`: merge their recorded usage.
  const taskEntries = opts.taskLedger ? readTaskUsage(opts.taskLedger, historySince) : [];
  const entries: UsageEntry[] = [...scan.entries, ...taskEntries].filter((e) => e.timestamp <= now);

  const blocks = buildBlocks(entries);
  const block = currentBlock(blocks, now);
  const completed = blocks.filter((b) => b !== block);
  const cur = summarize(block?.entries ?? [], opusFactor);
  const byProject: Record<string, number> = { personal: 0 };
  for (const e of block?.entries ?? []) {
    const p = (e as { projectId?: string }).projectId ?? 'personal';
    byProject[p] = (byProject[p] ?? 0) + weighEntry(e, opusFactor);
  }
  const weekSince = now - WEEK_MS;
  const week = summarize(
    entries.filter((e) => e.timestamp >= weekSince),
    opusFactor,
  );

  const override = opts.limitWeighted !== undefined && opts.limitWeighted > 0;
  const limit = override ? opts.limitWeighted! : calibrate(completed, opusFactor, minBlocks);
  const usable = limit === null ? null : limit * (1 - safetyMargin);

  // Latest still-future reset time announced by a rate-limit error.
  let rateLimitedUntil: number | null = null;
  for (const r of scan.rateLimits)
    if (
      r.resetAt !== null &&
      r.resetAt > now &&
      (rateLimitedUntil === null || r.resetAt > rateLimitedUntil)
    )
      rateLimitedUntil = r.resetAt;

  return {
    estimate: true,
    source: 'claude-code-jsonl',
    now,
    window: block ? { start: block.start, resetAt: block.end } : null,
    tokens: cur.tokens,
    byModel: cur.byModel,
    weighted: cur.weighted,
    byProject,
    weekly: {
      since: weekSince,
      tokens: week.tokens,
      weighted: week.weighted,
      informationalOnly: true,
    },
    budget: {
      plan: override ? 'custom' : plan,
      limitSource: override ? 'override' : limit === null ? 'unknown' : 'calibrated',
      limitWeighted: limit,
      safetyMargin,
      usableWeighted: usable,
      remainingWeighted: usable === null ? null : Math.max(0, usable - cur.weighted),
      usedFraction: usable === null ? null : usable > 0 ? cur.weighted / usable : 1,
      marginFraction:
        usable === null
          ? null
          : usable > 0
            ? Math.min(1, Math.max(0, 1 - cur.weighted / usable))
            : 0,
      completedBlocks: completed.length,
    },
    rateLimitedUntil,
    filesScanned: scan.filesScanned,
    linesSkipped: scan.linesSkipped,
  };
}
