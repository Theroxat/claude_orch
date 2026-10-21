import type { Block, UsageEntry } from './types';

export const HOUR_MS = 3_600_000;
export const BLOCK_MS = 5 * HOUR_MS;

export const floorToHour = (ts: number): number => Math.floor(ts / HOUR_MS) * HOUR_MS;

/**
 * ccusage block logic: a block starts at its first entry floored to the hour (UTC) and lasts 5h.
 * A new block starts when an entry is past the block end, or more than 5h after the previous entry.
 */
export function buildBlocks(entries: UsageEntry[]): Block[] {
  const sorted = [...entries].sort((a, b) => a.timestamp - b.timestamp);
  const blocks: Block[] = [];
  let cur: Block | null = null;
  for (const e of sorted) {
    if (!cur || e.timestamp >= cur.end || e.timestamp - cur.lastEntryAt > BLOCK_MS) {
      const start = floorToHour(e.timestamp);
      cur = { start, end: start + BLOCK_MS, lastEntryAt: e.timestamp, entries: [] };
      blocks.push(cur);
    }
    cur.entries.push(e);
    cur.lastEntryAt = e.timestamp;
  }
  return blocks;
}

/** The block active at `now` (now < end and last entry less than 5h ago), or null. */
export function currentBlock(blocks: Block[], now: number): Block | null {
  const last = blocks[blocks.length - 1];
  if (!last) return null;
  if (now < last.end && now - last.lastEntryAt < BLOCK_MS && last.start <= now) return last;
  return null;
}
