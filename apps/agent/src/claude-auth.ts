/**
 * Persisted Claude login state (`${dataDir}/claude-auth.json`, no secrets). It is set invalid when
 * a task fails with a `claude_auth` error (expired / revoked OAuth token) and reset by `orch login`.
 * `orch login` runs as a separate process in the same container, so the file is re-read on every
 * check instead of being cached: the running daemon notices a fresh login on its next hello,
 * usage report, offer or `orch take`.
 */
import { join } from 'node:path';
import { z } from 'zod';
import { readJsonFile, writeJsonAtomic } from './fsutil';

export const CLAUDE_AUTH_FILE = 'claude-auth.json';

/** Prefix of the offer.reject detail; the server treats it as "not a shut-out". */
export const CLAUDE_AUTH_REJECT_PREFIX = 'claude_auth: Claude login expired: run "orch login"';

const StateSchema = z.object({
  valid: z.boolean(),
  since: z.string().optional(),
  detail: z.string().max(500).optional(),
});
export type ClaudeAuthSnapshot = z.infer<typeof StateSchema>;

export class ClaudeAuthState {
  private readonly path: string;

  constructor(dataDir: string) {
    this.path = join(dataDir, CLAUDE_AUTH_FILE);
  }

  /** Current state; a missing, unreadable or corrupt file means "valid". */
  read(): ClaudeAuthSnapshot {
    try {
      return readJsonFile(this.path, StateSchema, () => ({ valid: true }));
    } catch {
      return { valid: true };
    }
  }

  isValid(): boolean {
    return this.read().valid;
  }

  /** Keeps the original `since` while the state stays invalid. */
  markInvalid(detail?: string): void {
    const cur = this.read();
    if (!cur.valid) return;
    this.write({
      valid: false,
      since: new Date().toISOString(),
      ...(detail ? { detail: detail.slice(0, 500) } : {}),
    });
  }

  markValid(): void {
    if (this.read().valid) return;
    this.write({ valid: true });
  }

  private write(s: ClaudeAuthSnapshot): void {
    try {
      writeJsonAtomic(this.path, s);
    } catch {
      // best effort: a read-only data dir must not break task handling
    }
  }
}
