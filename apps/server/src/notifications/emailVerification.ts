import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { PrismaClient } from '../db';

/** A confirmation link is valid for 24 hours and for one use. */
export const TOKEN_TTL_MS = 24 * 3_600_000;
export const SEND_LIMIT_PER_HOUR = 3;
export const SEND_LIMIT_PER_DAY = 10;

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function newToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashToken(token) };
}

/** Constant-time comparison of two digests. */
export function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Send times still inside the 24 h window. */
export function recentSends(log: Date[], now: Date): Date[] {
  const since = now.getTime() - 86_400_000;
  return log.filter((t) => t.getTime() > since);
}

export function overLimit(log: Date[], now: Date): boolean {
  const recent = recentSends(log, now);
  const lastHour = recent.filter((t) => t.getTime() > now.getTime() - 3_600_000).length;
  return lastHour >= SEND_LIMIT_PER_HOUR || recent.length >= SEND_LIMIT_PER_DAY;
}

export function confirmationMessage(link: string) {
  return {
    subject: '[orch] Confirm your e-mail address',
    text: [
      'Someone (hopefully you) asked orch to send notifications to this address.',
      '',
      'To confirm it, open this link and press "Confirm":',
      link,
      '',
      'The link works once and expires in 24 hours. If this was not you, ignore this e-mail:',
      'nothing is sent to this address unless it is confirmed.',
    ].join('\n'),
  };
}

export type Issued = { ok: true; token: string; email: string } | { ok: false };

/**
 * Starts a verification: stores the hash of a fresh token (which invalidates any earlier link)
 * and counts the send, unless the per-user limits are reached. The caller e-mails the token.
 */
export async function issueToken(
  prisma: PrismaClient,
  userId: string,
  now = new Date(),
): Promise<Issued> {
  const s = await prisma.notificationSettings.findUnique({ where: { userId } });
  if (!s?.email || s.emailVerifiedAt) return { ok: false };
  if (overLimit(s.emailSendLog, now)) return { ok: false };
  const { token, hash } = newToken();
  // Conditional on the row we read: two parallel resends cannot both slip under the limit.
  const r = await prisma.notificationSettings.updateMany({
    where: { userId, updatedAt: s.updatedAt },
    data: {
      emailTokenHash: hash,
      emailTokenExpiresAt: new Date(now.getTime() + TOKEN_TTL_MS),
      emailSendLog: [...recentSends(s.emailSendLog, now), now],
    },
  });
  return r.count === 1 ? { ok: true, token, email: s.email } : { ok: false };
}

/** Confirms the pending address when `token` matches; single use. */
export async function confirmToken(
  prisma: PrismaClient,
  userId: string,
  token: string,
  now = new Date(),
): Promise<boolean> {
  const s = await prisma.notificationSettings.findUnique({ where: { userId } });
  const given = hashToken(token);
  if (!s?.email || s.emailVerifiedAt || !s.emailTokenHash || !s.emailTokenExpiresAt) return false;
  if (!sameHash(s.emailTokenHash, given) || s.emailTokenExpiresAt <= now) return false;
  // Atomic: a token (and the address it was issued for) can be spent only once.
  const r = await prisma.notificationSettings.updateMany({
    where: { userId, emailTokenHash: s.emailTokenHash, email: s.email, emailVerifiedAt: null },
    data: { emailVerifiedAt: now, emailTokenHash: null, emailTokenExpiresAt: null },
  });
  return r.count === 1;
}
