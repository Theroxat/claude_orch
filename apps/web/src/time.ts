import { t } from './i18n/index.ts';

export const POLL_MS = 15_000;

/** "in 2h 5m" / "5m ago" / "now" (in the active locale: "dans 2 h 5 min"). */
export function relative(iso: string, now: number = Date.now()): string {
  const diff = new Date(iso).getTime() - now;
  const abs = Math.abs(diff);
  const m = Math.floor(abs / 60_000);
  if (m < 1) return t('common.time.now');
  const h = Math.floor(m / 60);
  const duration =
    h > 0 ? t('common.time.hoursMinutes', { h, m: m % 60 }) : t('common.time.minutes', { m });
  return diff >= 0 ? t('common.time.in', { duration }) : t('common.time.ago', { duration });
}

/** "4:05" style countdown, "expired" once past. */
export function countdown(iso: string, now: number = Date.now()): string {
  const s = Math.floor((new Date(iso).getTime() - now) / 1000);
  if (s <= 0) return t('common.time.expired');
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}
