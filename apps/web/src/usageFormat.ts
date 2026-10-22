/** Compact token count: 950, 12.3k, 4.1M. */
export function formatTokens(n: number): string {
  const abs = Math.abs(n);
  // Thresholds sit half a displayed unit below each power so 999_999 reads 1M, not 1000k.
  if (abs >= 999_500_000) return `${trim(n / 1e9)}B`;
  if (abs >= 999_500) return `${trim(n / 1e6)}M`;
  if (abs >= 999.5) return `${trim(n / 1e3)}k`;
  return String(Math.round(n));
}
const trim = (v: number) => (Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(1)).replace(/\.0$/, '');

/** "Oct 14" (UTC day), or "Tue, Oct 14" with `long`. */
export function formatDay(day: string, long = false): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString('en-US', {
    timeZone: 'UTC',
    month: 'short',
    day: 'numeric',
    ...(long ? { weekday: 'short' } : {}),
  });
}

export const formatPercent = (fraction: number) => `${Math.round(fraction * 100)}%`;
