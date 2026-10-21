/**
 * Containment checks for paths taken from a task clone (devcontainer, Dockerfile, compose). Both
 * the root and the target are resolved with realpath, so a symlink in the repo cannot point the
 * agent (or the docker CLI it drives) at a file outside the clone.
 */
import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

/**
 * Real path of `p`: the longest existing prefix is resolved with realpath and the missing rest
 * is appended (docker creates missing bind sources, so they may not exist yet).
 */
export function realPathLoose(p: string): string {
  const abs = resolve(p);
  if (existsSync(abs)) return realpathSync(abs);
  const parent = dirname(abs);
  if (parent === abs) return abs;
  return join(realPathLoose(parent), basename(abs));
}

/** True when `p` (resolved through symlinks) is `root` or inside it. */
export function isInside(root: string, p: string): boolean {
  const rel = relative(realPathLoose(root), realPathLoose(p));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * Resolves `p` against `base` and returns its real path when it stays inside `root`, else null.
 */
export function resolveInside(root: string, base: string, p: string): string | null {
  const abs = resolve(base, p);
  if (!isInside(root, abs)) return null;
  return realPathLoose(abs);
}
