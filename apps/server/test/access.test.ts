import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { CloseCode, EnrollResponseSchema, agentMessage, type ServerMessage } from '@orch/shared';
import { signToken } from '../src/auth/crypto';
import { loadConfig, signInIsRestricted } from '../src/config';
import { FakeGithub, makeApp, prisma, uid, uniqueInt } from './harness';

const KEY = randomBytes(32).toString('base64');
const ADMIN = `Root-${uid()}`;
const gh = new FakeGithub();
const apps: FastifyInstance[] = [];

function newApp(env: Record<string, string> = {}) {
  const a = makeApp(gh, {
    env: {
      ORCH_ENCRYPTION_KEY: KEY,
      ORCH_ADMIN_GITHUB_LOGINS: ADMIN,
      ORCH_ALLOWLIST_CACHE_SEC: '300',
      ...env,
    },
  });
  apps.push(a);
  return a;
}

afterAll(async () => {
  for (const a of apps) await a.close();
  // APPROVED grants restrict sign-in for every server sharing this test database.
  await prisma.accessGrant.deleteMany();
  await prisma.accessInvite.deleteMany();
  await prisma.$disconnect();
});

interface Signed {
  status: number;
  body: string;
  cookie?: string;
  setCookie: string[];
  githubId: number;
}

/** Runs the real OAuth callback for a GitHub account (same id across calls for one login). */
const ids = new Map<string, number>();
async function signIn(
  a: FastifyInstance,
  login: string,
  extraCookie = '',
  orgs: string[] = [],
): Promise<Signed> {
  const githubId = ids.get(login) ?? uniqueInt();
  ids.set(login, githubId);
  const code = `${login}-${uid()}`;
  gh.users.set(`tok-${code}`, {
    id: githubId,
    login,
    name: null,
    avatarUrl: `https://avatars.githubusercontent.com/u/${githubId}`,
  });
  gh.orgs.set(`tok-${code}`, new Set(orgs));
  const res = await a.inject({
    method: 'GET',
    url: `/api/auth/github/callback?code=${code}&state=s`,
    headers: { cookie: `orch_oauth_state=s${extraCookie ? `; ${extraCookie}` : ''}` },
  });
  const setCookie = ([] as string[]).concat((res.headers['set-cookie'] as string[]) ?? []);
  const cookie = setCookie
    .find((c) => c.startsWith('orch_session=') && !c.startsWith('orch_session=;'))
    ?.split(';')[0];
  return { status: res.statusCode, body: res.body, cookie, setCookie, githubId };
}

const tokenOf = (html: string) => /name="token" value="([^"]+)"/.exec(html)?.[1];

const requestAccess = (a: FastifyInstance, token: string, note = '', origin?: string) =>
  a.inject({
    method: 'POST',
    url: '/api/auth/access-request',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      ...(origin ? { origin } : {}),
    },
    payload: new URLSearchParams({ token, note }).toString(),
  });

const as =
  (a: FastifyInstance, cookie?: string) =>
  (method: 'GET' | 'POST', url: string, payload?: object) =>
    a.inject({ method, url, payload, headers: cookie ? { cookie } : {} });

async function adminCookie(a: FastifyInstance): Promise<string> {
  const s = await signIn(a, ADMIN);
  expect(s.status).toBe(302);
  return s.cookie!;
}

interface GrantJson {
  id: string;
  githubLogin: string;
  githubUserId: string | null;
  avatarUrl: string | null;
  status: string;
  note: string | null;
  decidedBy: string | null;
}

describe('admins', () => {
  it('an env admin is always allowed and /api/me reports isAdmin', async () => {
    const a = newApp({ ORCH_ALLOWED_GITHUB_LOGINS: 'somebody-else' });
    const admin = await adminCookie(a);
    const me = await as(a, admin)('GET', '/api/me');
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ githubLogin: ADMIN, isAdmin: true });
    // Case-insensitive.
    expect((await signIn(a, ADMIN.toUpperCase())).status).toBe(302);
  });

  it('every admin route: 401 without a session, 403 for a signed-in non-admin', async () => {
    const a = newApp();
    const admin = await adminCookie(a);
    const member = `member-${uid()}`;
    await as(a, admin)('POST', '/api/admin/access/grants', { githubLogin: member });
    const m = await signIn(a, member);
    expect(m.status).toBe(302);
    expect((await as(a, m.cookie)('GET', '/api/me')).json()).toMatchObject({ isAdmin: false });
    const routes: Array<['GET' | 'POST', string, object?]> = [
      ['GET', '/api/admin/access'],
      ['GET', '/api/admin/access/pending-count'],
      ['POST', '/api/admin/access/grants', { githubLogin: 'someone' }],
      ['POST', '/api/admin/access/grants/x/approve'],
      ['POST', '/api/admin/access/grants/x/deny'],
      ['POST', '/api/admin/access/grants/x/remove'],
      ['POST', '/api/admin/access/invites', { multiUse: false, expiresInHours: 1 }],
      ['POST', '/api/admin/access/invites/x/revoke'],
    ];
    for (const [method, url, body] of routes) {
      expect((await as(a)(method, url, body)).statusCode, url).toBe(401);
      expect((await as(a, m.cookie)(method, url, body)).statusCode, url).toBe(403);
    }
    expect((await as(a, admin)('GET', '/api/admin/access')).statusCode).toBe(200);
    expect(await prisma.accessGrant.count({ where: { githubLogin: 'someone' } })).toBe(0);
  });

  it('admin mutations go through the Origin check', async () => {
    const a = newApp();
    const admin = await adminCookie(a);
    const res = await a.inject({
      method: 'POST',
      url: '/api/admin/access/grants',
      headers: { cookie: admin, origin: 'https://evil.example' },
      payload: { githubLogin: 'x' },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('request access', () => {
  let a: FastifyInstance;
  let admin: string;
  beforeAll(async () => {
    a = newApp();
    admin = await adminCookie(a);
  });

  it('non-allowed -> request -> pending -> approve -> can sign in', async () => {
    const login = `Newbie-${uid()}`;
    const first = await signIn(a, login);
    expect(first.status).toBe(403);
    expect(first.cookie).toBeUndefined();
    expect(first.body).toContain('Request access');
    expect(first.body).toContain(login);
    expect(first.body).toContain(`https://avatars.githubusercontent.com/u/${first.githubId}`);
    const token = tokenOf(first.body)!;
    expect(token).toBeTruthy();

    const sent = await requestAccess(a, token, 'Hi, I am on the team');
    expect(sent.statusCode).toBe(200);
    expect(sent.body).toContain('Request sent: an admin will review it.');
    expect(sent.headers['set-cookie']).toBeUndefined(); // no session
    // Idempotent: a repeat updates the note, no duplicate.
    expect((await requestAccess(a, token, 'Updated note')).statusCode).toBe(200);
    const rows = await prisma.accessGrant.findMany({
      where: { githubLogin: login.toLowerCase() },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'PENDING', note: 'Updated note' });
    expect(rows[0]!.githubUserId).toBe(BigInt(first.githubId));
    expect(
      await prisma.auditLog.count({
        where: {
          action: { startsWith: 'access.request' },
          data: { path: ['login'], equals: login.toLowerCase() },
        },
      }),
    ).toBe(2);

    // Pending: the callback shows the "Request sent" state.
    const again = await signIn(a, login);
    expect(again.status).toBe(403);
    expect(again.body).toContain('Request sent');

    const list = (await as(a, admin)('GET', '/api/admin/access')).json<{
      pending: GrantJson[];
      configured: { admins: string[]; allowAny: boolean };
    }>();
    const g = list.pending.find((p) => p.githubLogin === login.toLowerCase())!;
    expect(g).toMatchObject({ status: 'PENDING', note: 'Updated note' });
    expect(g.githubUserId).toBe(String(first.githubId));
    expect(list.configured).toMatchObject({ admins: [ADMIN.toLowerCase()], allowAny: false });
    const count = (await as(a, admin)('GET', '/api/admin/access/pending-count')).json<{
      count: number;
    }>();
    expect(count.count).toBeGreaterThanOrEqual(1);

    const ok = await as(a, admin)('POST', `/api/admin/access/grants/${g.id}/approve`);
    expect(ok.statusCode).toBe(200);
    expect(ok.json<{ grant: GrantJson }>().grant).toMatchObject({
      status: 'APPROVED',
      decidedBy: ADMIN,
    });
    const signed = await signIn(a, login);
    expect(signed.status).toBe(302);
    expect((await as(a, signed.cookie)('GET', '/api/me')).statusCode).toBe(200);
    // An approved user re-requesting changes nothing.
    expect((await requestAccess(a, token)).statusCode).toBe(200);
    expect((await prisma.accessGrant.findUniqueOrThrow({ where: { id: g.id } })).status).toBe(
      'APPROVED',
    );
  });

  it('deny -> refused with "declined" and no form; a new request keeps it denied', async () => {
    const login = `nope-${uid()}`;
    const first = await signIn(a, login);
    const token = tokenOf(first.body)!;
    await requestAccess(a, token, 'please');
    const g = await prisma.accessGrant.findUniqueOrThrow({ where: { githubLogin: login } });
    const res = await as(a, admin)('POST', `/api/admin/access/grants/${g.id}/deny`);
    expect(res.json<{ grant: GrantJson }>().grant.status).toBe('DENIED');
    const after = await signIn(a, login);
    expect(after.status).toBe(403);
    expect(after.body).toContain('Your request was declined');
    expect(tokenOf(after.body)).toBeUndefined();
    const re = await requestAccess(a, token, 'again');
    expect(re.body).toContain('declined');
    expect(
      (await prisma.accessGrant.findUniqueOrThrow({ where: { githubLogin: login } })).status,
    ).toBe('DENIED');
  });

  it('pre-approve by login (validated); the first sign-in fills id and avatar', async () => {
    for (const bad of ['', 'bad--login', '-x', 'a'.repeat(40), 'x y']) {
      const r = await as(a, admin)('POST', '/api/admin/access/grants', { githubLogin: bad });
      expect(r.statusCode, bad).toBe(400);
    }
    const login = `Pre-${uid()}`;
    const r = await as(a, admin)('POST', '/api/admin/access/grants', { githubLogin: login });
    expect(r.statusCode).toBe(200);
    expect(r.json<{ grant: GrantJson }>().grant).toMatchObject({
      githubLogin: login.toLowerCase(),
      status: 'APPROVED',
      githubUserId: null,
    });
    const s = await signIn(a, login);
    expect(s.status).toBe(302);
    const g = await prisma.accessGrant.findUniqueOrThrow({
      where: { githubLogin: login.toLowerCase() },
    });
    expect(g.githubUserId).toBe(BigInt(s.githubId));
    expect(g.avatarUrl).toContain('avatars.githubusercontent.com');
    expect(
      await prisma.auditLog.count({
        where: {
          action: 'access.preapproved',
          data: { path: ['login'], equals: login.toLowerCase() },
        },
      }),
    ).toBe(1);
  });

  it('remove -> denied everywhere at once (cache invalidated), nothing deleted', async () => {
    const login = `gone-${uid()}`;
    const r = await as(a, admin)('POST', '/api/admin/access/grants', { githubLogin: login });
    const grant = r.json<{ grant: GrantJson }>().grant;
    const s = await signIn(a, login);
    expect((await as(a, s.cookie)('GET', '/api/me')).statusCode).toBe(200); // cached now
    const rm = await as(a, admin)('POST', `/api/admin/access/grants/${grant.id}/remove`);
    expect(rm.json<{ grant: GrantJson }>().grant.status).toBe('DENIED');
    expect((await as(a, s.cookie)('GET', '/api/me')).statusCode).toBe(401);
    expect((await signIn(a, login)).status).toBe(403);
    expect(await prisma.accessGrant.count({ where: { id: grant.id } })).toBe(1);
    expect(await prisma.session.count({ where: { user: { login } } })).toBe(1);
    // Re-approving restores the existing session.
    await as(a, admin)('POST', `/api/admin/access/grants/${grant.id}/approve`);
    expect((await as(a, s.cookie)('GET', '/api/me')).statusCode).toBe(200);
  });

  it('remove -> a connected agent is cut off: no token, socket closed', async () => {
    const login = `agent-${uid()}`;
    const r = await as(a, admin)('POST', '/api/admin/access/grants', { githubLogin: login });
    const grant = r.json<{ grant: GrantJson }>().grant;
    const s = await signIn(a, login);
    const enrollToken = (await as(a, s.cookie)('POST', '/api/agents/enrollment-tokens')).json<{
      token: string;
    }>().token;
    const enr = EnrollResponseSchema.parse(
      (
        await a.inject({
          method: 'POST',
          url: '/api/agents/enroll',
          payload: { token: enrollToken, machineName: 'box', agentVersion: '0.1.0' },
        })
      ).json(),
    );
    if (!a.server.listening) await a.listen({ port: 0, host: '127.0.0.1' });
    const port = (a.server.address() as AddressInfo).port;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/agent/ws`, {
      headers: { authorization: `Bearer ${enr.credential}` },
    });
    const msgs: ServerMessage[] = [];
    ws.on('message', (d) => msgs.push(JSON.parse(d.toString()) as ServerMessage));
    const closed = new Promise<number>((res) => ws.once('close', (code) => res(code)));
    await new Promise((res) => ws.once('open', res));
    ws.send(
      JSON.stringify(
        agentMessage('hello', {
          agentVersion: '0.4.0',
          capabilities: ['auto', 'manual'],
          localPaused: false,
          maxConcurrent: 1,
          running: [],
        }),
      ),
    );
    const end = Date.now() + 3000;
    while (!msgs.some((m) => m.type === 'welcome') && Date.now() < end) {
      await new Promise((res) => setTimeout(res, 15));
    }
    expect(msgs.some((m) => m.type === 'welcome')).toBe(true);

    await as(a, admin)('POST', `/api/admin/access/grants/${grant.id}/remove`);
    ws.send(
      JSON.stringify(
        agentMessage('token.request', {
          requestId: 'r1',
          assignmentId: 'whatever',
          purpose: 'push',
        }),
      ),
    );
    expect(await closed).toBe(CloseCode.UNAUTHORIZED);
    expect(msgs.some((m) => m.type === 'token.grant' || m.type === 'token.deny')).toBe(false);
  });

  it('an approved grant does not follow a login to another GitHub account', async () => {
    const login = `renamed-${uid()}`;
    await as(a, admin)('POST', '/api/admin/access/grants', { githubLogin: login });
    expect((await signIn(a, login)).status).toBe(302); // binds the GitHub id
    ids.set(login, uniqueInt()); // someone else took the login
    expect((await signIn(a, login)).status).toBe(403);
  });

  it('404 for an unknown grant', async () => {
    expect((await as(a, admin)('POST', '/api/admin/access/grants/nope/approve')).statusCode).toBe(
      404,
    );
  });
});

describe('the signed request token', () => {
  it('cannot be forged, expired, used for another login or another purpose', async () => {
    const a = newApp();
    const login = `tok-${uid()}`;
    const token = tokenOf((await signIn(a, login)).body)!;
    const [body, mac] = token.split('.');
    const payload = JSON.parse(Buffer.from(body!, 'base64url').toString()) as object;
    const forged = `${Buffer.from(JSON.stringify({ ...payload, login: 'victim' })).toString('base64url')}.${mac}`;
    expect((await requestAccess(a, forged)).statusCode).toBe(400);
    const otherKey = signToken(
      randomBytes(32).toString('base64'),
      'access-request',
      { login: 'x' },
      60_000,
    );
    expect((await requestAccess(a, otherKey)).statusCode).toBe(400);
    const expired = signToken(KEY, 'access-request', { login: 'late' }, -1);
    expect((await requestAccess(a, expired)).statusCode).toBe(400);
    const wrongPurpose = signToken(KEY, 'invite-cookie', { login: 'x', id: 'x' }, 60_000);
    expect((await requestAccess(a, wrongPurpose)).statusCode).toBe(400);
    expect((await requestAccess(a, 'garbage')).statusCode).toBe(400);
    expect(
      await prisma.accessGrant.count({ where: { githubLogin: { in: ['victim', 'late', 'x'] } } }),
    ).toBe(0);
  });

  it('a cross-origin POST is rejected', async () => {
    const a = newApp();
    const login = `csrf-${uid()}`;
    const token = tokenOf((await signIn(a, login)).body)!;
    const res = await requestAccess(a, token, '', 'https://evil.example');
    expect(res.statusCode).toBe(403);
    expect(await prisma.accessGrant.count({ where: { githubLogin: login } })).toBe(0);
    expect((await requestAccess(a, token, '', 'http://localhost:8470')).statusCode).toBe(200);
  });

  it('is rate limited per login', async () => {
    const a = newApp();
    const token = tokenOf((await signIn(a, `rl-${uid()}`)).body)!;
    const codes: number[] = [];
    for (let i = 0; i < 7; i++) codes.push((await requestAccess(a, token)).statusCode);
    expect(codes.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
    expect(codes.at(-1)).toBe(429);
  });
});

describe('invite links', () => {
  let a: FastifyInstance;
  let admin: string;
  beforeAll(async () => {
    a = newApp();
    admin = await adminCookie(a);
  });

  const create = async (multiUse: boolean, expiresInHours = 24) => {
    const r = await as(a, admin)('POST', '/api/admin/access/invites', { multiUse, expiresInHours });
    expect(r.statusCode).toBe(200);
    return r.json<{ invite: { id: string; active: boolean; uses: number }; url: string }>();
  };
  const open = async (url: string) => {
    const res = await a.inject({ method: 'GET', url: new URL(url).pathname });
    const sc = ([] as string[]).concat((res.headers['set-cookie'] as string[]) ?? []);
    return { res, cookie: sc.find((c) => c.startsWith('orch_invite='))?.split(';')[0] };
  };

  it('validates the body', async () => {
    for (const body of [
      { multiUse: false, expiresInHours: 0 },
      { multiUse: false, expiresInHours: 721 },
      { multiUse: 'yes', expiresInHours: 1 },
    ]) {
      expect((await as(a, admin)('POST', '/api/admin/access/invites', body)).statusCode).toBe(400);
    }
  });

  it('single-use: the first stranger is approved, the second is not', async () => {
    const { invite, url } = await create(false);
    expect(url).toMatch(/^http:\/\/localhost:8470\/invite\/[\w-]{20,}$/);
    expect(invite).toMatchObject({ active: true, uses: 0 });
    const raw = url.split('/invite/')[1]!;
    expect(await prisma.accessInvite.count({ where: { tokenHash: raw } })).toBe(0); // hashed
    const o = await open(url);
    expect(o.res.statusCode).toBe(302);
    expect(o.res.headers.location).toBe('/api/auth/github/login');
    expect(o.cookie).toBeTruthy();
    const login = `inv-${uid()}`;
    const s = await signIn(a, login, o.cookie);
    expect(s.status).toBe(302);
    expect(s.setCookie.some((c) => c.startsWith('orch_invite=;'))).toBe(true);
    const g = await prisma.accessGrant.findUniqueOrThrow({ where: { githubLogin: login } });
    expect(g).toMatchObject({ status: 'APPROVED', decidedBy: `invite:${invite.id}` });
    // Replaying the cookie for someone else, or opening the link again, fails.
    expect((await signIn(a, `inv2-${uid()}`, o.cookie)).status).toBe(403);
    expect((await open(url)).res.statusCode).toBe(404);
    expect((await open(url)).res.body).toContain('This invite link is invalid or has expired');
    const after = await prisma.accessInvite.findUniqueOrThrow({ where: { id: invite.id } });
    expect(after.uses).toBe(1);
  });

  it('multi-use works for several people', async () => {
    const { url, invite } = await create(true);
    for (let i = 0; i < 2; i++) {
      const o = await open(url);
      expect((await signIn(a, `multi-${uid()}`, o.cookie)).status).toBe(302);
    }
    expect((await prisma.accessInvite.findUniqueOrThrow({ where: { id: invite.id } })).uses).toBe(
      2,
    );
  });

  it('expired or revoked: the link and an already-set cookie are refused', async () => {
    const exp = await create(true);
    const o = await open(exp.url);
    await prisma.accessInvite.update({
      where: { id: exp.invite.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expect((await open(exp.url)).res.statusCode).toBe(404);
    expect((await signIn(a, `late-${uid()}`, o.cookie)).status).toBe(403);

    const rev = await create(true);
    const o2 = await open(rev.url);
    const r = await as(a, admin)('POST', `/api/admin/access/invites/${rev.invite.id}/revoke`);
    expect(r.json<{ invite: { active: boolean; revokedAt: string } }>().invite).toMatchObject({
      active: false,
    });
    expect((await open(rev.url)).res.statusCode).toBe(404);
    expect((await signIn(a, `rev-${uid()}`, o2.cookie)).status).toBe(403);
    expect((await a.inject({ method: 'GET', url: '/invite/not-a-token' })).statusCode).toBe(404);
  });

  it('does not override a declined user', async () => {
    const login = `declined-${uid()}`;
    const r = await as(a, admin)('POST', '/api/admin/access/grants', { githubLogin: login });
    await as(a, admin)(
      'POST',
      `/api/admin/access/grants/${r.json<{ grant: GrantJson }>().grant.id}/deny`,
    );
    const { url, invite } = await create(false);
    const o = await open(url);
    expect((await signIn(a, login, o.cookie)).status).toBe(403);
    expect((await prisma.accessInvite.findUniqueOrThrow({ where: { id: invite.id } })).uses).toBe(
      0,
    );
  });

  it('lists invites and grants for the Access page', async () => {
    const body = (await as(a, admin)('GET', '/api/admin/access')).json<{
      invites: Array<{ id: string; active: boolean; createdBy: string }>;
      approved: GrantJson[];
      denied: GrantJson[];
    }>();
    expect(body.invites.length).toBeGreaterThan(0);
    expect(body.invites[0]!.createdBy).toBe(ADMIN);
    expect(body.approved.some((g) => g.decidedBy?.startsWith('invite:'))).toBe(true);
  });
});

describe('precedence', () => {
  const preapproveThen = async (
    a: FastifyInstance,
    admin: string,
    login: string,
    action: 'deny' | 'remove',
  ) => {
    const r = await as(a, admin)('POST', '/api/admin/access/grants', { githubLogin: login });
    const id = r.json<{ grant: GrantJson }>().grant.id;
    await as(a, admin)('POST', `/api/admin/access/grants/${id}/${action}`);
    return id;
  };

  it('DENIED wins over the env login list and allowed orgs, not over admins', async () => {
    const listed = `listed-${uid()}`;
    const a = newApp({ ORCH_ALLOWED_GITHUB_LOGINS: listed, ORCH_ALLOWED_GITHUB_ORGS: 'acme' });
    const admin = await adminCookie(a);
    const s = await signIn(a, listed);
    expect(s.status).toBe(302);
    expect((await as(a, s.cookie)('GET', '/api/me')).statusCode).toBe(200);
    await preapproveThen(a, admin, listed, 'remove');
    expect((await as(a, s.cookie)('GET', '/api/me')).statusCode).toBe(401); // session refused
    const again = await signIn(a, listed);
    expect(again.status).toBe(403);
    expect(again.body).toContain('Your request was declined');

    const member = `orgm-${uid()}`;
    expect((await signIn(a, member, '', ['acme'])).status).toBe(302);
    await preapproveThen(a, admin, member, 'deny');
    expect((await signIn(a, member, '', ['acme'])).status).toBe(403);

    // A DENIED grant on an admin's login changes nothing.
    await preapproveThen(a, admin, ADMIN, 'deny');
    expect((await signIn(a, ADMIN)).status).toBe(302);
    expect((await as(a, admin)('GET', '/api/me')).statusCode).toBe(200);
    await prisma.accessGrant.deleteMany({ where: { githubLogin: ADMIN.toLowerCase() } });
  });

  it('ORCH_ALLOW_ANY_GITHUB_USER=true stays open despite admins and grants; DENIED still applies', async () => {
    const a = newApp({ ORCH_ALLOW_ANY_GITHUB_USER: 'true' });
    const admin = await adminCookie(a);
    await as(a, admin)('POST', '/api/admin/access/grants', { githubLogin: `some-${uid()}` });
    expect(await prisma.accessGrant.count({ where: { status: 'APPROVED' } })).toBeGreaterThan(0);
    expect((await signIn(a, `anyone-${uid()}`)).status).toBe(302);
    const blocked = `blocked-${uid()}`;
    await preapproveThen(a, admin, blocked, 'deny');
    expect((await signIn(a, blocked)).status).toBe(403);

    const base = { DATABASE_URL: 'postgresql://x', ORCH_ADMIN_GITHUB_LOGINS: 'root' };
    expect(signInIsRestricted(loadConfig(base))).toBe(true);
    expect(signInIsRestricted(loadConfig({ ...base, ORCH_ALLOW_ANY_GITHUB_USER: 'true' }))).toBe(
      false,
    );
  });

  it('a grant bound to one GitHub account is not re-bound to another one', async () => {
    const login = `bound-${uid()}`;
    const a = newApp({ ORCH_ALLOWED_GITHUB_LOGINS: login });
    const admin = await adminCookie(a);
    await as(a, admin)('POST', '/api/admin/access/grants', { githubLogin: login });
    const first = await signIn(a, login);
    expect(first.status).toBe(302);
    // The first owner renamed their account; someone else takes the login (allowed by the env).
    await prisma.user.update({
      where: { githubId: BigInt(first.githubId) },
      data: { login: `old-${uid()}` },
    });
    ids.set(login, uniqueInt());
    const second = await signIn(a, login);
    expect(second.status).toBe(302);
    const g = await prisma.accessGrant.findUniqueOrThrow({ where: { githubLogin: login } });
    expect(g.githubUserId).toBe(BigInt(first.githubId));
  });
});
