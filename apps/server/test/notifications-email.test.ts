/** E-mail target verification: pending until the member confirms a single-use, expiring link. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Config } from '../src/config';
import { NotificationSettingsViewSchema } from '@orch/shared';
import { channelTarget, type Mailer } from '../src/notifications/service';
import { hashToken } from '../src/notifications/emailVerification';
import { FakeGithub, api, loginAs, makeApp, prisma, type TestUser } from './harness';

const noConfig = {} as Config; // the e-mail channel does not read it
let gh: FakeGithub;
let app: FastifyInstance;
const mails: Array<{ to: string; subject: string; text: string }> = [];
const mailer: Mailer = {
  sendMail: async (m) => {
    mails.push(m);
    return {};
  },
};

beforeAll(() => {
  gh = new FakeGithub();
  app = makeApp(gh, { env: { ORCH_ALLOW_ANY_GITHUB_USER: 'true' }, notify: { mailer } });
});
afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});
beforeEach(() => {
  mails.length = 0;
});

const setEmail = async (u: TestUser, email: string | null) => {
  const res = await api(app, u)('PUT', '/api/notifications/settings', { email });
  expect(res.statusCode, res.body).toBe(200);
  return NotificationSettingsViewSchema.parse(res.json());
};
const tokenOf = (m: { text: string }) => /token=([\w-]+)/.exec(m.text)![1]!;
const confirm = (u: TestUser, token: string) =>
  api(app, u)('POST', '/api/notifications/email/confirm', { token });
const row = (u: TestUser) =>
  prisma.notificationSettings.findUniqueOrThrow({ where: { userId: u.userId } });
async function resendAndGet(u: TestUser) {
  const before = mails.length;
  const res = await api(app, u)('POST', '/api/notifications/email/resend');
  expect(res.statusCode).toBe(200);
  return mails.length > before ? mails.at(-1) : undefined;
}

describe('e-mail verification', () => {
  it('stores the address as pending and sends one confirmation with a link to the web app', async () => {
    const u = await loginAs(app, gh);
    const v = await setEmail(u, 'me@example.com');
    expect(v.email).toEqual({ available: true, address: 'me@example.com', status: 'pending' });
    expect(mails).toHaveLength(1);
    expect(mails[0]!.to).toBe('me@example.com');
    expect(mails[0]!.text).toContain('http://localhost:8470/confirm-email?token=');
    // Saving the same address again sends nothing more.
    await setEmail(u, 'ME@example.com');
    expect(mails).toHaveLength(1);
  });

  it('stores only a hash of the token', async () => {
    const u = await loginAs(app, gh);
    await setEmail(u, 'hash@example.com');
    const token = tokenOf(mails[0]!);
    const r = await row(u);
    expect(r.emailTokenHash).toBe(hashToken(token));
    expect(JSON.stringify(r)).not.toContain(token);
    expect(r.emailTokenExpiresAt!.getTime()).toBeGreaterThan(Date.now() + 23 * 3_600_000);
  });

  it('sends no notification and no test mail to an unverified address', async () => {
    const u = await loginAs(app, gh);
    await setEmail(u, 'pending@example.com');
    const first = tokenOf(mails[0]!);
    mails.length = 0;
    const res = await api(app, u)('POST', '/api/notifications/test', { channel: 'email' });
    expect(res.json()).toEqual({ ok: false, error: 'email_not_verified' });
    expect(channelTarget(await row(u), 'email', noConfig, true)).toBeNull();
    expect(mails).toHaveLength(0);

    expect((await confirm(u, first)).statusCode).toBe(200);
    expect(channelTarget(await row(u), 'email', noConfig, true)).toBe('pending@example.com');
    const ok = await api(app, u)('POST', '/api/notifications/test', { channel: 'email' });
    expect(ok.json()).toEqual({ ok: true });
    expect(mails.at(-1)!.subject).toContain('Test notification');
  });

  it('confirms once: the token is single-use', async () => {
    const u = await loginAs(app, gh);
    await setEmail(u, 'once@example.com');
    const token = tokenOf(mails[0]!);
    const res = await confirm(u, token);
    expect(res.statusCode).toBe(200);
    expect(NotificationSettingsViewSchema.parse(res.json()).email.status).toBe('verified');
    expect((await row(u)).emailTokenHash).toBeNull();
    expect((await confirm(u, token)).statusCode).toBe(400);
  });

  it('refuses an expired token, a wrong token and another member', async () => {
    const u = await loginAs(app, gh);
    const other = await loginAs(app, gh);
    await setEmail(u, 'exp@example.com');
    const token = tokenOf(mails[0]!);
    expect((await confirm(other, token)).statusCode).toBe(400);
    expect((await confirm(u, 'x'.repeat(43))).statusCode).toBe(400);
    await prisma.notificationSettings.update({
      where: { userId: u.userId },
      data: { emailTokenExpiresAt: new Date(Date.now() - 1000) },
    });
    expect((await confirm(u, token)).statusCode).toBe(400);
    expect((await row(u)).emailVerifiedAt).toBeNull();
  });

  it('a GET of the link or of the API changes nothing (prefetch-safe); only the POST confirms', async () => {
    const u = await loginAs(app, gh);
    await setEmail(u, 'prefetch@example.com');
    const token = tokenOf(mails[0]!);
    await api(app, u)('GET', `/confirm-email?token=${token}`);
    const get = await api(app, u)('GET', `/api/notifications/email/confirm?token=${token}`);
    expect(get.statusCode).toBe(404);
    expect((await row(u)).emailVerifiedAt).toBeNull();
  });

  it('resend replaces the link: the old one stops working', async () => {
    const u = await loginAs(app, gh);
    await setEmail(u, 'resend@example.com');
    const first = tokenOf(mails[0]!);
    const second = tokenOf((await resendAndGet(u))!);
    expect(second).not.toBe(first);
    expect((await confirm(u, first)).statusCode).toBe(400);
    expect((await confirm(u, second)).statusCode).toBe(200);
    // Nothing to resend once verified: same generic answer, no mail.
    expect(await resendAndGet(u)).toBeUndefined();
  });

  it('changing the address resets the verification; clearing removes everything', async () => {
    const u = await loginAs(app, gh);
    await setEmail(u, 'a@example.com');
    const old = tokenOf(mails[0]!);
    await confirm(u, old);
    expect((await row(u)).emailVerifiedAt).not.toBeNull();
    const v = await setEmail(u, 'b@example.com');
    expect(v.email.status).toBe('pending');
    expect((await row(u)).emailVerifiedAt).toBeNull();
    expect(mails.at(-1)!.to).toBe('b@example.com');
    expect((await confirm(u, old)).statusCode).toBe(400);
    const cleared = await setEmail(u, '');
    expect(cleared.email).toEqual({ available: true, address: null, status: 'none' });
    expect((await row(u)).emailTokenHash).toBeNull();
  });

  it('limits confirmation e-mails to 3 per hour and 10 per day, with a generic answer', async () => {
    const u = await loginAs(app, gh);
    await setEmail(u, 'limit@example.com'); // 1
    await resendAndGet(u); // 2
    await resendAndGet(u); // 3
    const sent = mails.length;
    const res = await api(app, u)('POST', '/api/notifications/email/resend');
    expect(res.statusCode).toBe(429);
    expect(mails).toHaveLength(sent);
    // Changing the address does not dodge the limit: saved as pending, no mail.
    const v = await setEmail(u, 'other@example.com');
    expect(v.email.status).toBe('pending');
    expect(mails).toHaveLength(sent);

    // Daily: 9 sends spread over the last day, none in the last hour.
    const log = Array.from({ length: 9 }, (_, i) => new Date(Date.now() - (2 + i) * 3_600_000));
    await prisma.notificationSettings.update({
      where: { userId: u.userId },
      data: { emailSendLog: log },
    });
    expect((await resendAndGet(u))!.to).toBe('other@example.com'); // 10th
    expect((await api(app, u)('POST', '/api/notifications/email/resend')).statusCode).toBe(429);
  });
});
