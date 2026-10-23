/**
 * Web Push channel: subscribe/unsubscribe API, delivery through the Notifier (preferences, retries,
 * recipient check), expired-subscription cleanup, endpoint validation, VAPID configuration.
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import webpush from 'web-push';
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  NotificationSettingsViewSchema,
  ProjectViewSchema,
  PushStatusSchema,
  SendTestNotificationResponseSchema,
  type NotificationPreferences,
} from '@orch/shared';
import { loadConfig } from '../src/config';
import { createPushSender, validatePushEndpoint, PushError } from '../src/notifications/push';
import type { PushPayload, PushTarget } from '../src/notifications/push';
import { pushPayload } from '../src/notifications/service';
import { FakeGithub, api, loginAs, makeApp, prisma, repoFor, uid, type TestUser } from './harness';

const vapid = webpush.generateVAPIDKeys();
const FCM = 'https://fcm.googleapis.com/fcm/send/';
// Random per run: fixed-looking key material would trip the secret scanner.
const KEYS = {
  p256dh: randomBytes(65).toString('base64url'),
  auth: randomBytes(16).toString('base64url'),
};

let gh: FakeGithub;
let app: FastifyInstance;
let noPushApp: FastifyInstance;

const sent: Array<{ target: PushTarget; payload: PushPayload }> = [];
/** Next outcomes of the fake push service: undefined = delivered, a number = HTTP status. */
let replies: Array<number | undefined> = [];
const pusher = vi.fn(async (target: PushTarget, payload: PushPayload) => {
  sent.push({ target, payload });
  const r = replies.shift();
  if (r !== undefined) throw new PushError(`HTTP ${r}`, r);
});

beforeAll(async () => {
  gh = new FakeGithub();
  const env = {
    NOTIFY_RETRY_BASE_MS: '5',
    NOTIFY_MAX_ATTEMPTS: '3',
    ORCH_ALLOW_ANY_GITHUB_USER: 'true',
  };
  app = makeApp(gh, {
    env: {
      ...env,
      VAPID_PUBLIC_KEY: vapid.publicKey,
      VAPID_PRIVATE_KEY: vapid.privateKey,
      VAPID_SUBJECT: 'mailto:admin@example.com',
    },
    notify: { pusher },
  });
  noPushApp = makeApp(gh, { env });
  await app.ready();
  await noPushApp.ready();
});
afterAll(async () => {
  await app.close();
  await noPushApp.close();
  await prisma.$disconnect();
});
beforeEach(() => {
  sent.length = 0;
  replies = [];
  pusher.mockClear();
});

const endpoint = () => `${FCM}${uid()}`;
const subscribe = (u: TestUser, ep: string, a: FastifyInstance = app) =>
  api(a, u)('POST', '/api/notifications/push/subscribe', { endpoint: ep, keys: KEYS });
const view = async (u: TestUser, a: FastifyInstance = app) =>
  NotificationSettingsViewSchema.parse(
    (await api(a, u)('GET', '/api/notifications/settings')).json(),
  );
const setPush = async (
  u: TestUser,
  events: Array<keyof NotificationPreferences> = ['task_done'],
) => {
  const preferences = { ...DEFAULT_NOTIFICATION_PREFERENCES } as NotificationPreferences;
  for (const e of events) preferences[e] = ['in_app', 'push'];
  const res = await api(app, u)('PUT', '/api/notifications/settings', { preferences });
  expect(res.statusCode, res.body).toBe(200);
};
const draft = (over: Record<string, unknown> = {}) => ({
  event: 'task_done' as const,
  title: 'Task done',
  body: 'acme/api#1 merged',
  url: 'https://github.com/acme/api/pull/1',
  projectId: null,
  taskId: 'task_1',
  ...over,
});
const subs = (userId: string) => prisma.pushSubscription.findMany({ where: { userId } });

describe('settings view', () => {
  it('exposes the VAPID public key and the subscription count; unavailable without keys', async () => {
    const u = await loginAs(app, gh);
    expect((await view(u)).push).toEqual({
      available: true,
      publicKey: vapid.publicKey,
      subscriptions: 0,
    });
    await subscribe(u, endpoint());
    expect((await view(u)).push.subscriptions).toBe(1);

    const v = await loginAs(noPushApp, gh);
    expect((await view(v, noPushApp)).push).toEqual({
      available: false,
      publicKey: null,
      subscriptions: 0,
    });
  });
});

describe('subscribe / unsubscribe', () => {
  it('stores a subscription, is idempotent per endpoint, and unsubscribes', async () => {
    const u = await loginAs(app, gh);
    const ep = endpoint();
    const first = await subscribe(u, ep);
    expect(first.statusCode, first.body).toBe(200);
    expect(PushStatusSchema.parse(first.json())).toEqual({ subscriptions: 1 });
    expect(PushStatusSchema.parse((await subscribe(u, ep)).json())).toEqual({ subscriptions: 1 });
    const stored = await subs(u.userId);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ endpoint: ep, ...KEYS });

    const gone = await api(app, u)('POST', '/api/notifications/push/unsubscribe', { endpoint: ep });
    expect(PushStatusSchema.parse(gone.json())).toEqual({ subscriptions: 0 });
    expect(await subs(u.userId)).toHaveLength(0);
  });

  it('requires a session', async () => {
    const res = await subscribe(null as unknown as TestUser, endpoint());
    expect(res.statusCode).toBe(401);
  });

  it('refuses when the server has no VAPID keys', async () => {
    const u = await loginAs(noPushApp, gh);
    const res = await subscribe(u, endpoint(), noPushApp);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('push_not_configured');
  });

  it.each([
    ['http://fcm.googleapis.com/fcm/send/x', 'http'],
    ['https://example.com/push/x', 'unknown host'],
    ['https://127.0.0.1/x', 'loopback'],
    ['https://169.254.169.254/latest', 'metadata'],
    ['https://fcm.googleapis.com.evil.example/x', 'look-alike host'],
    ['https://user:pw@fcm.googleapis.com/x', 'credentials'],
    ['not a url', 'garbage'],
  ])('refuses endpoint %s (%s)', async (ep) => {
    const u = await loginAs(app, gh);
    const res = await subscribe(u, ep);
    expect(res.statusCode).toBe(400);
    expect(await subs(u.userId)).toHaveLength(0);
  });

  it('rejects malformed keys', async () => {
    const u = await loginAs(app, gh);
    const res = await api(app, u)('POST', '/api/notifications/push/subscribe', {
      endpoint: endpoint(),
      keys: { p256dh: 'not base64!', auth: '' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('moves an endpoint to the member who signed in on that browser last', async () => {
    const a = await loginAs(app, gh);
    const b = await loginAs(app, gh);
    const ep = endpoint();
    await subscribe(a, ep);
    await subscribe(b, ep);
    expect(await subs(a.userId)).toHaveLength(0);
    expect(await subs(b.userId)).toHaveLength(1);
    // The previous owner cannot remove it any more.
    await api(app, a)('POST', '/api/notifications/push/unsubscribe', { endpoint: ep });
    expect(await subs(b.userId)).toHaveLength(1);
  });

  it('keeps at most 10 browsers per member, dropping the oldest', async () => {
    const u = await loginAs(app, gh);
    const eps: string[] = [];
    for (let i = 0; i < 12; i++) {
      eps.push(endpoint());
      await subscribe(u, eps[i]!);
      await new Promise((r) => setTimeout(r, 3));
    }
    const left = (await subs(u.userId)).map((s) => s.endpoint);
    expect(left).toHaveLength(10);
    expect(left).not.toContain(eps[0]);
    expect(left).toContain(eps[11]);
  });
});

describe('delivery', () => {
  it('pushes to every browser of a member who selected the channel, with an app path', async () => {
    const u = await loginAs(app, gh);
    const e1 = endpoint();
    const e2 = endpoint();
    await subscribe(u, e1);
    await subscribe(u, e2);
    await setPush(u);
    await app.notifier.notify(u.userId, draft());
    await app.notifier.idle();
    expect(sent.map((s) => s.target.endpoint).sort()).toEqual([e1, e2].sort());
    expect(sent[0]!.payload).toMatchObject({
      title: 'Task done',
      body: 'acme/api#1 merged',
      url: '/backlog?task=task_1', // the PR is external: the app opens the task instead
    });
    expect(sent[0]!.target).toMatchObject(KEYS);
    expect((await subs(u.userId))[0]!.lastUsedAt).not.toBeNull();
  });

  it('keeps app paths and never forwards an external URL', () => {
    const base = { ...draft(), id: 'n1', link: null, createdAt: new Date() };
    expect(pushPayload({ ...base, url: '/requests' }).url).toBe('/requests');
    expect(pushPayload({ ...base, url: 'https://evil.example/x', taskId: null }).url).toBeNull();
  });

  it('follows the preferences: only the selected events, nothing by default', async () => {
    const u = await loginAs(app, gh);
    await subscribe(u, endpoint());
    await app.notifier.notify(u.userId, draft());
    await app.notifier.idle();
    expect(sent).toHaveLength(0); // default preferences: in-app only

    await setPush(u, ['task_failed']);
    await app.notifier.notify(u.userId, draft()); // task_done: not selected
    await app.notifier.notify(u.userId, draft({ event: 'task_failed', title: 'Run failed' }));
    await app.notifier.idle();
    expect(sent.map((s) => s.payload.title)).toEqual(['Run failed']);
  });

  it('does nothing for a member without browsers, or when the server has no VAPID keys', async () => {
    const u = await loginAs(app, gh);
    await setPush(u);
    await app.notifier.notify(u.userId, draft());
    await app.notifier.idle();
    expect(sent).toHaveLength(0);

    const v = await loginAs(noPushApp, gh);
    await prisma.pushSubscription.create({
      data: { userId: v.userId, endpoint: endpoint(), ...KEYS },
    });
    await prisma.notificationSettings.create({
      data: { userId: v.userId, preferences: { task_done: ['push'] } },
    });
    await noPushApp.notifier.notify(v.userId, draft());
    await noPushApp.notifier.idle();
    expect(sent).toHaveLength(0);
  });

  it('removes a subscription the push service reports as gone (404 / 410), without retrying', async () => {
    for (const status of [404, 410]) {
      const u = await loginAs(app, gh);
      await subscribe(u, endpoint());
      await setPush(u);
      replies = [status];
      await app.notifier.notify(u.userId, draft());
      await app.notifier.idle();
      expect(sent).toHaveLength(1);
      expect(await subs(u.userId)).toHaveLength(0);
      sent.length = 0;
    }
  });

  it('removes only the expired browser and still reaches the others', async () => {
    const u = await loginAs(app, gh);
    const dead = endpoint();
    const alive = endpoint();
    await subscribe(u, dead);
    await subscribe(u, alive);
    await setPush(u);
    pusher.mockImplementation(async (target, payload) => {
      sent.push({ target, payload });
      if (target.endpoint === dead) throw new PushError('HTTP 410', 410);
    });
    await app.notifier.notify(u.userId, draft());
    await app.notifier.idle();
    pusher.mockImplementation(async (target, payload) => {
      sent.push({ target, payload });
      const r = replies.shift();
      if (r !== undefined) throw new PushError(`HTTP ${r}`, r);
    });
    expect((await subs(u.userId)).map((s) => s.endpoint)).toEqual([alive]);
    expect(sent.map((s) => s.target.endpoint).sort()).toEqual([dead, alive].sort());
  });

  it('retries a transient failure (5xx, network) and then delivers', async () => {
    const u = await loginAs(app, gh);
    await subscribe(u, endpoint());
    await setPush(u);
    replies = [503, 429];
    await app.notifier.notify(u.userId, draft());
    await app.notifier.idle();
    expect(sent).toHaveLength(3);
    expect(await subs(u.userId)).toHaveLength(1);
  });

  it('gives up after NOTIFY_MAX_ATTEMPTS but keeps the subscription', async () => {
    const u = await loginAs(app, gh);
    await subscribe(u, endpoint());
    await setPush(u);
    replies = [500, 500, 500, 500];
    await app.notifier.notify(u.userId, draft());
    await app.notifier.idle();
    expect(sent).toHaveLength(3);
    expect(await subs(u.userId)).toHaveLength(1);
  });

  it('does not retry a permanent refusal (bad VAPID key, payload too large) and keeps the subscription', async () => {
    const u = await loginAs(app, gh);
    await subscribe(u, endpoint());
    await setPush(u);
    replies = [403];
    await app.notifier.notify(u.userId, draft());
    await app.notifier.idle();
    expect(sent).toHaveLength(1);
    expect(await subs(u.userId)).toHaveLength(1);
  });

  it('respects the recipient check: a member without access to the private project gets nothing', async () => {
    const u = await loginAs(app, gh);
    await subscribe(u, endpoint());
    await setPush(u);
    const owner = await loginAs(app, gh);
    const repo = repoFor();
    gh.repos.set(owner.token, [repo]);
    const created = ProjectViewSchema.parse(
      (await api(app, owner)('POST', '/api/projects', { githubRepoId: repo.githubRepoId })).json(),
    );
    await prisma.project.update({ where: { id: created.id }, data: { isPrivate: true } });
    await app.notifier.notify(u.userId, draft({ projectId: created.id }));
    await app.notifier.idle();
    expect(sent).toHaveLength(0);
    await app.notifier.notify(owner.userId, draft({ projectId: created.id }));
    await app.notifier.idle(); // the owner has no browser: still nothing, but no error
    expect(sent).toHaveLength(0);
  });
});

describe('test notification', () => {
  const test = async (u: TestUser, a: FastifyInstance = app) =>
    SendTestNotificationResponseSchema.parse(
      (await api(a, u)('POST', '/api/notifications/test', { channel: 'push' })).json(),
    );

  it('reports not_configured without a browser, ok after subscribing, the error when refused', async () => {
    const u = await loginAs(app, gh);
    expect(await test(u)).toEqual({ ok: false, error: 'not_configured' });
    await subscribe(u, endpoint());
    expect(await test(u)).toEqual({ ok: true });
    expect(sent[0]!.payload.title).toBe('Test notification from orch');
    replies = [403];
    expect(await test(u)).toEqual({ ok: false, error: 'HTTP 403' });
  });

  it('reports a gone browser and forgets it', async () => {
    const u = await loginAs(app, gh);
    await subscribe(u, endpoint());
    replies = [410];
    expect((await test(u)).ok).toBe(false);
    expect(await subs(u.userId)).toHaveLength(0);
  });

  it('reports push_not_configured without VAPID keys', async () => {
    const u = await loginAs(noPushApp, gh);
    expect(await test(u, noPushApp)).toEqual({ ok: false, error: 'push_not_configured' });
  });
});

describe('endpoint validation', () => {
  it.each([
    'https://fcm.googleapis.com/fcm/send/abc',
    'https://updates.push.services.mozilla.com/wpush/v2/abc',
    'https://web.push.apple.com/abc',
    'https://wns2-par02p.notify.windows.com/w/?token=abc',
  ])('accepts %s', (ep) => {
    expect(validatePushEndpoint(ep).href).toBe(ep);
  });
});

describe('VAPID configuration', () => {
  const base = { DATABASE_URL: 'postgresql://x', GITHUB_CLIENT_ID: 'a', GITHUB_APP_SLUG: 'b' };
  it('is optional, all-or-nothing, with a mailto: or https subject', () => {
    expect(() => loadConfig(base)).not.toThrow();
    expect(() => loadConfig({ ...base, VAPID_PUBLIC_KEY: 'a' })).toThrow(/set together/);
    const all = { ...base, VAPID_PUBLIC_KEY: 'a', VAPID_PRIVATE_KEY: 'b' };
    expect(() => loadConfig({ ...all, VAPID_SUBJECT: 'admin@example.com' })).toThrow(/mailto/);
    expect(loadConfig({ ...all, VAPID_SUBJECT: 'mailto:admin@example.com' }).VAPID_SUBJECT).toBe(
      'mailto:admin@example.com',
    );
    expect(() => loadConfig({ ...all, VAPID_SUBJECT: 'https://orch.example.com' })).not.toThrow();
  });
});

describe('real sender', () => {
  const cfg = (extra: Record<string, string> = {}) =>
    loadConfig({
      DATABASE_URL: 'postgresql://x',
      GITHUB_CLIENT_ID: 'a',
      GITHUB_APP_SLUG: 'b',
      ...extra,
    });

  it('does not exist without VAPID keys', () => {
    expect(createPushSender(cfg())).toBeNull();
  });

  it('refuses an endpoint outside the known push services before any network call', async () => {
    const send = createPushSender(
      cfg({
        VAPID_PUBLIC_KEY: vapid.publicKey,
        VAPID_PRIVATE_KEY: vapid.privateKey,
        VAPID_SUBJECT: 'mailto:admin@example.com',
      }),
    )!;
    await expect(
      send(
        { endpoint: 'https://127.0.0.1:1/x', ...KEYS },
        { title: 't', body: 'b', url: null, tag: 'x' },
      ),
    ).rejects.toMatchObject({ message: 'refused_endpoint' });
  });
});
