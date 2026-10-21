import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { UsageEntry } from './types';

export interface ScanResult {
  entries: UsageEntry[];
  filesScanned: number;
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

/** Parse one jsonl line into an entry, or null if it is not a usable assistant usage record. */
export function parseLine(line: string): { entry: UsageEntry; key: string | null } | null {
  const obj: unknown = JSON.parse(line);
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj))
    throw new Error('not an object');
  const o = obj as Record<string, unknown>;
  const msg = o['message'];
  if (typeof msg !== 'object' || msg === null) return null;
  const m = msg as Record<string, unknown>;
  const usage = m['usage'];
  if (typeof usage !== 'object' || usage === null) return null;
  const u = usage as Record<string, unknown>;
  const ts = typeof o['timestamp'] === 'string' ? Date.parse(o['timestamp']) : NaN;
  if (Number.isNaN(ts)) return null;
  const model = typeof m['model'] === 'string' ? m['model'] : 'unknown';
  if (model === '<synthetic>') return null;
  const id = typeof m['id'] === 'string' ? m['id'] : null;
  const req = typeof o['requestId'] === 'string' ? o['requestId'] : null;
  // ccusage: dedupe on message.id + requestId; entries lacking a message id are never deduped.
  const key = id ? (req ? `${id}:${req}` : id) : null;
  return {
    key,
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

/**
 * Stream every `<root>/projects/**\/*.jsonl` and return deduplicated entries with
 * timestamp >= `since`. Malformed lines are counted and skipped. A missing root yields no entries.
 * Files not modified since `since` are skipped without being read.
 */
export async function scanUsage(root: string, since: number): Promise<ScanResult> {
  const seen = new Set<string>();
  const entries: UsageEntry[] = [];
  let filesScanned = 0;
  let linesSkipped = 0;
  for await (const file of walk(join(root, 'projects'))) {
    try {
      if ((await stat(file)).mtimeMs < since) continue;
    } catch {
      continue;
    }
    filesScanned++;
    const rl = createInterface({
      input: createReadStream(file, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    });
    try {
      for await (const raw of rl) {
        const line = raw.trim();
        if (!line) continue;
        try {
          const parsed = parseLine(line);
          if (!parsed) continue;
          if (parsed.entry.timestamp < since) continue;
          if (parsed.key) {
            if (seen.has(parsed.key)) continue;
            seen.add(parsed.key);
          }
          entries.push(parsed.entry);
        } catch {
          linesSkipped++;
        }
      }
    } catch {
      linesSkipped++; // unreadable file mid-stream
    }
  }
  return { entries, filesScanned, linesSkipped };
}
