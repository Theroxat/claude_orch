import { afterAll, describe, expect, it } from 'vitest';
import { FakeGithub, api, loginAs, makeApp, prisma } from './harness';

// Behind Cloudflare Tunnel the server only ever sees plain HTTP from Caddy. Every public URL it
// emits must come from ORCH_PUBLIC_URL, and X-Forwarded-* is honoured only from trusted peers.
const PUBLIC = 'https://orch.selfhostr.io';
const gh = new FakeGithub();
const app = makeApp(gh, { env: { ORCH_PUBLIC_URL: PUBLIC, ORCH_BASE_URL: 'http://orch:3000' } });
afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

describe('behind a TLS-terminating proxy (ORCH_PUBLIC_URL)', () => {
  it('OAuth redirect_uri is https even though the request is plain HTTP', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/auth/github/login',
      headers: { host: 'orch:3000' },
    });
    expect(res.statusCode).toBe(302);
    const url = new URL(String(res.headers.location));
    expect(url.searchParams.get('redirect_uri')).toBe(`${PUBLIC}/api/auth/github/callback`);
    expect(String(res.headers['set-cookie'])).toContain('Secure');
  });

  it('session cookie stays Secure', async () => {
    const login = `p-${Date.now()}`;
    gh.users.set(`tok-${login}`, { id: Date.now(), login, name: null, avatarUrl: null });
    const res = await app.inject({
      method: 'GET',
      url: `/api/auth/github/callback?code=${login}&state=x`,
      headers: { cookie: 'orch_oauth_state=x' },
    });
    const c = ([] as string[])
      .concat(res.headers['set-cookie'] as string[])
      .find((x) => x.startsWith('orch_session='))!;
    expect(c).toContain('Secure');
  });

  it('install.sh, enrollment installCommand and mcpAddCommand say https', async () => {
    const sh = await app.inject({ method: 'GET', url: '/install.sh' });
    expect(sh.body).toContain(`SERVED_FROM_URL="${PUBLIC}"`);
    const u = await loginAs(app, gh);
    const t = (await api(app, u)('POST', '/api/agents/enrollment-tokens')).json();
    expect(t.installCommand).toContain(`${PUBLIC}/install.sh`);
    const tok = (await api(app, u)('POST', '/api/tokens', { name: 'laptop' })).json();
    expect(tok.mcpAddCommand).toContain(`${PUBLIC}/mcp`);
  });

  it('accepts the public origin and rejects another one on state-changing requests', async () => {
    const u = await loginAs(app, gh);
    const ok = await app.inject({
      method: 'POST',
      url: '/api/agents/enrollment-tokens',
      headers: { cookie: u.cookie, origin: PUBLIC },
    });
    expect(ok.statusCode).toBe(201);
    const bad = await app.inject({
      method: 'POST',
      url: '/api/agents/enrollment-tokens',
      headers: { cookie: u.cookie, origin: 'http://orch:3000' },
    });
    expect(bad.statusCode).toBe(403);
  });
});

describe('X-Forwarded-For trust', () => {
  const loginIp = async (a: ReturnType<typeof makeApp>, ip: string) => {
    const login = `f-${Date.now()}-${Math.random()}`;
    const id = Math.floor(Math.random() * 1e9);
    gh.users.set(`tok-${login}`, { id, login, name: null, avatarUrl: null });
    await a.inject({
      method: 'GET',
      url: `/api/auth/github/callback?code=${login}&state=x`,
      headers: { cookie: 'orch_oauth_state=x', 'x-forwarded-for': ip },
    });
    const user = await prisma.user.findUniqueOrThrow({ where: { githubId: BigInt(id) } });
    const row = await prisma.auditLog.findFirstOrThrow({
      where: { actorUserId: user.id, action: 'auth.login' },
    });
    return row.ip;
  };

  it('honours it from a trusted peer (inject connects from 127.0.0.1)', async () => {
    expect(await loginIp(app, '203.0.113.7')).toBe('203.0.113.7');
  });

  it('ignores it when no proxy is trusted', async () => {
    const strict = makeApp(gh, { env: { ORCH_TRUST_PROXY: 'false' } });
    try {
      expect(await loginIp(strict, '203.0.113.7')).not.toBe('203.0.113.7');
    } finally {
      await strict.close();
    }
  });
});
