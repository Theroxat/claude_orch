export const POLL_MS = 15_000;

/** "in 2h 5m" / "5m ago" / "now". */
export function relative(iso: string, now: number = Date.now()): string {
  const diff = new Date(iso).getTime() - now;
  const abs = Math.abs(diff);
  const m = Math.floor(abs / 60_000);
  if (m < 1) return 'now';
  const h = Math.floor(m / 60);
  const text = h > 0 ? `${h}h ${m % 60}m` : `${m}m`;
  return diff >= 0 ? `in ${text}` : `${text} ago`;
}

/** "4:05" style countdown, "expired" once past. */
export function countdown(iso: string, now: number = Date.now()): string {
  const s = Math.floor((new Date(iso).getTime() - now) / 1000);
  if (s <= 0) return 'expired';
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}
