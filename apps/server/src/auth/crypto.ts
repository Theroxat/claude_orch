import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

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
