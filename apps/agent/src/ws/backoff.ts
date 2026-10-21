/** Exponential backoff with FULL jitter (PLAN 4.5): delay = random() * min(max, base * 2^attempt). */

export interface BackoffOptions {
  baseMs: number;
  maxMs: number;
  /** Returns a number in [0, 1). */
  random: () => number;
}

export const DEFAULT_BACKOFF: BackoffOptions = {
  baseMs: 1_000,
  maxMs: 60_000,
  random: Math.random,
};

export function backoffCap(attempt: number, o: Pick<BackoffOptions, 'baseMs' | 'maxMs'>): number {
  return Math.min(o.maxMs, o.baseMs * 2 ** Math.min(attempt, 30));
}

export function backoffDelay(attempt: number, o: BackoffOptions): number {
  return Math.floor(o.random() * backoffCap(attempt, o));
}
