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
  /** Declared plan (informational only; it no longer sets a limit). */
  plan?: PlanName;
  /** Explicit limit (ORCH_USAGE_LIMIT). Unit: weighted tokens per 5h window. Skips calibration. */
  limitWeighted?: number;
  /** History scanned for calibration, in days. Default 30. */
  historyDays?: number;
  /** Completed blocks required before the calibrated limit is trusted. Default 3. */
  minBlocks?: number;
  /** Per-file parse cache (mtime + size). Default: a process-wide cache. */
  cache?: UsageCache;
  /** Fraction of the limit held in reserve. Default 0.2. */
  safetyMargin?: number;
  /** Weight applied to opus models. Default 5. */
  opusFactor?: number;
  /** Ledger of orch task runs' usage (`task-ledger.ts`), merged into the window. */
  taskLedger?: string;
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
  /**
   * Weighted tokens of the current window per orch projectId (task runs from the ledger), plus
   * "personal" (everything else). Absent in older sources: all of it is personal.
   */
  byProject?: Record<string, number>;
  weekly: { since: number; tokens: TokenTotals; weighted: number; informationalOnly: true };
  budget: {
    plan: PlanName | 'custom';
    /** Where the limit comes from; 'unknown' = not enough history and no override. */
    limitSource: 'override' | 'calibrated' | 'unknown';
    /** Null when the capacity is unknown. */
    limitWeighted: number | null;
    safetyMargin: number;
    /** limit * (1 - safetyMargin); null when unknown. */
    usableWeighted: number | null;
    /** usable - weighted, never below 0; null when unknown. */
    remainingWeighted: number | null;
    /** weighted / usable, may exceed 1; null when unknown. */
    usedFraction: number | null;
    /** 1 - weighted / usable clamped to [0, 1]; null when unknown. */
    marginFraction: number | null;
    /** Completed 5h blocks found in the scanned history. */
    completedBlocks: number;
  };
  /** Epoch ms until which a rate-limit / usage-limit error says Claude is unavailable, if any. */
  rateLimitedUntil: number | null;
  filesScanned: number;
  linesSkipped: number;
}

/** A rate-limit / usage-limit error seen in the logs. */
export interface RateLimitEvent {
  /** When the error was logged. */
  at: number;
  /** Parsed reset time, epoch ms, or null when the message gave none we could read. */
  resetAt: number | null;
}

export interface KeyedEntry {
  key: string | null;
  entry: UsageEntry;
}

export interface CachedFile {
  mtimeMs: number;
  size: number;
  /** The `since` this parse was filtered with; reusable for any `since` >= this. */
  since: number;
  entries: KeyedEntry[];
  rateLimits: RateLimitEvent[];
  linesSkipped: number;
}

/** Per-file scan results, keyed by absolute path. */
export type UsageCache = Map<string, CachedFile>;
