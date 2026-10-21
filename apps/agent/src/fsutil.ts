import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeSync,
} from 'node:fs';
import { dirname } from 'node:path';
import type { z } from 'zod';

/** Writes `data` to a temp file in the same directory, fsyncs it, then renames it over `path`. */
export function writeFileAtomic(path: string, data: string, mode = 0o600): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  const fd = openSync(tmp, 'wx', mode);
  try {
    writeSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  chmodSync(tmp, mode);
  renameSync(tmp, path);
}

export function writeJsonAtomic(path: string, value: unknown, mode = 0o600): void {
  writeFileAtomic(path, JSON.stringify(value), mode);
}

/**
 * Reads and validates a JSON file. Missing file -> `fallback`. A corrupt file is moved aside
 * (`<path>.corrupt-<ts>`) so it is not silently overwritten, then `fallback` is returned.
 */
export function readJsonFile<T>(
  path: string,
  schema: z.ZodType<T>,
  fallback: () => T,
  onCorrupt?: (movedTo: string) => void,
): T {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return fallback();
    throw err;
  }
  try {
    const parsed = schema.safeParse(JSON.parse(raw));
    if (parsed.success) return parsed.data;
  } catch {
    // fall through
  }
  const movedTo = `${path}.corrupt-${Date.now()}`;
  renameSync(path, movedTo);
  onCorrupt?.(movedTo);
  return fallback();
}
