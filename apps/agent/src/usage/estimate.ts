import { buildBlocks, currentBlock } from './blocks';
import { scanUsage } from './scanner';
import type { EstimateOptions, PlanName, TokenTotals, UsageEntry, UsageEstimate } from './types';

const WEEK_MS = 7 * 24 * 3_600_000;

/**
 * Placeholder per-plan limits in WEIGHTED tokens per 5h window. Anthropic does not publish exact
 * numbers, so these are rough starting points; override with `limitWeighted`.
 */
export const PLAN_LIMITS: Record<PlanName, number> = {
  pro: 44_000,
  max5: 88_000,
  max20: 220_000,
};

const zero = (): TokenTotals => ({ input: 0, output: 0, cacheWrite: 0, cacheRead: 0 });

export const modelFactor = (model: string, opusFactor: number): number =>
  model.toLowerCase().includes('opus') ? opusFactor : 1;

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

/** Compute the (estimated) current 5h window usage and remaining margin from local Claude logs. */
export async function estimateUsage(opts: EstimateOptions = {}): Promise<UsageEstimate> {
  const root = opts.root ?? '/host-claude';
  const now = opts.now ?? Date.now();
  const opusFactor = opts.opusFactor ?? 5;
  const safetyMargin = opts.safetyMargin ?? 0.2;
  const plan = opts.plan ?? 'pro';
  const limit = opts.limitWeighted ?? PLAN_LIMITS[plan];

  const since = now - WEEK_MS;
  const scan = await scanUsage(root, since);
  const entries = scan.entries.filter((e) => e.timestamp <= now);

  const block = currentBlock(buildBlocks(entries), now);
  const cur = summarize(block?.entries ?? [], opusFactor);
  const week = summarize(entries, opusFactor);

  const usable = limit * (1 - safetyMargin);
  return {
    estimate: true,
    source: 'claude-code-jsonl',
    now,
    window: block ? { start: block.start, resetAt: block.end } : null,
    tokens: cur.tokens,
    byModel: cur.byModel,
    weighted: cur.weighted,
    weekly: { since, tokens: week.tokens, weighted: week.weighted, informationalOnly: true },
    budget: {
      plan: opts.limitWeighted !== undefined ? 'custom' : plan,
      limitWeighted: limit,
      safetyMargin,
      usableWeighted: usable,
      remainingWeighted: Math.max(0, usable - cur.weighted),
      usedFraction: usable > 0 ? cur.weighted / usable : 1,
    },
    filesScanned: scan.filesScanned,
    linesSkipped: scan.linesSkipped,
  };
}
