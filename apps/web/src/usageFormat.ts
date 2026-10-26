import { formatDate, formatNumber } from './i18n/format.ts';
import { t } from './i18n/index.ts';

/** Compact token count: 950, 12.3k, 4.1M (12,3 k, 4,1 M in French). */
export function formatTokens(n: number): string {
  const abs = Math.abs(n);
  // Thresholds sit half a displayed unit below each power so 999_999 reads 1M, not 1000k.
  if (abs >= 999_500_000) return t('usage.units.b', { value: trim(n / 1e9) });
  if (abs >= 999_500) return t('usage.units.m', { value: trim(n / 1e6) });
  if (abs >= 999.5) return t('usage.units.k', { value: trim(n / 1e3) });
  return formatNumber(Math.round(n));
}
const trim = (v: number) => formatNumber(v, { maximumFractionDigits: Math.abs(v) >= 100 ? 0 : 1 });

/** "Oct 14" (UTC day), or "Tue, Oct 14" with `long`; in the active locale. */
export function formatDay(day: string, long = false): string {
  return formatDate(`${day}T00:00:00Z`, {
    timeZone: 'UTC',
    month: 'short',
    day: 'numeric',
    ...(long ? { weekday: 'short' } : {}),
  });
}

/** `75%` / `75 %`. */
export const formatPercent = (fraction: number) =>
  formatNumber(Math.round(fraction * 100) / 100, { style: 'percent', maximumFractionDigits: 0 });
