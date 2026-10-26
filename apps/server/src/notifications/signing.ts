import { createHmac, randomBytes, randomUUID } from 'node:crypto';

/**
 * Outgoing generic webhooks follow the Standard Webhooks spec (https://www.standardwebhooks.com/):
 * `webhook-id`, `webhook-timestamp` (unix seconds) and `webhook-signature`, where each signature is
 * `v1,<base64 HMAC-SHA256 of "<id>.<timestamp>.<raw body>">` keyed with the bytes of `whsec_<base64>`.
 */
export const SECRET_PREFIX = 'whsec_';
/** During a rotation both the new and the previous secret sign, for this long. */
export const ROTATION_GRACE_MS = 24 * 3_600_000;

export function generateWebhookSecret(): string {
  return SECRET_PREFIX + randomBytes(32).toString('base64');
}

/** `••••abcd`: enough to tell secrets apart, useless to forge a signature. */
export function secretHint(secret: string): string {
  return `••••${secret.slice(-4)}`;
}

/** One id per delivery: every retry of that delivery reuses it, so receivers can dedupe. */
export function newWebhookId(): string {
  return `msg_${randomUUID().replaceAll('-', '')}`;
}

/**
 * The id of a queued delivery (its NotificationJob id): stable across retries, and across
 * instances when another one takes the job over, so receivers can dedupe on it.
 */
export function webhookIdOf(jobId: string): string {
  return `msg_${jobId}`;
}

export function signWebhook(secret: string, id: string, timestamp: number, body: string): string {
  const raw = secret.startsWith(SECRET_PREFIX) ? secret.slice(SECRET_PREFIX.length) : secret;
  const mac = createHmac('sha256', Buffer.from(raw, 'base64'));
  return `v1,${mac.update(`${id}.${timestamp}.${body}`).digest('base64')}`;
}

/** Signature headers for one attempt; several secrets give several space-separated signatures. */
export function webhookHeaders(
  secrets: string[],
  id: string,
  body: string,
  now = new Date(),
): Record<string, string> {
  const timestamp = Math.floor(now.getTime() / 1000);
  const headers: Record<string, string> = {
    'webhook-id': id,
    'webhook-timestamp': String(timestamp),
  };
  if (secrets.length > 0) {
    headers['webhook-signature'] = secrets
      .map((s) => signWebhook(s, id, timestamp, body))
      .join(' ');
  }
  return headers;
}
