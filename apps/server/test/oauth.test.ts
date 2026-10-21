import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { auth, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import {
  McpSetupViewSchema,
  OAuthConsentInfoSchema,
  OAuthGrantListResponseSchema,
} from '@orch/shared';
import { sha256Hex } from '../src/auth/crypto';
import { FakeGithub, api, loginAs, makeApp, prisma, type TestUser } from './harness';

const BASE = 'http://localhost:8470';
const REDIRECT = 'http://127.0.0.1:33418/callback';

let gh: FakeGithub;
let app: FastifyInstance;
let ipSeq = 1;
/** A distinct client IP per call site, so the per-IP rate limits do not interfere. */
const nextIp = () => `10.9.${Math.floor(ipSeq / 250)}.${(ipSeq++ % 250) + 1}`;

beforeAll(() => {
  gh = new FakeGithub();
  app = makeApp(gh);
});
afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

const pkce = () => {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
};

async function register(a = app, body: Record<string, unknown> = {}, ip = nextIp()) {
  return a.inject({
    method: 'POST',
    url: '/api/oauth/register',
    headers: { 'x-forwarded-for': ip },
    payload: {
      client_name: 'Claude Code (orch)',
      redirect_uris: [REDIRECT],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      ...body,
    },
  });
}

async function newClient(a = app): Promise<string> {
  const res = await register(a);
  expect(res.statusCode).toBe(201);
  return res.json<{ client_id: string }>().client_id;
}

function authorizeQuery(clientId: string, challenge: string, over: Record<string, string> = {}) {
  return new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'st-123',
    resource: `${BASE}/mcp`,
    ...over,
  });
}

/** Consent POST as the signed-in user; returns the redirect target. */
async function consent(
  user: TestUser,
  clientId: string,
  challenge: string,
  approve = true,
  over: Record<string, string> = {},
  a = app,
) {
  const q = Object.fromEntries(authorizeQuery(clientId, challenge, over));
  const res = await a.inject({
    method: 'POST',
    url: '/api/oauth/consent',
    headers: { cookie: user.cookie, origin: BASE },
    payload: { ...q, approve },
  });
  expect(res.statusCode).toBe(200);
  return new URL(res.json<{ redirectTo: string }>().redirectTo);
}

async function getCode(user: TestUser, clientId: string, a = app) {
  const p = pkce();
  const to = await consent(user, clientId, p.challenge, true, {}, a);
  expect(to.searchParams.get('state')).toBe('st-123');
  return { code: to.searchParams.get('code')!, verifier: p.verifier };
}

async function token(form: Record<string, string>, a = app, ip = nextIp()) {
  return a.inject({
    method: 'POST',
    url: '/api/oauth/token',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-for': ip },
    payload: new URLSearchParams(form).toString(),
  });
}

async function exchange(clientId: string, code: string, verifier: string, a = app) {
  return token(
    {
      grant_type: 'authorization_code',
      client_id: clientId,
      code,
      code_verifier: verifier,
      redirect_uri: REDIRECT,
      resource: `${BASE}/mcp`,
    },
    a,
  );
}

interface Tokens {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
}

async function fullFlow(user: TestUser, a = app) {
  const clientId = await newClient(a);
  const { code, verifier } = await getCode(user, clientId, a);
  const res = await exchange(clientId, code, verifier, a);
  expect(res.statusCode).toBe(200);
  return { clientId, tokens: res.json<Tokens>() };
}

async function mcpCall(bearer: string | null, a = app) {
  return a.inject({
    method: 'POST',
    url: '/mcp',
    headers: {
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    payload: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
  });
}

describe('discovery metadata', () => {
  it('serves RFC 9728 and RFC 8414 documents built from ORCH_PUBLIC_URL, not the request', async () => {
    const pub = makeApp(gh, { env: { ORCH_PUBLIC_URL: 'https://orch.example.org' } });
    const headers = { host: 'evil.example', 'x-forwarded-proto': 'http' };
    for (const url of [
      '/.well-known/oauth-protected-resource',
      '/.well-known/oauth-protected-resource/mcp',
    ]) {
      const r = await pub.inject({ method: 'GET', url, headers });
      expect(r.statusCode).toBe(200);
      expect(r.json()).toMatchObject({
        resource: 'https://orch.example.org/mcp',
        authorization_servers: ['https://orch.example.org'],
        bearer_methods_supported: ['header'],
      });
    }
    const as = await pub.inject({
      method: 'GET',
      url: '/.well-known/oauth-authorization-server',
      headers,
    });
    expect(as.json()).toMatchObject({
      issuer: 'https://orch.example.org',
      authorization_endpoint: 'https://orch.example.org/api/oauth/authorize',
      token_endpoint: 'https://orch.example.org/api/oauth/token',
      registration_endpoint: 'https://orch.example.org/api/oauth/register',
      code_challenge_methods_supported: ['S256'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_methods_supported: ['none'],
    });
    await pub.close();
  });

  it('/mcp answers 401 with resource_metadata (and invalid_token for a bad token)', async () => {
    const none = await mcpCall(null);
    expect(none.statusCode).toBe(401);
    expect(none.headers['www-authenticate']).toBe(
      `Bearer resource_metadata="${BASE}/.well-known/oauth-protected-resource/mcp"`,
    );
    const bad = await mcpCall('orch_oat_nope');
    expect(bad.statusCode).toBe(401);
    expect(bad.headers['www-authenticate']).toContain('error="invalid_token"');
    expect(bad.headers['www-authenticate']).toContain('resource_metadata=');
    const get = await app.inject({ method: 'GET', url: '/mcp' });
    expect(get.statusCode).toBe(401);
    expect(get.headers['www-authenticate']).toContain('resource_metadata=');
  });
});

describe('dynamic client registration', () => {
  it('registers a public client, stores only the hash and audits it', async () => {
    const res = await register();
    expect(res.statusCode).toBe(201);
    const body = res.json<Record<string, unknown>>();
    expect(body).toMatchObject({
      client_name: 'Claude Code (orch)',
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: 'none',
    });
    const clientId = body.client_id as string;
    expect(clientId.startsWith('orch_cli_')).toBe(true);
    expect(body.client_secret).toBeUndefined();
    const row = await prisma.oAuthClient.findUniqueOrThrow({
      where: { clientIdHash: sha256Hex(clientId) },
    });
    expect(JSON.stringify(row)).not.toContain(clientId);
    const a = await prisma.auditLog.findFirst({
      where: { action: 'oauth.client_registered', data: { path: ['clientId'], equals: row.id } },
    });
    expect(a).not.toBeNull();
  });

  it('accepts loopback http on any port and https; rejects the rest', async () => {
    for (const uri of [
      'http://localhost:1/cb',
      'http://127.0.0.1:65000/x',
      'http://[::1]:8080/cb',
      'https://app.example.org/cb',
    ]) {
      expect((await register(app, { redirect_uris: [uri] })).statusCode).toBe(201);
    }
    for (const uri of [
      'http://example.org/cb',
      'myapp://cb',
      'javascript:alert(1)',
      'https://a.example.org/cb#frag',
      'not a url',
    ]) {
      const r = await register(app, { redirect_uris: [uri] });
      expect(r.statusCode).toBe(400);
      expect(r.json()).toMatchObject({ error: 'invalid_redirect_uri' });
    }
    expect((await register(app, { redirect_uris: [] })).statusCode).toBe(400);
    const secret = await register(app, { token_endpoint_auth_method: 'client_secret_post' });
    expect(secret.json()).toMatchObject({ error: 'invalid_client_metadata' });
    const implicit = await register(app, { response_types: ['token'] });
    expect(implicit.json()).toMatchObject({ error: 'invalid_client_metadata' });
  });

  it('rate limits /register and /token per client IP', async () => {
    const ip = nextIp();
    const codes: number[] = [];
    for (let i = 0; i < 11; i++) codes.push((await register(app, {}, ip)).statusCode);
    expect(codes.slice(0, 10).every((c) => c === 201)).toBe(true);
    expect(codes[10]).toBe(429);
    const tip = nextIp();
    let last = 0;
    for (let i = 0; i < 61; i++) {
      last = (await token({ grant_type: 'refresh_token', client_id: 'x' }, app, tip)).statusCode;
    }
    expect(last).toBe(429);
  });
});

describe('authorization code flow with PKCE', () => {
  it('sends a signed-out browser to GitHub sign-in and back, then to the consent page', async () => {
    const clientId = await newClient();
    const q = authorizeQuery(clientId, pkce().challenge).toString();
    const out = await app.inject({ method: 'GET', url: `/api/oauth/authorize?${q}` });
    expect(out.statusCode).toBe(302);
    const loc = new URL(out.headers.location as string, BASE);
    expect(loc.pathname).toBe('/api/auth/github/login');
    expect(loc.searchParams.get('next')).toBe(`/api/oauth/authorize?${q}`);

    // The login route remembers `next`; the callback returns there.
    const login = await app.inject({ method: 'GET', url: `${loc.pathname}${loc.search}` });
    const next = ([] as string[])
      .concat(login.headers['set-cookie'] as string[])
      .find((c) => c.startsWith('orch_login_next='))!
      .split(';')[0]!;
    gh.users.set('tok-nextuser', { id: 987654321, login: 'next-user', name: null, avatarUrl: '' });
    const cb = await app.inject({
      method: 'GET',
      url: '/api/auth/github/callback?code=nextuser&state=s9',
      headers: { cookie: `orch_oauth_state=s9; ${next}` },
    });
    expect(cb.statusCode).toBe(302);
    expect(cb.headers.location).toBe(`/api/oauth/authorize?${q}`);

    const user = await loginAs(app, gh);
    const inside = await app.inject({
      method: 'GET',
      url: `/api/oauth/authorize?${q}`,
      headers: { cookie: user.cookie },
    });
    expect(inside.statusCode).toBe(302);
    expect(inside.headers.location).toBe(`/oauth/consent?${q}`);
  });

  it('ignores unsafe sign-in return paths', async () => {
    for (const next of ['//evil.example/x', 'https://evil.example', '/\\evil.example']) {
      const r = await app.inject({
        method: 'GET',
        url: `/api/auth/github/login?next=${encodeURIComponent(next)}`,
      });
      const cookies = ([] as string[]).concat(r.headers['set-cookie'] as string[]);
      expect(cookies.find((c) => c.startsWith('orch_login_next='))).toMatch(/^orch_login_next=;/);
    }
  });

  it('the consent API requires a session and the approval passes the CSRF check', async () => {
    const user = await loginAs(app, gh);
    const clientId = await newClient();
    const q = authorizeQuery(clientId, pkce().challenge);
    const anon = await app.inject({ method: 'GET', url: `/api/oauth/consent?${q}` });
    expect(anon.statusCode).toBe(401);
    const post = await app.inject({
      method: 'POST',
      url: '/api/oauth/consent',
      payload: { ...Object.fromEntries(q), approve: true },
    });
    expect(post.statusCode).toBe(401);
    const csrf = await app.inject({
      method: 'POST',
      url: '/api/oauth/consent',
      headers: { cookie: user.cookie, origin: 'https://evil.example' },
      payload: { ...Object.fromEntries(q), approve: true },
    });
    expect(csrf.statusCode).toBe(403);
    const info = await app.inject({
      method: 'GET',
      url: `/api/oauth/consent?${q}`,
      headers: { cookie: user.cookie },
    });
    expect(info.statusCode).toBe(200);
    expect(OAuthConsentInfoSchema.parse(info.json())).toEqual({
      clientName: 'Claude Code (orch)',
      redirectHost: '127.0.0.1:33418',
      login: user.login,
      resource: `${BASE}/mcp`,
    });
  });

  it('issues tokens for the right verifier; rejects a missing or wrong one', async () => {
    const user = await loginAs(app, gh);
    const clientId = await newClient();

    const a = await getCode(user, clientId);
    const missing = await token({
      grant_type: 'authorization_code',
      client_id: clientId,
      code: a.code,
      redirect_uri: REDIRECT,
    });
    expect(missing.statusCode).toBe(400);
    expect(missing.json()).toMatchObject({ error: 'invalid_grant' });

    const b = await getCode(user, clientId);
    const wrong = await exchange(clientId, b.code, pkce().verifier);
    expect(wrong.json()).toMatchObject({ error: 'invalid_grant' });
    // The failed attempt burned the code.
    expect((await exchange(clientId, b.code, b.verifier)).statusCode).toBe(400);

    const c = await getCode(user, clientId);
    const ok = await exchange(clientId, c.code, c.verifier);
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['cache-control']).toBe('no-store');
    const t = ok.json<Tokens>();
    expect(t.access_token.startsWith('orch_oat_')).toBe(true);
    expect(t.refresh_token.startsWith('orch_ort_')).toBe(true);
    expect(t.token_type).toBe('Bearer');
    expect(t.expires_in).toBe(3600);
    // Stored hashed only.
    const row = await prisma.oAuthToken.findUnique({
      where: { tokenHash: sha256Hex(t.access_token) },
    });
    expect(row?.kind).toBe('ACCESS');
    expect(await prisma.oAuthCode.findUnique({ where: { codeHash: c.code } })).toBeNull();

    const call = await mcpCall(t.access_token);
    expect(call.statusCode).toBe(200);
    expect(call.body).toContain('submit_task');

    for (const action of ['oauth.granted', 'oauth.token_issued']) {
      expect(
        await prisma.auditLog.count({ where: { actorUserId: user.userId, action } }),
      ).toBeGreaterThan(0);
    }
  });

  it('requires PKCE S256 and response_type=code at authorization', async () => {
    const user = await loginAs(app, gh);
    const clientId = await newClient();
    const plain = await consent(user, clientId, pkce().challenge, true, {
      code_challenge_method: 'plain',
    });
    expect(plain.searchParams.get('error')).toBe('invalid_request');
    expect(plain.searchParams.get('code')).toBeNull();
    const none = await consent(user, clientId, '', true);
    expect(none.searchParams.get('error')).toBe('invalid_request');
    const implicit = await consent(user, clientId, pkce().challenge, true, {
      response_type: 'token',
    });
    expect(implicit.searchParams.get('error')).toBe('unsupported_response_type');
    expect(implicit.searchParams.get('state')).toBe('st-123');
  });

  it('a denial goes back with access_denied and the state', async () => {
    const user = await loginAs(app, gh);
    const to = await consent(user, await newClient(), pkce().challenge, false);
    expect(`${to.origin}${to.pathname}`).toBe(REDIRECT);
    expect(to.searchParams.get('error')).toBe('access_denied');
    expect(to.searchParams.get('state')).toBe('st-123');
  });

  it('rejects redirect_uri mismatches without redirecting', async () => {
    const user = await loginAs(app, gh);
    const clientId = await newClient();
    const q = authorizeQuery(clientId, pkce().challenge, {
      redirect_uri: 'http://127.0.0.1:33419/callback',
    });
    const r = await app.inject({
      method: 'GET',
      url: `/api/oauth/authorize?${q}`,
      headers: { cookie: user.cookie },
    });
    expect(r.statusCode).toBe(400);
    expect(r.headers.location).toBeUndefined();
    const info = await app.inject({
      method: 'GET',
      url: `/api/oauth/consent?${q}`,
      headers: { cookie: user.cookie },
    });
    expect(info.statusCode).toBe(400);
    const unknown = await app.inject({
      method: 'GET',
      url: `/api/oauth/authorize?${authorizeQuery('orch_cli_unknown', pkce().challenge)}`,
      headers: { cookie: user.cookie },
    });
    expect(unknown.statusCode).toBe(400);

    // At the token endpoint the redirect_uri must equal the one of the request.
    const c = await getCode(user, clientId);
    const res = await token({
      grant_type: 'authorization_code',
      client_id: clientId,
      code: c.code,
      code_verifier: c.verifier,
      redirect_uri: 'http://127.0.0.1:33418/other',
    });
    expect(res.json()).toMatchObject({ error: 'invalid_grant' });
  });

  it('a code is single use: reuse fails and revokes the tokens it produced', async () => {
    const user = await loginAs(app, gh);
    const clientId = await newClient();
    const c = await getCode(user, clientId);
    const first = await exchange(clientId, c.code, c.verifier);
    expect(first.statusCode).toBe(200);
    expect((await mcpCall(first.json<Tokens>().access_token)).statusCode).toBe(200);
    const again = await exchange(clientId, c.code, c.verifier);
    expect(again.json()).toMatchObject({ error: 'invalid_grant' });
    expect((await mcpCall(first.json<Tokens>().access_token)).statusCode).toBe(401);
  });

  it('a code from another client or an expired code is refused', async () => {
    const user = await loginAs(app, gh);
    const clientId = await newClient();
    const other = await newClient();
    const c = await getCode(user, clientId);
    expect((await exchange(other, c.code, c.verifier)).json()).toMatchObject({
      error: 'invalid_grant',
    });
    const d = await getCode(user, clientId);
    await prisma.oAuthCode.update({
      where: { codeHash: sha256Hex(d.code) },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expect((await exchange(clientId, d.code, d.verifier)).json()).toMatchObject({
      error: 'invalid_grant',
    });
    const unknownClient = await exchange('orch_cli_nope', d.code, d.verifier);
    expect(unknownClient.statusCode).toBe(401);
    expect(unknownClient.json()).toMatchObject({ error: 'invalid_client' });
  });
});

describe('refresh tokens', () => {
  it('rotate on use; reusing an old one revokes the whole family', async () => {
    const user = await loginAs(app, gh);
    const { clientId, tokens: t1 } = await fullFlow(user);
    const r2 = await token({
      grant_type: 'refresh_token',
      client_id: clientId,
      refresh_token: t1.refresh_token,
    });
    expect(r2.statusCode).toBe(200);
    const t2 = r2.json<Tokens>();
    expect(t2.refresh_token).not.toBe(t1.refresh_token);
    expect((await mcpCall(t2.access_token)).statusCode).toBe(200);

    const replay = await token({
      grant_type: 'refresh_token',
      client_id: clientId,
      refresh_token: t1.refresh_token,
    });
    expect(replay.json()).toMatchObject({ error: 'invalid_grant' });
    // Family revoked: the new tokens die too.
    expect((await mcpCall(t2.access_token)).statusCode).toBe(401);
    const after = await token({
      grant_type: 'refresh_token',
      client_id: clientId,
      refresh_token: t2.refresh_token,
    });
    expect(after.json()).toMatchObject({ error: 'invalid_grant' });
    expect(
      await prisma.auditLog.count({
        where: { actorUserId: user.userId, action: 'oauth.revoked' },
      }),
    ).toBe(1);
  });

  it('a refresh token only works for its own client', async () => {
    const user = await loginAs(app, gh);
    const { tokens } = await fullFlow(user);
    const other = await newClient();
    const r = await token({
      grant_type: 'refresh_token',
      client_id: other,
      refresh_token: tokens.refresh_token,
    });
    expect(r.json()).toMatchObject({ error: 'invalid_grant' });
  });
});

describe('expiry and audience', () => {
  it('expired access and refresh tokens are refused', async () => {
    const user = await loginAs(app, gh);
    const { clientId, tokens } = await fullFlow(user);
    const past = new Date(Date.now() - 1000);
    await prisma.oAuthToken.update({
      where: { tokenHash: sha256Hex(tokens.access_token) },
      data: { expiresAt: past },
    });
    const r = await mcpCall(tokens.access_token);
    expect(r.statusCode).toBe(401);
    expect(r.headers['www-authenticate']).toContain('error="invalid_token"');
    await prisma.oAuthToken.update({
      where: { tokenHash: sha256Hex(tokens.refresh_token) },
      data: { expiresAt: past },
    });
    const ref = await token({
      grant_type: 'refresh_token',
      client_id: clientId,
      refresh_token: tokens.refresh_token,
    });
    expect(ref.json()).toMatchObject({ error: 'invalid_grant' });
  });

  it('tokens are bound to this server /mcp: another audience is refused', async () => {
    const user = await loginAs(app, gh);
    const { tokens } = await fullFlow(user);
    const elsewhere = makeApp(gh, { env: { ORCH_BASE_URL: 'https://other.example.org' } });
    const r = await mcpCall(tokens.access_token, elsewhere);
    expect(r.statusCode).toBe(401);
    expect(r.headers['www-authenticate']).toContain(
      'resource_metadata="https://other.example.org/.well-known/oauth-protected-resource/mcp"',
    );
    await elsewhere.close();
    expect((await mcpCall(tokens.access_token)).statusCode).toBe(200);

    // A foreign resource indicator is refused at authorization and at the token endpoint.
    const clientId = await newClient();
    const bad = await consent(user, clientId, pkce().challenge, true, {
      resource: 'https://evil.example/mcp',
    });
    expect(bad.searchParams.get('error')).toBe('invalid_target');
    const c = await getCode(user, clientId);
    const res = await token({
      grant_type: 'authorization_code',
      client_id: clientId,
      code: c.code,
      code_verifier: c.verifier,
      redirect_uri: REDIRECT,
      resource: 'https://evil.example/mcp',
    });
    expect(res.json()).toMatchObject({ error: 'invalid_target' });
  });
});

describe('PATs, allowlist, grants page', () => {
  it('a personal access token still works on /mcp', async () => {
    const user = await loginAs(app, gh);
    const pat = await api(app, user)('POST', '/api/tokens', { name: 'script' });
    expect(pat.statusCode).toBe(201);
    const body = pat.json<{ token: string; mcpAddCommand: string; mcpAddCommandOAuth: string }>();
    expect(body.mcpAddCommand).toContain('--header');
    expect(body.mcpAddCommandOAuth).toBe(
      `claude mcp add --transport http --scope user orch ${BASE}/mcp`,
    );
    expect((await mcpCall(body.token)).statusCode).toBe(200);
  });

  it('a user removed from the allowlist is denied everywhere, but nothing is destroyed', async () => {
    const user = await loginAs(app, gh);
    const { clientId, tokens } = await fullFlow(user);
    const pat = (await api(app, user)('POST', '/api/tokens', { name: 'p' })).json<{
      token: string;
    }>();
    // Same database, but this server only allows someone else.
    const restricted = makeApp(gh, { env: { ORCH_ALLOWED_GITHUB_LOGINS: 'somebody-else' } });
    expect((await mcpCall(tokens.access_token, restricted)).statusCode).toBe(401);
    expect((await mcpCall(pat.token, restricted)).statusCode).toBe(401);
    expect((await api(restricted, user)('GET', '/api/tokens')).statusCode).toBe(401);
    const ref = await token(
      { grant_type: 'refresh_token', client_id: clientId, refresh_token: tokens.refresh_token },
      restricted,
    );
    expect(ref.json()).toMatchObject({ error: 'invalid_grant' });
    // Nothing was revoked: the rows are intact and access returns with the user.
    expect(
      await prisma.personalToken.count({ where: { userId: user.userId, revokedAt: null } }),
    ).toBe(1);
    expect(await prisma.oAuthGrant.count({ where: { userId: user.userId, revokedAt: null } })).toBe(
      1,
    );
    expect(await prisma.session.count({ where: { userId: user.userId } })).toBeGreaterThan(0);
    expect((await mcpCall(tokens.access_token)).statusCode).toBe(200);
    expect((await mcpCall(pat.token)).statusCode).toBe(200);
    expect((await api(app, user)('GET', '/api/tokens')).statusCode).toBe(200);
    const again = await token({
      grant_type: 'refresh_token',
      client_id: clientId,
      refresh_token: tokens.refresh_token,
    });
    expect(again.statusCode).toBe(200);
    await restricted.close();
  });

  it('a removed user cannot exchange a code or refresh', async () => {
    const user = await loginAs(app, gh);
    const restricted = makeApp(gh, { env: { ORCH_ALLOWED_GITHUB_LOGINS: 'somebody-else' } });
    const clientId = await newClient();
    const c = await getCode(user, clientId);
    expect((await exchange(clientId, c.code, c.verifier, restricted)).json()).toMatchObject({
      error: 'invalid_grant',
    });
    await restricted.close();
  });

  it('lists active grants and revokes one', async () => {
    const user = await loginAs(app, gh);
    const other = await loginAs(app, gh);
    const { tokens } = await fullFlow(user);
    const list = await api(app, user)('GET', '/api/oauth/grants');
    const grants = OAuthGrantListResponseSchema.parse(list.json());
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({
      clientName: 'Claude Code (orch)',
      redirectHost: '127.0.0.1:33418',
    });
    expect((await api(app, other)('DELETE', `/api/oauth/grants/${grants[0]!.id}`)).statusCode).toBe(
      404,
    );
    expect((await api(app, user)('DELETE', `/api/oauth/grants/${grants[0]!.id}`)).statusCode).toBe(
      204,
    );
    expect((await mcpCall(tokens.access_token)).statusCode).toBe(401);
    expect((await api(app, user)('GET', '/api/oauth/grants')).json()).toEqual([]);
    expect((await api(app, null)('GET', '/api/oauth/grants')).statusCode).toBe(401);
  });

  it('the revocation endpoint revokes the grant', async () => {
    const user = await loginAs(app, gh);
    const { tokens } = await fullFlow(user);
    const r = await app.inject({
      method: 'POST',
      url: '/api/oauth/revoke',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://x.example' },
      payload: `token=${tokens.refresh_token}`,
    });
    expect(r.statusCode).toBe(200);
    expect((await mcpCall(tokens.access_token)).statusCode).toBe(401);
  });

  it('GET /api/mcp/setup gives the one-line command', async () => {
    const user = await loginAs(app, gh);
    const r = await api(app, user)('GET', '/api/mcp/setup');
    expect(McpSetupViewSchema.parse(r.json())).toEqual({
      mcpUrl: `${BASE}/mcp`,
      mcpAddCommandOAuth: `claude mcp add --transport http --scope user orch ${BASE}/mcp`,
    });
  });
});

describe('MCP SDK client end to end', () => {
  it('discovers, registers, authorizes with PKCE and calls a tool', async () => {
    const port = await new Promise<number>((resolve) => {
      const s = createServer();
      s.listen(0, '127.0.0.1', () => {
        const p = (s.address() as { port: number }).port;
        s.close(() => resolve(p));
      });
    });
    const base = `http://127.0.0.1:${port}`;
    const live = makeApp(gh, { env: { ORCH_BASE_URL: base } });
    await live.listen({ port, host: '127.0.0.1' });
    try {
      const user = await loginAs(live, gh);
      let clientInfo: OAuthClientInformationMixed | undefined;
      let saved: OAuthTokens | undefined;
      let verifier = '';
      let authUrl: URL | undefined;
      const provider: OAuthClientProvider = {
        get redirectUrl() {
          return REDIRECT;
        },
        get clientMetadata(): OAuthClientMetadata {
          return {
            client_name: 'sdk-test',
            redirect_uris: [REDIRECT],
            grant_types: ['authorization_code', 'refresh_token'],
            response_types: ['code'],
            token_endpoint_auth_method: 'none',
          };
        },
        state: () => 'sdk-state',
        clientInformation: () => clientInfo,
        saveClientInformation: (i) => {
          clientInfo = i;
        },
        tokens: () => saved,
        saveTokens: (t) => {
          saved = t;
        },
        redirectToAuthorization: (u) => {
          authUrl = u;
        },
        saveCodeVerifier: (v) => {
          verifier = v;
        },
        codeVerifier: () => verifier,
      };
      const serverUrl = new URL(`${base}/mcp`);
      expect(await auth(provider, { serverUrl })).toBe('REDIRECT');
      expect(authUrl!.searchParams.get('resource')).toBe(`${base}/mcp`);
      expect(authUrl!.searchParams.get('code_challenge_method')).toBe('S256');

      // The browser: authorize (signed in) -> consent page -> approve.
      const r1 = await fetch(authUrl!, { redirect: 'manual', headers: { cookie: user.cookie } });
      expect(r1.status).toBe(302);
      const consentUrl = new URL(r1.headers.get('location')!, base);
      expect(consentUrl.pathname).toBe('/oauth/consent');
      const r2 = await fetch(`${base}/api/oauth/consent`, {
        method: 'POST',
        headers: { cookie: user.cookie, origin: base, 'content-type': 'application/json' },
        body: JSON.stringify({ ...Object.fromEntries(consentUrl.searchParams), approve: true }),
      });
      const back = new URL(((await r2.json()) as { redirectTo: string }).redirectTo);
      expect(back.searchParams.get('state')).toBe('sdk-state');
      const code = back.searchParams.get('code')!;
      expect(await auth(provider, { serverUrl, authorizationCode: code })).toBe('AUTHORIZED');
      expect(saved?.access_token.startsWith('orch_oat_')).toBe(true);

      const client = new McpClient({ name: 'sdk-test', version: '0' });
      await client.connect(
        new StreamableHTTPClientTransport(serverUrl, { authProvider: provider }),
      );
      const tools = await client.listTools();
      expect(tools.tools.map((t) => t.name)).toContain('view_pool');
      const pool = await client.callTool({ name: 'view_pool', arguments: {} });
      expect(pool.isError).toBeFalsy();
      await client.close();
    } finally {
      await live.close();
    }
  });
});
