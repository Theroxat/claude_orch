/** Usage estimator types. Every figure produced here is an ESTIMATE, never a billing number. */

export interface UsageEntry {
  /** Epoch milliseconds. */
  timestamp: number;
  model: string;
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

export interface TokenTotals {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

export interface Block {
  /** Start floored to the hour (UTC), epoch ms. */
  start: number;
  /** start + 5h. */
  end: number;
  lastEntryAt: number;
  entries: UsageEntry[];
}

export type PlanName = 'pro' | 'max5' | 'max20';

export interface EstimateOptions {
  /** Directory containing `projects/**\/*.jsonl`. Default `/host-claude`. */
  root?: string;
  now?: number;
  plan?: PlanName;
  /** Overrides the plan preset. Unit: weighted tokens per 5h window. */
  limitWeighted?: number;
  /** Fraction of the limit held in reserve. Default 0.2. */
  safetyMargin?: number;
  /** Weight applied to opus models. Default 5. */
  opusFactor?: number;
}

export interface UsageEstimate {
  /** Always true: the numbers are local-log based approximations. */
  estimate: true;
  source: 'claude-code-jsonl';
  now: number;
  /** Null when no block is currently active. */
  window: { start: number; resetAt: number } | null;
  tokens: TokenTotals;
  byModel: Record<string, TokenTotals & { weighted: number }>;
  weighted: number;
  weekly: { since: number; tokens: TokenTotals; weighted: number; informationalOnly: true };
  budget: {
    plan: PlanName | 'custom';
    limitWeighted: number;
    safetyMargin: number;
    /** limit * (1 - safetyMargin) */
    usableWeighted: number;
    /** usable - weighted, never below 0. */
    remainingWeighted: number;
    /** weighted / usable, may exceed 1. */
    usedFraction: number;
  };
  filesScanned: number;
  linesSkipped: number;
}
