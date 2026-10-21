/** Filesystem operations on the work dir (behind an interface so tests can observe them). */
import { lchownSync, readdirSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';

export interface WorkspaceFs {
  mkdir(path: string): void;
  exists(path: string): boolean;
  writeFile(path: string, data: string): void;
  /** Recursive chown so the non-root task user owns its clone. */
  chownR(path: string, uid: number, gid: number): void;
  remove(path: string): Promise<void>;
}

function chownTree(path: string, uid: number, gid: number): void {
  lchownSync(path, uid, gid);
  let entries;
  try {
    entries = readdirSync(path, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = join(path, e.name);
    if (e.isDirectory()) chownTree(p, uid, gid);
    else lchownSync(p, uid, gid);
  }
}

export const nodeWorkspaceFs: WorkspaceFs = {
  mkdir: (p) => void mkdirSync(p, { recursive: true, mode: 0o755 }),
  exists: (p) => existsSync(p),
  writeFile: (p, d) => writeFileSync(p, d, { mode: 0o644 }),
  chownR: (p, uid, gid) => {
    // Only root can give files away; as the same uid this is a no-op.
    if (process.getuid?.() === 0 || process.getuid?.() === uid) chownTree(p, uid, gid);
  },
  remove: (p) => rm(p, { recursive: true, force: true }),
};
