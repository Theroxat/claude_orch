/**
 * Periodic usage report (PLAN 5.7): estimate from local Claude Code logs, mapped to the
 * `usage.report` payload and handed to `onReport` (the outbox, so delivery is at-least-once).
 */
import type { UsageReportPayload } from '@orch/shared';
import { errorMessage, type Logger } from './log';
import { estimateUsage, type EstimateOptions, type UsageEstimate } from './usage';

export interface UsageSource {
  estimateUsage(): Promise<UsageEstimate>;
}

export function jsonlUsageSource(opts: EstimateOptions): UsageSource {
  return { estimateUsage: () => estimateUsage(opts) };
}

const iso = (ms: number) => new Date(ms).toISOString();

export function toUsageReport(e: UsageEstimate): UsageReportPayload {
  const byModel: Record<string, number> = {};
  for (const [model, t] of Object.entries(e.byModel)) byModel[model] = t.weighted;
  return {
    estimate: true,
    windowStart: e.window ? iso(e.window.start) : null,
    windowResetAt: e.window ? iso(e.window.resetAt) : null,
    tokens: {
      input: e.tokens.input,
      output: e.tokens.output,
      cacheWrite: e.tokens.cacheWrite,
      cacheRead: e.tokens.cacheRead,
    },
    weighted: e.weighted,
    byModel,
    byProject: { personal: e.weighted },
    capacityEstimate: e.budget.usableWeighted,
    source: 'jsonl',
  };
}

export interface UsageLoopOptions {
  source: UsageSource;
  onReport: (payload: UsageReportPayload) => void;
  intervalMs: number;
  /** Delay before the first report after `start()`. */
  firstDelayMs?: number;
  logger: Logger;
}

export class UsageLoop {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private intervalMs: number;

  constructor(private readonly opts: UsageLoopOptions) {
    this.intervalMs = opts.intervalMs;
  }

  get started(): boolean {
    return this.running;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.schedule(this.opts.firstDelayMs ?? 2_000);
  }

  /** New interval, applied from the next tick. */
  setIntervalMs(ms: number): void {
    this.intervalMs = ms;
  }

  stop(): void {
    this.running = false;
    clearTimeout(this.timer);
  }

  async runOnce(): Promise<void> {
    try {
      const estimate = await this.opts.source.estimateUsage();
      this.opts.onReport(toUsageReport(estimate));
    } catch (err) {
      this.opts.logger.warn('usage estimate failed', { error: errorMessage(err) });
    }
  }

  private schedule(ms: number): void {
    this.timer = setTimeout(() => {
      void this.runOnce().finally(() => {
        if (this.running) this.schedule(this.intervalMs);
      });
    }, ms);
  }
}
