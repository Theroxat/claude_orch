/**
 * Failed runs (v0.5.1): what each failure class means for the dispatcher.
 *
 * - `task` / `timeout`: count toward the per-member backoff and the 24 h shut-out.
 * - `env` (repository setup): per-member backoff, never the shut-out; after
 *   ENV_FAILURES_BEFORE_ATTENTION of them the task is marked `needsAttention` and is not offered
 *   until the owner or the creator retries it.
 * - `claude_auth`: the agent is flagged (`claudeAuthValid = false`) and gets no offer until the
 *   agent's real Claude check passes (`claude.auth` valid, after `orch login`) or a run succeeds
 *   (a reported `claudeAuthValid: true` in hello/usage.report never clears it); the task is not held against the member.
 * - `rate_limited`: the member's `rateLimitedUntil` is set; nothing is held against the member.
 *
 * Failures (FAILED and LOST runs) that ended before the task's `retryResetAt` are ignored.
 */
import { FailureClass, classifyFailure, summarizeFailure } from '@orch/shared';

export const ENV_FAILURES_BEFORE_ATTENTION = 3;
/** Rate limit without a reset time in the message: assume this long. */
export const RATE_LIMIT_FALLBACK_MS = 30 * 60_000;

/** Prefix of the agent's local refusal while its Claude login is invalid (offer.reject detail). */
export const CLAUDE_AUTH_REJECT_PREFIX = 'error: claude_auth';

export function failureClassOf(a: {
  failureClass: string | null;
  reason: string | null;
}): FailureClass {
  const parsed = FailureClass.safeParse(a.failureClass);
  // Rows written before v0.5.1 have no class: classify their stored reason.
  return parsed.success ? parsed.data : classifyFailure(a.reason);
}

/** True when the failure is older than the task's last retry (ignored by the dispatcher). */
export function beforeRetry(
  a: { finishedAt: Date | null; updatedAt: Date },
  retryResetAt: Date | null,
): boolean {
  if (!retryResetAt) return false;
  return (a.finishedAt ?? a.updatedAt).getTime() <= retryResetAt.getTime();
}

/** The `needsAttention` reason after repeated env failures, safe to show to every member. */
export function attentionReason(lastError: string | null): string {
  const s = summarizeFailure(lastError, 240);
  const env = /env file (\S+) not found/i.exec(s)?.[1];
  if (env) {
    return `Repo setup failed: env file ${env} not found: commit a ${env}.example (or mark it "required: false").`;
  }
  return `Repo setup failed: ${s || 'unknown error'}`;
}
