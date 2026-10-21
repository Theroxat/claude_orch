import type { RateLimitEvent } from './types';

const LIMIT_RE =
  /usage limit|limit reached|hit your (?:\w+ )?limit|rate[ _-]?limit|too many requests|\b429\b/i;

/** Offset (ms) of `tz` from UTC at instant `at`. Throws on an unknown zone. */
function tzOffsetMs(tz: string, at: number): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  }).formatToParts(new Date(at));
  const g = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second')) - at;
}

/** Next instant after `after` whose wall clock in `tz` (UTC when omitted) reads hh:mm. */
function nextWallClock(after: number, hh: number, mm: number, tz: string | null): number {
  const off = (t: number) => (tz ? tzOffsetMs(tz, t) : 0);
  const local = after + off(after);
  const d = new Date(local);
  for (let add = 0; add <= 2; add++) {
    const wall = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + add, hh, mm);
    const guess = wall - off(wall - off(after));
    if (guess > after) return guess;
  }
  return after;
}

/**
 * Reset time (epoch ms) from a limit message, or null. Handles
 *  - `Claude AI usage limit reached|1760000000` (epoch seconds, or ms),
 *  - `... resets 3pm`, `resets 3:30pm (Europe/Paris)`, `resets at 15:00`.
 */
export function parseResetTime(text: string, at: number): number | null {
  const epoch = /limit reached\s*\|\s*(\d{9,13})\b/i.exec(text);
  if (epoch?.[1]) {
    const n = Number(epoch[1]);
    return n < 1e12 ? n * 1000 : n;
  }
  const m =
    /resets?(?:\s+at)?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?:\s*\(([A-Za-z_]+(?:\/[A-Za-z_+-]+)*)\))?/i.exec(
      text,
    );
  if (!m?.[1]) return null;
  let hh = Number(m[1]);
  const mm = m[2] ? Number(m[2]) : 0;
  const mer = m[3]?.toLowerCase();
  if (mer === 'pm' && hh < 12) hh += 12;
  if (mer === 'am' && hh === 12) hh = 0;
  if (hh > 23 || mm > 59) return null;
  try {
    return nextWallClock(at, hh, mm, m[4] ?? null);
  } catch {
    return null; // unknown time zone
  }
}

/**
 * Detects a rate-limit / usage-limit error record. Only API-error records are considered
 * (`isApiErrorMessage`, or a top-level `error` of `rate_limit`), never ordinary conversation text.
 */
export function parseRateLimit(o: Record<string, unknown>, at: number): RateLimitEvent | null {
  const errField = typeof o['error'] === 'string' ? o['error'] : '';
  if (o['isApiErrorMessage'] !== true && !/rate_limit/i.test(errField)) return null;
  const msg = o['message'];
  let text = '';
  if (typeof msg === 'object' && msg !== null) {
    const c = (msg as Record<string, unknown>)['content'];
    if (typeof c === 'string') text = c;
    else if (Array.isArray(c))
      for (const b of c) {
        const t = (b as Record<string, unknown> | null)?.['text'];
        if (typeof t === 'string') text += `${t}\n`;
      }
  }
  if (!LIMIT_RE.test(text) && !/rate_limit/i.test(errField)) return null;
  return { at, resetAt: parseResetTime(text, at) };
}
