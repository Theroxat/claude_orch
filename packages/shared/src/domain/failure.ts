/**
 * Failed-run classification, shared by the agent (sent as `task.finished.failureClass`) and the
 * server (fallback for agents that do not send it, e.g. v0.4.x / v0.5.0).
 *
 * - `env`: the repository setup failed before Claude ran (missing env file, compose refused or
 *   failed, devcontainer, image pull or build). The project owner has to fix the repository.
 * - `claude_auth`: the member's Claude login is invalid or expired (401, "Failed to authenticate").
 * - `rate_limited`: the member hit a Claude usage / rate limit.
 * - `timeout`: the run exceeded its S/M/L time limit.
 * - `task`: everything else (Claude ran and failed, no changes, push rejected...).
 *
 * Only `task` and `timeout` count toward the dispatcher's per-member shut-out.
 */
import { z } from 'zod';
import { redactSecrets } from '../redact';

export const FailureClass = z.enum(['env', 'claude_auth', 'rate_limited', 'timeout', 'task']);
export type FailureClass = z.infer<typeof FailureClass>;

const AUTH_RE =
  /failed to authenticate|oauth (?:access )?token (?:is |has )?(?:invalid|expired|revoked)|authentication_error|invalid (?:x-)?api[ _-]?key|\b401\b[^\n]{0,80}(?:unauthori[sz]ed|token|auth)|no claude token|please run \/login/i;
const RATE_RE =
  /^rate limited:|usage limit|limit reached|hit your (?:\w+ )?limit|rate[ _-]?limit|too many requests|\b429\b/i;
const TIMEOUT_RE = /^timed out after\b|\btimed out after \d+ ?min/i;
/** Messages produced once Claude ran (or after it): never a setup problem. */
const AFTER_RUN_RE = /^(?:claude exited\b|push failed\b|no changes\b|no_changes$)/i;
const ENV_RE =
  /env file \S+ not found|^sidecars \(|docker compose\b[^\n]*failed|compose[^\n]{0,40}refus|refusing (?:the )?compose|devcontainer|failed to solve|docker build\b[^\n]*failed|pull access denied|manifest (?:for \S+ )?(?:unknown|not found)|error pulling image|image \S+ not found|no such image/i;

/** Classifies the error text of a FAILED run. A missing / empty error is a `task` failure. */
export function classifyFailure(error: string | null | undefined): FailureClass {
  const e = (error ?? '').trim();
  if (!e) return 'task';
  if (AUTH_RE.test(e)) return 'claude_auth';
  if (RATE_RE.test(e)) return 'rate_limited';
  if (TIMEOUT_RE.test(e)) return 'timeout';
  if (AFTER_RUN_RE.test(e)) return 'task';
  if (ENV_RE.test(e)) return 'env';
  return 'task';
}

/** Failure classes that count toward the per-member shut-out (and its backoff). */
export const SHUT_OUT_FAILURE_CLASSES: readonly FailureClass[] = ['task', 'timeout'];

/** Absolute host paths (2+ segments, not part of a URL): only the last segment is kept. */
const ABS_PATH_RE = /(?<![\w:/.~-])(?:\/[\w.@+-]+){2,}\/?/g;

/**
 * A failed run's error, safe to show to the project's members: secrets redacted, absolute host
 * paths shortened to their last segment, whitespace collapsed, truncated to `max` characters.
 */
export function summarizeFailure(error: string | null | undefined, max = 300): string {
  const s = redactSecrets(error ?? '')
    .replace(ABS_PATH_RE, (p) => p.replace(/\/$/, '').split('/').pop() ?? p)
    .replace(/\s+/g, ' ')
    .trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
