import { afterAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { CloseCode, EnrollResponseSchema, agentMessage } from '@orch/shared';
import type { FastifyRequest } from 'fastify';
import { rateLimitKey, tierOf } from '../src/http/rate-limit';
import { loadConfig } from '../src/config';
import { FakeGithub, api, loginAs, makeApp, prisma } from './harness';

const gh = new FakeGithub();
const apps: ReturnType<typeof makeApp>[] = [];
function app(env: Record<string, string>) {
  const a = makeApp(gh, { env });
  apps.push(a);
  return a;
}
afterAll(async () => {
  for (const a of apps) await a.close();
  await prisma.$disconnect();
}, 60_000);

const get = (a: ReturnType<typeof makeApp>, url: string, remoteAddress?: string, h = {}) =>
  a.inject({ method: 'GET', url, remoteAddress, headers: h });

describe('HTTP rate limiting', () => {
  it('answers 429 with Retry-After, RateLimit headers and the API error shape', async () => {
    const a = app({ RATE_LIMIT_API_MAX: '3' });
    const u = await loginAs(a, gh);
    for (let i = 0; i < 3; i++) expect((await api(a, u)('GET', '/api/me')).statusCode).toBe(200);
    const res = await api(a, u)('GET', '/api/me');
    expect(res.statusCode).toBe(429);
    expect(res.json()).toEqual({
      error: { code: 'rate_limited', message: expect.stringContaining('Too many requests') },
    });
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
    expect(res.headers['ratelimit-limit']).toBe('3');
    expect(res.headers['ratelimit-remaining']).toBe('0');
    expect(res.headers['ratelimit-reset']).toBeDefined();
  });

  it('keys by user when signed in: another user and the same IP are not affected', async () => {
    const a = app({ RATE_LIMIT_API_MAX: '2' });
    const u1 = await loginAs(a, gh);
    const u2 = await loginAs(a, gh);
    for (let i = 0; i < 2; i++) await api(a, u1)('GET', '/api/me');
    expect((await api(a, u1)('GET', '/api/me')).statusCode).toBe(429);
    // Same remote address, different user: own bucket.
    expect((await api(a, u2)('GET', '/api/me')).statusCode).toBe(200);
    // Anonymous traffic from that IP has its own (per-IP) bucket too.
    expect((await get(a, '/api/me')).statusCode).toBe(401);
  });

  it('keys by IP when anonymous, and auth endpoints use the stricter auth tier', async () => {
    const a = app({ RATE_LIMIT_AUTH_MAX: '2' });
    for (let i = 0; i < 2; i++) {
      expect((await get(a, '/api/auth/github/login', '10.1.1.1')).statusCode).toBe(302);
    }
    expect((await get(a, '/api/auth/github/login', '10.1.1.1')).statusCode).toBe(429);
    expect((await get(a, '/api/auth/github/login', '10.1.1.2')).statusCode).toBe(302);
    // The default API tier is a separate counter.
    expect((await get(a, '/api/me', '10.1.1.1')).statusCode).toBe(401);
  });

  it('ignores a spoofed X-Forwarded-For from an untrusted peer', async () => {
    const a = app({ RATE_LIMIT_AUTH_MAX: '2', ORCH_TRUST_PROXY: 'false' });
    const codes: number[] = [];
    for (let i = 0; i < 4; i++) {
      const r = await get(a, '/api/auth/github/login', '203.0.113.7', {
        'x-forwarded-for': `198.51.100.${i}`,
      });
      codes.push(r.statusCode);
    }
    expect(codes).toEqual([302, 302, 429, 429]);
  });

  it('ignores X-Forwarded-For from a public peer even with the default (private-only) trust', async () => {
    const a = app({ RATE_LIMIT_AUTH_MAX: '1' });
    const first = await get(a, '/api/auth/github/login', '203.0.113.9', {
      'x-forwarded-for': '198.51.100.1',
    });
    const second = await get(a, '/api/auth/github/login', '203.0.113.9', {
      'x-forwarded-for': '198.51.100.2',
    });
    expect([first.statusCode, second.statusCode]).toEqual([302, 429]);
  });

  it('uses the client IP from X-Forwarded-For when the peer is the trusted proxy', async () => {
    const a = app({ RATE_LIMIT_AUTH_MAX: '1' });
    const via = (xff: string) =>
      get(a, '/api/auth/github/login', '172.18.0.5', { 'x-forwarded-for': xff });
    expect((await via('198.51.100.1')).statusCode).toBe(302);
    expect((await via('198.51.100.1')).statusCode).toBe(429);
    expect((await via('198.51.100.2')).statusCode).toBe(302);
  });

  it('exempts health checks and static files', async () => {
    const a = app({ RATE_LIMIT_API_MAX: '1', RATE_LIMIT_AUTH_MAX: '1' });
    for (let i = 0; i < 10; i++) {
      expect((await get(a, '/healthz')).statusCode).toBe(200);
      expect((await get(a, '/api/healthz')).statusCode).toBe(200);
      expect((await get(a, '/install.sh')).statusCode).toBe(200);
    }
  });

  it('can be turned off', async () => {
    const a = app({ RATE_LIMIT_ENABLED: 'false', RATE_LIMIT_API_MAX: '1' });
    for (let i = 0; i < 5; i++) expect((await get(a, '/api/me')).statusCode).toBe(401);
  });

  it('webhook: per IP limit, and bodies over 1 MiB are refused', async () => {
    const a = app({ RATE_LIMIT_WEBHOOK_MAX: '3' });
    const post = (payload: string, ip: string) =>
      a.inject({
        method: 'POST',
        url: '/api/github/webhook',
        remoteAddress: ip,
        headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=00' },
        payload,
      });
    const codes: number[] = [];
    for (let i = 0; i < 4; i++) codes.push((await post('{}', '192.0.2.10')).statusCode);
    expect(codes).toEqual([401, 401, 401, 429]);
    expect((await post('{}', '192.0.2.11')).statusCode).toBe(401);
    const big = JSON.stringify({ pad: 'x'.repeat(1024 * 1024 + 10) });
    expect((await post(big, '192.0.2.12')).statusCode).toBe(413);
  });

  it('MCP: one bucket per token, not per IP', async () => {
    const a = app({ RATE_LIMIT_MCP_MAX: '2' });
    const mcp = (token: string) =>
      a.inject({
        method: 'POST',
        url: '/mcp',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        payload: '{}',
      });
    expect((await mcp('orch_a')).statusCode).toBe(401);
    expect((await mcp('orch_a')).statusCode).toBe(401);
    expect((await mcp('orch_a')).statusCode).toBe(429);
    expect((await mcp('orch_b')).statusCode).toBe(401);
  });

  it('MCP: spraying random tokens from one IP is capped per IP', async () => {
    const a = app({ RATE_LIMIT_MCP_MAX: '1' });
    const codes: number[] = [];
    for (let i = 0; i < 7; i++) {
      codes.push(
        (
          await a.inject({
            method: 'POST',
            url: '/mcp',
            headers: { authorization: `Bearer orch_rand${i}`, 'content-type': 'application/json' },
            payload: '{}',
          })
        ).statusCode,
      );
    }
    expect(codes.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
    expect(codes.slice(5)).toEqual([429, 429]);
  });

  it('heavy tier (pool) is limited per user', async () => {
    const a = app({ RATE_LIMIT_HEAVY_MAX: '2' });
    const u = await loginAs(a, gh);
    await api(a, u)('GET', '/api/pool');
    await api(a, u)('GET', '/api/pool');
    expect((await api(a, u)('GET', '/api/pool')).statusCode).toBe(429);
    expect((await api(a, u)('GET', '/api/me')).statusCode).toBe(200);
  });
});

describe('tiers and keys', () => {
  const req = (url: string, extra: Record<string, unknown> = {}) =>
    ({
      routeOptions: { url },
      ip: '198.51.100.1',
      headers: {},
      ...extra,
    }) as unknown as FastifyRequest;

  it('puts log streams, usage and history in sensible tiers (by path pattern)', () => {
    expect(tierOf(req('/api/tasks/:id/logs/stream'))).toBe('stream');
    expect(tierOf(req('/api/usage'))).toBe('heavy');
    expect(tierOf(req('/api/usage/summary'))).toBe('heavy');
    expect(tierOf(req('/api/tasks/history'))).toBe('heavy');
    expect(tierOf(req('/api/tasks/:id'))).toBe('api');
    expect(tierOf(req('/api/tasks'))).toBe('api');
    expect(tierOf(req('/api/usagexyz'))).toBe('api');
  });

  it('keeps user and IP namespaces apart, and groups an IPv6 /64', () => {
    expect(rateLimitKey(req('/api/me', { user: { id: 'ip:198.51.100.1' } }))).toBe(
      'api:user:ip:198.51.100.1',
    );
    expect(rateLimitKey(req('/api/me'))).toBe('api:ip:198.51.100.1');
    const a = rateLimitKey(req('/api/me', { ip: '2001:db8:1:2:aaaa::1' }));
    const b = rateLimitKey(req('/api/me', { ip: '2001:db8:1:2:bbbb:cccc:dddd:1' }));
    expect(a).toBe(b);
    expect(rateLimitKey(req('/api/me', { ip: '2001:db8:1:3::1' }))).not.toBe(a);
    expect(rateLimitKey(req('/api/me', { ip: '::ffff:192.0.2.1' }))).toBe(
      'api:ip:::ffff:192.0.2.1',
    );
  });

  it('treats empty RATE_LIMIT_* env values as unset', () => {
    const base = {
      DATABASE_URL: 'postgresql://x',
      ORCH_ENCRYPTION_KEY: Buffer.alloc(32).toString('base64'),
    };
    const c = loadConfig({
      ...base,
      RATE_LIMIT_ENABLED: '',
      RATE_LIMIT_API_MAX: '',
      RATE_LIMIT_AGENT_MSG_PER_SEC: '',
      ORCH_TRUST_PROXY: '',
    });
    expect(c.RATE_LIMIT_ENABLED).toBe(true);
    expect(c.RATE_LIMIT_API_MAX).toBe(300);
    expect(c.RATE_LIMIT_AGENT_MSG_PER_SEC).toBe(100);
    expect(c.ORCH_TRUST_PROXY).toBe('loopback,linklocal,uniquelocal');
  });
});

/** Lets the server see the clients' close, then shuts the app down. */
async function shutdown(a: ReturnType<typeof makeApp>) {
  await new Promise((r) => setTimeout(r, 200));
  a.server.closeAllConnections();
  await a.close();
  apps.splice(apps.indexOf(a), 1);
}

describe('agent WebSocket limits', () => {
  async function enrolled(
    a: ReturnType<typeof makeApp>,
    user?: Awaited<ReturnType<typeof loginAs>>,
  ) {
    const u = user ?? (await loginAs(a, gh));
    const tok = (await api(a, u)('POST', '/api/agents/enrollment-tokens')).json() as {
      token: string;
    };
    const enr = EnrollResponseSchema.parse(
      (
        await a.inject({
          method: 'POST',
          url: '/api/agents/enroll',
          payload: { token: tok.token, machineName: 'box', agentVersion: '0.1.0' },
        })
      ).json(),
    );
    return enr.credential;
  }
  async function listen(a: ReturnType<typeof makeApp>) {
    await a.listen({ port: 0, host: '127.0.0.1' });
    const addr = a.server.address();
    if (!addr || typeof addr === 'string') throw new Error('no address');
    return `ws://127.0.0.1:${addr.port}/agent/ws`;
  }
  const hello = () =>
    JSON.stringify(
      agentMessage('hello', {
        agentVersion: '0.2.0',
        capabilities: ['manual'],
        localPaused: false,
        maxConcurrent: 1,
        running: [],
      }),
    );

  it('closes a connection that floods messages with 4429, normal traffic is fine', async () => {
    const a = app({ RATE_LIMIT_AGENT_MSG_PER_SEC: '20' });
    const url = await listen(a);
    const cred = await enrolled(a);
    const ws = new WebSocket(url, { headers: { authorization: `Bearer ${cred}` } });
    await new Promise((r) => ws.once('open', r));
    const closed = new Promise<number>((r) => ws.once('close', (code) => r(code)));
    ws.send(hello());
    // A handful of messages per second is normal.
    for (let i = 0; i < 5; i++) ws.send(hello());
    await new Promise((r) => setTimeout(r, 100));
    expect(ws.readyState).toBe(WebSocket.OPEN);
    for (let i = 0; i < 200; i++) ws.send(hello());
    expect(await closed).toBe(CloseCode.RATE_LIMITED);
    await shutdown(a);
  });

  it('caps new connections per IP per window', async () => {
    const a = app({ RATE_LIMIT_AGENT_CONNECT_MAX: '2' });
    const url = await listen(a);
    const owner = await loginAs(a, gh);
    const open: WebSocket[] = [];
    const attempt = async () => {
      // One agent per attempt: reconnecting with the same one would supersede the old socket.
      const cred = await enrolled(a, owner);
      return new Promise<number>((resolve) => {
        const ws = new WebSocket(url, { headers: { authorization: `Bearer ${cred}` } });
        ws.once('open', () => {
          open.push(ws);
          resolve(101);
        });
        ws.once('unexpected-response', (_req, res) => {
          res.resume();
          res.socket.destroy();
          ws.terminate();
          resolve(res.statusCode ?? 0);
        });
        ws.once('error', () => undefined);
      });
    };
    expect(await attempt()).toBe(101);
    expect(await attempt()).toBe(101);
    await Promise.all(
      open.map(
        (ws) =>
          new Promise((r) => {
            if (ws.readyState === WebSocket.CLOSED) return r(undefined);
            ws.once('close', r);
            ws.close();
          }),
      ),
    );
    expect(await attempt()).toBe(429);
    await shutdown(a);
  });
});
