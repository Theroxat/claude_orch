/**
 * Ledger of the Claude usage of orch task runs (an ESTIMATE, PLAN 5.7).
 *
 * Task containers log to their own tmpfs config dir (`/tmp/.claude`), which the usage loop never
 * sees (it scans the member's host `~/.claude`). The executor records each run's usage entries
 * here before the container is removed, and the usage loop merges them into the 5-hour window, so
 * task runs count toward the member's overall usage and their project's share.
 *
 * One JSON line per record: `{ assignmentId, projectId, entries: UsageEntry[] }`. A later record
 * of the same assignment replaces the earlier one (a retried `orch done` re-collects everything).
 */
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import type { UsageEntry } from './types';

export const TASK_LEDGER_FILE = 'task-usage.jsonl';
/** Records older than this are dropped when the file is compacted. */
const KEEP_MS = 31 * 24 * 3_600_000;
/** Compact (rewrite without stale and replaced records) above this size. */
const COMPACT_BYTES = 512 * 1024;

export const taskLedgerPath = (dataDir: string): string => join(dataDir, TASK_LEDGER_FILE);

export interface TaskUsageRecord {
  assignmentId: string;
  projectId: string;
  entries: UsageEntry[];
}

export interface ProjectUsageEntry extends UsageEntry {
  projectId: string;
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

function parseRecordLine(line: string): TaskUsageRecord | null {
  let o: unknown;
  try {
    o = JSON.parse(line);
  } catch {
    return null;
  }
  if (!o || typeof o !== 'object') return null;
  const r = o as Record<string, unknown>;
  if (typeof r.assignmentId !== 'string' || typeof r.projectId !== 'string') return null;
  if (!Array.isArray(r.entries)) return null;
  const entries: UsageEntry[] = [];
  for (const e of r.entries as unknown[]) {
    if (!e || typeof e !== 'object') continue;
    const x = e as Record<string, unknown>;
    const timestamp = num(x.timestamp);
    if (timestamp === 0) continue;
    entries.push({
      timestamp,
      model: typeof x.model === 'string' ? x.model : 'unknown',
      input: num(x.input),
      output: num(x.output),
      cacheWrite: num(x.cacheWrite),
      cacheRead: num(x.cacheRead),
    });
  }
  return { assignmentId: r.assignmentId, projectId: r.projectId, entries };
}

/** Latest record per assignment, in file order. A missing or unreadable file is empty. */
function readRecords(file: string): TaskUsageRecord[] {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const byId = new Map<string, TaskUsageRecord>();
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    const r = parseRecordLine(line);
    if (r) {
      byId.delete(r.assignmentId);
      byId.set(r.assignmentId, r);
    }
  }
  return [...byId.values()];
}

/** Records (or replaces) the usage entries of one task run. Never throws. */
export function recordTaskUsage(file: string, rec: TaskUsageRecord, now = Date.now()): void {
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    appendFileSync(file, `${JSON.stringify(rec)}\n`, { mode: 0o600 });
    if (statSync(file).size > COMPACT_BYTES) {
      const since = now - KEEP_MS;
      const kept = readRecords(file).filter((r) => r.entries.some((e) => e.timestamp >= since));
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, kept.map((r) => `${JSON.stringify(r)}\n`).join(''), { mode: 0o600 });
      renameSync(tmp, file);
    }
  } catch {
    // Best effort: the run's usage still goes to the server in task.finished.
  }
}

/** Every recorded task usage entry at or after `since`, tagged with its project. */
export function readTaskUsage(file: string, since: number): ProjectUsageEntry[] {
  const out: ProjectUsageEntry[] = [];
  for (const r of readRecords(file)) {
    for (const e of r.entries) if (e.timestamp >= since) out.push({ ...e, projectId: r.projectId });
  }
  return out;
}
