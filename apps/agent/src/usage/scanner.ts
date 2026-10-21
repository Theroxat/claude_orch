import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { parseRateLimit } from './ratelimit';
import type { CachedFile, KeyedEntry, RateLimitEvent, UsageCache, UsageEntry } from './types';

export interface ScanResult {
  entries: UsageEntry[];
  rateLimits: RateLimitEvent[];
  /** Files considered (mtime inside the window), whether parsed or served from the cache. */
  filesScanned: number;
  /** Files actually read and parsed this run. */
  filesParsed: number;
  linesSkipped: number;
}

async function* walk(dir: string): AsyncGenerator<string> {
  let items;
  try {
    items = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const it of items) {
    const p = join(dir, it.name);
    if (it.isDirectory()) yield* walk(p);
    else if (it.isFile() && it.name.endsWith('.jsonl')) yield p;
  }
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

export interface ParsedLine {
  entry: UsageEntry | null;
  key: string | null;
  rateLimit: RateLimitEvent | null;
}

/** Parse one jsonl line. Throws on invalid JSON; returns null when the line carries nothing usable. */
export function parseRecord(line: string): ParsedLine | null {
  const obj: unknown = JSON.parse(line);
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj))
    throw new Error('not an object');
  const o = obj as Record<string, unknown>;
  const ts = typeof o['timestamp'] === 'string' ? Date.parse(o['timestamp']) : NaN;
  if (Number.isNaN(ts)) return null;
  const rateLimit = parseRateLimit(o, ts);
  const msg = o['message'];
  if (typeof msg !== 'object' || msg === null)
    return rateLimit && { entry: null, key: null, rateLimit };
  const m = msg as Record<string, unknown>;
  const usage = m['usage'];
  const model = typeof m['model'] === 'string' ? m['model'] : 'unknown';
  if (typeof usage !== 'object' || usage === null || model === '<synthetic>')
    return rateLimit && { entry: null, key: null, rateLimit };
  const u = usage as Record<string, unknown>;
  const id = typeof m['id'] === 'string' ? m['id'] : null;
  const req = typeof o['requestId'] === 'string' ? o['requestId'] : null;
  // ccusage: dedupe on message.id + requestId; entries lacking a message id are never deduped.
  const key = id ? (req ? `${id}:${req}` : id) : null;
  return {
    key,
    rateLimit,
    entry: {
      timestamp: ts,
      model,
      input: num(u['input_tokens']),
      output: num(u['output_tokens']),
      cacheWrite: num(u['cache_creation_input_tokens']),
      cacheRead: num(u['cache_read_input_tokens']),
    },
  };
}

/** Parse one jsonl line into an entry, or null if it is not a usable assistant usage record. */
export function parseLine(line: string): { entry: UsageEntry; key: string | null } | null {
  const r = parseRecord(line);
  return r?.entry ? { entry: r.entry, key: r.key } : null;
}

async function parseFile(
  file: string,
  since: number,
  mtimeMs: number,
  size: number,
): Promise<CachedFile> {
  const entries: KeyedEntry[] = [];
  const rateLimits: RateLimitEvent[] = [];
  let linesSkipped = 0;
  const rl = createInterface({
    input: createReadStream(file, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  try {
    for await (const raw of rl) {
      const line = raw.trim();
      if (!line) continue;
      try {
        const p = parseRecord(line);
        if (!p) continue;
        if (p.entry && p.entry.timestamp >= since) entries.push({ key: p.key, entry: p.entry });
        if (p.rateLimit && p.rateLimit.at >= since) rateLimits.push(p.rateLimit);
      } catch {
        linesSkipped++;
      }
    }
  } catch {
    linesSkipped++; // unreadable file mid-stream
  }
  return { mtimeMs, size, since, entries, rateLimits, linesSkipped };
}

export const createUsageCache = (): UsageCache => new Map();

/**
 * Stream every `<root>/projects/**\/*.jsonl` and return deduplicated entries with
 * timestamp >= `since`. Malformed lines are counted and skipped. A missing root yields no entries.
 * Files not modified since `since` are skipped without being read; with a `cache`, files whose
 * mtime and size are unchanged are not re-read at all.
 */
export async function scanUsage(
  root: string,
  since: number,
  cache?: UsageCache,
): Promise<ScanResult> {
  const seen = new Set<string>();
  const entries: UsageEntry[] = [];
  const rateLimits: RateLimitEvent[] = [];
  const live = new Set<string>();
  let filesScanned = 0;
  let filesParsed = 0;
  let linesSkipped = 0;
  for await (const file of walk(join(root, 'projects'))) {
    let st;
    try {
      st = await stat(file);
    } catch {
      continue;
    }
    if (st.mtimeMs < since) continue;
    filesScanned++;
    live.add(file);
    let c = cache?.get(file);
    if (!c || c.mtimeMs !== st.mtimeMs || c.size !== st.size || c.since > since) {
      c = await parseFile(file, since, st.mtimeMs, st.size);
      filesParsed++;
      cache?.set(file, c);
    }
    linesSkipped += c.linesSkipped;
    rateLimits.push(...c.rateLimits.filter((r) => r.at >= since));
    for (const { key, entry } of c.entries) {
      if (entry.timestamp < since) continue;
      if (key) {
        if (seen.has(key)) continue;
        seen.add(key);
      }
      entries.push(entry);
    }
  }
  if (cache) for (const k of cache.keys()) if (!live.has(k)) cache.delete(k);
  return { entries, rateLimits, filesScanned, filesParsed, linesSkipped };
}
