/**
 * Persisted Claude login state (`${dataDir}/claude-auth.json`, no secrets: `tokenHash` is the
 * sha256 of the token, never the token). Only a REAL check (`claude-check.ts`) that succeeded sets
 * `valid: true`; a check answering `unauthorized` / `no_token`, or a task failing with a
 * `claude_auth` error, sets it false. Inconclusive checks (timeout, network...) only record
 * `checkedAt` / `errorClass`. `orch login` does not touch it: the daemon checks the new token.
 * The file is re-read on every use (the CLI may run the check in another process).
 */
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ClaudeAuthErrorClass, type ClaudeAuthPayload } from '@orch/shared';
import { readJsonFile, writeJsonAtomic } from './fsutil';

export const CLAUDE_AUTH_FILE = 'claude-auth.json';

/** Prefix of the offer.reject detail; the server treats it as "not a shut-out". */
export const CLAUDE_AUTH_REJECT_PREFIX = 'claude_auth: Claude login expired: run "orch login"';

const StateSchema = z.object({
  valid: z.boolean(),
  since: z.string().optional(),
  detail: z.string().max(500).optional(),
  /** Last real check (ISO). */
  checkedAt: z.string().optional(),
  /** Error class of the last check; absent when it succeeded cleanly. */
  errorClass: ClaudeAuthErrorClass.optional(),
  /** sha256 hex of the trimmed token the last check ran with. */
  tokenHash: z.string().optional(),
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

  /** A task failed on Claude authentication. Keeps the original `since` while invalid. */
  markInvalid(detail?: string): void {
    const cur = this.read();
    if (!cur.valid) return;
    this.write({
      ...cur,
      valid: false,
      since: new Date().toISOString(),
      ...(detail ? { detail: detail.slice(0, 500) } : {}),
    });
  }

  /**
   * Records a real check. `tokenHash` is the hash of the token it ran with (null: no token).
   * Returns the new snapshot.
   */
  recordCheck(p: ClaudeAuthPayload, tokenHash: string | null): ClaudeAuthSnapshot {
    const cur = this.read();
    const common = {
      checkedAt: p.checkedAt,
      ...(p.errorClass ? { errorClass: p.errorClass } : {}),
      ...(tokenHash ? { tokenHash } : {}),
    };
    let next: ClaudeAuthSnapshot;
    if (p.valid) {
      next = { valid: true, ...common };
    } else if (p.errorClass === 'unauthorized' || p.errorClass === 'no_token') {
      next = {
        valid: false,
        since: !cur.valid && cur.since ? cur.since : p.checkedAt,
        ...(p.detail ? { detail: p.detail.slice(0, 500) } : {}),
        ...common,
      };
    } else {
      // Inconclusive: the validity is unchanged.
      next = {
        valid: cur.valid,
        ...(cur.since ? { since: cur.since } : {}),
        ...(p.detail ? { detail: p.detail.slice(0, 500) } : {}),
        ...common,
      };
    }
    this.write(next);
    return next;
  }

  private write(s: ClaudeAuthSnapshot): void {
    try {
      writeJsonAtomic(this.path, s);
    } catch {
      // best effort: a read-only data dir must not break task handling
    }
  }
}

/** sha256 hex of the trimmed token (identifies a token without storing it). */
export function hashClaudeToken(token: string): string {
  return createHash('sha256').update(token.trim()).digest('hex');
}
