import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

/** AES-256-GCM. Output layout: iv(12) | tag(16) | ciphertext. */
export function encrypt(plain: string, keyB64: string): Uint8Array<ArrayBuffer> {
  const key = Buffer.from(keyB64, 'base64');
  if (key.length !== 32) throw new Error('ORCH_ENCRYPTION_KEY must be 32 bytes, base64');
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return new Uint8Array(Buffer.concat([iv, c.getAuthTag(), enc]));
}

export function decrypt(blob: Uint8Array, keyB64: string): string {
  const key = Buffer.from(keyB64, 'base64');
  const b = Buffer.from(blob);
  const d = createDecipheriv('aes-256-gcm', key, b.subarray(0, 12));
  d.setAuthTag(b.subarray(12, 28));
  return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
}

export function sha256Hex(v: string): string {
  return createHash('sha256').update(v).digest('hex');
}

export function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

/** A sub-key of the server secret for one purpose (HKDF-SHA256), so one key never signs two kinds. */
function subKey(secretB64: string, purpose: string): Buffer {
  return Buffer.from(
    hkdfSync('sha256', Buffer.from(secretB64, 'base64'), '', `orch:${purpose}`, 32),
  );
}

/** `base64url(JSON payload).base64url(HMAC-SHA256)`, with an `exp` (epoch ms) inside. */
export function signToken(
  secretB64: string,
  purpose: string,
  payload: Record<string, unknown>,
  ttlMs: number,
): string {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Date.now() + ttlMs })).toString(
    'base64url',
  );
  const mac = createHmac('sha256', subKey(secretB64, purpose)).update(body).digest('base64url');
  return `${body}.${mac}`;
}

/** The payload of a token from signToken, or null when forged, for another purpose or expired. */
export function verifyToken(
  secretB64: string,
  purpose: string,
  token: unknown,
): Record<string, unknown> | null {
  if (typeof token !== 'string' || token.length > 4096) return null;
  const [body, mac, extra] = token.split('.');
  if (!body || !mac || extra !== undefined) return null;
  const expected = createHmac('sha256', subKey(secretB64, purpose)).update(body).digest();
  const given = Buffer.from(mac, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as unknown;
    if (!p || typeof p !== 'object') return null;
    const exp = (p as { exp?: unknown }).exp;
    if (typeof exp !== 'number' || exp <= Date.now()) return null;
    return p as Record<string, unknown>;
  } catch {
    return null;
  }
}
