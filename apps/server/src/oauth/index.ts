/**
 * MCP OAuth 2.1 authorization server (contract in shared api/oauth), so `claude mcp add` needs no
 * token: Claude Code discovers this server from the 401 of /mcp, registers itself (RFC 7591),
 * sends the member through the consent page (GitHub sign-in when needed) and gets an access
 * token bound to `${public URL}/mcp` (RFC 8707) plus a rotating refresh token.
 *
 * Security notes:
 * - every URL (issuer, endpoints, resource) comes from ORCH_PUBLIC_URL / ORCH_BASE_URL, never
 *   from the request, so it is right behind Cloudflare Tunnel;
 * - public clients only, PKCE S256 mandatory, exact redirect_uri match, loopback http or https;
 * - client ids, codes and tokens are stored as SHA-256 only;
 * - codes are single use (60 s), access tokens live 1 h, refresh tokens rotate and a reused one
 *   revokes the whole grant (token family);
 * - the sign-in allowlist is checked at approval, at every token request and on every /mcp call.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { OAuthClient, OAuthGrant, User } from '@prisma/client';
import {
  OAUTH_ACCESS_TOKEN_PREFIX,
  OAUTH_CLIENT_ID_PREFIX,
  OAUTH_CODE_PREFIX,
  OAUTH_REFRESH_TOKEN_PREFIX,
  OAuthAuthorizeParamsSchema,
  OAuthConsentDecisionSchema,
  mcpAddCommandOAuth,
  type McpSetupView,
  type OAuthAuthorizeParams,
  type OAuthConsentInfo,
  type OAuthConsentResult,
  type OAuthGrantView,
} from '@orch/shared';
import { audit } from '../audit';
import { requireUser, type AuthDeps } from '../auth';
import { randomToken, sha256Hex } from '../auth/crypto';
import type { Config } from '../config';
import type { PrismaClient } from '../db';
import { HttpError, parseBody } from '../http/errors';

export const CODE_TTL_MS = 60_000;
export const ACCESS_TOKEN_TTL_MS = 3600_000;
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 3600_000;
const LAST_USED_RESOLUTION_MS = 60_000;
const SCOPE = 'mcp';
const MAX_REDIRECT_URIS = 5;

/** Fixed-window rate limits per client IP. */
export const RATE_LIMITS = {
  register: { max: 10, windowMs: 10 * 60_000 },
  token: { max: 60, windowMs: 60_000 },
} as const;

export interface OAuthUrls {
  /** Issuer = public origin, e.g. https://orch.example.org */
  issuer: string;
  /** The protected resource (audience of every token): `${issuer}/mcp`. */
  resource: string;
  resourceMetadata: string;
}

export function oauthUrls(config: Config): OAuthUrls {
  const issuer = new URL(config.ORCH_BASE_URL).origin;
  return {
    issuer,
    resource: `${issuer}/mcp`,
    resourceMetadata: `${issuer}/.well-known/oauth-protected-resource/mcp`,
  };
}

export function protectedResourceMetadata(urls: OAuthUrls) {
  return {
    resource: urls.resource,
    authorization_servers: [urls.issuer],
    scopes_supported: [SCOPE],
    bearer_methods_supported: ['header'],
    resource_name: 'orch',
  };
}

export function authorizationServerMetadata(urls: OAuthUrls) {
  return {
    issuer: urls.issuer,
    authorization_endpoint: `${urls.issuer}/api/oauth/authorize`,
    token_endpoint: `${urls.issuer}/api/oauth/token`,
    registration_endpoint: `${urls.issuer}/api/oauth/register`,
    revocation_endpoint: `${urls.issuer}/api/oauth/revoke`,
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    revocation_endpoint_auth_methods_supported: ['none'],
    scopes_supported: [SCOPE],
  };
}

/** Loopback http (any port) or https, absolute, no fragment, no credentials. */
export function isAllowedRedirectUri(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.hash || u.username || u.password || raw.length > 2000) return false;
  if (u.protocol === 'https:') return true;
  if (u.protocol !== 'http:') return false;
  return u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]';
}

const sha256B64Url = (v: string) => createHash('sha256').update(v).digest('base64url');

/** RFC 7636: S256(code_verifier) == code_challenge. */
export function verifyPkce(verifier: unknown, challenge: string): boolean {
  if (typeof verifier !== 'string' || !/^[A-Za-z0-9\-._~]{43,128}$/.test(verifier)) return false;
  const a = Buffer.from(sha256B64Url(verifier));
  const b = Buffer.from(challenge);
  return a.length === b.length && timingSafeEqual(a, b);
}

function redirectHost(uri: string): string {
  try {
    return new URL(uri).host;
  } catch {
    return uri;
  }
}

class RateLimiter {
  private hits = new Map<string, { n: number; reset: number }>();
  constructor(
    private max: number,
    private windowMs: number,
  ) {}
  allow(key: string, now = Date.now()): boolean {
    if (this.hits.size > 10_000) {
      for (const [k, v] of this.hits) if (v.reset <= now) this.hits.delete(k);
    }
    const h = this.hits.get(key);
    if (!h || h.reset <= now) {
      this.hits.set(key, { n: 1, reset: now + this.windowMs });
      return true;
    }
    h.n++;
    return h.n <= this.max;
  }
}

/** RFC 6749 error response (not the `{ error: { code } }` shape of the REST API). */
class OAuthError extends Error {
  constructor(
    readonly error: string,
    readonly description: string,
    readonly status = 400,
  ) {
    super(description);
  }
}

function sendOAuthError(reply: FastifyReply, e: OAuthError) {
  return reply
    .status(e.status)
    .header('Cache-Control', 'no-store')
    .send({ error: e.error, error_description: e.description });
}

/** Simple HTML page for authorization errors that must not redirect (unknown client or URI). */
function errorPage(message: string): string {
  const esc = message.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Authorization error - orch</title>
<style>body{font-family:system-ui,sans-serif;max-width:36rem;margin:4rem auto;padding:0 1rem;line-height:1.5}</style>
</head><body><h1>Authorization error</h1><p>${esc}</p>
<p>Start again from Claude Code: run <code>/mcp</code>, choose orch, then Authenticate.</p>
</body></html>`;
}

const bearerOf = (header: string | undefined): string | null => {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(header ?? '');
  return m?.[1] && m[1].length <= 200 ? m[1] : null;
};

/**
 * Resolves an OAuth access token (`orch_oat_...`) for the resource `resource`, or null (unknown,
 * expired, revoked grant, wrong audience). Records the grant's lastUsedAt.
 */
export async function authenticateOAuthAccessToken(
  prisma: PrismaClient,
  raw: string,
  resource: string,
  now = new Date(),
): Promise<{ user: User; grant: OAuthGrant } | null> {
  if (!raw.startsWith(OAUTH_ACCESS_TOKEN_PREFIX)) return null;
  const token = await prisma.oAuthToken.findUnique({
    where: { tokenHash: sha256Hex(raw) },
    include: { grant: { include: { user: true } } },
  });
  if (
    !token ||
    token.kind !== 'ACCESS' ||
    token.expiresAt.getTime() <= now.getTime() ||
    token.grant.revokedAt ||
    token.grant.resource !== resource
  ) {
    return null;
  }
  const { user, ...grant } = token.grant;
  if (!grant.lastUsedAt || now.getTime() - grant.lastUsedAt.getTime() >= LAST_USED_RESOLUTION_MS) {
    await prisma.oAuthGrant.update({ where: { id: grant.id }, data: { lastUsedAt: now } });
  }
  return { user, grant };
}

export { bearerOf };

interface ValidRequest {
  client: OAuthClient;
  redirectUri: string;
  codeChallenge: string;
  state?: string;
  resource: string;
}

export function registerOAuth(app: FastifyInstance, deps: AuthDeps): void {
  const { prisma, config } = deps;
  const urls = oauthUrls(config);
  const limits = {
    register: new RateLimiter(RATE_LIMITS.register.max, RATE_LIMITS.register.windowMs),
    token: new RateLimiter(RATE_LIMITS.token.max, RATE_LIMITS.token.windowMs),
  };
  let lastPurge = 0;
  const purge = async () => {
    const now = Date.now();
    if (now - lastPurge < 10 * 60_000) return;
    lastPurge = now;
    const before = new Date(now - 24 * 3600_000);
    await prisma.oAuthCode.deleteMany({ where: { expiresAt: { lt: before } } });
    await prisma.oAuthToken.deleteMany({ where: { expiresAt: { lt: before } } });
  };

  const findClient = (clientId: unknown) =>
    typeof clientId === 'string' && clientId.startsWith(OAUTH_CLIENT_ID_PREFIX)
      ? prisma.oAuthClient.findUnique({ where: { clientIdHash: sha256Hex(clientId) } })
      : Promise.resolve(null);

  /**
   * Validates an authorization request. Problems with the client or the redirect URI are
   * `fatal` (never redirect to an unverified URI); the others are reported to the client.
   */
  async function validate(
    p: OAuthAuthorizeParams,
  ): Promise<
    | { ok: true; req: ValidRequest }
    | { ok: false; fatal: true; message: string }
    | { ok: false; fatal: false; redirectUri: string; error: string; message: string }
  > {
    const client = await findClient(p.client_id);
    if (!client) return { ok: false, fatal: true, message: 'Unknown client.' };
    const redirectUri =
      p.redirect_uri ?? (client.redirectUris.length === 1 ? client.redirectUris[0] : undefined);
    if (!redirectUri || !client.redirectUris.includes(redirectUri)) {
      return {
        ok: false,
        fatal: true,
        message: 'The redirect URI is not registered for this client.',
      };
    }
    const fail = (error: string, message: string) =>
      ({ ok: false, fatal: false, redirectUri, error, message }) as const;
    if (p.response_type !== 'code') {
      return fail('unsupported_response_type', 'response_type must be "code".');
    }
    if (!p.code_challenge || p.code_challenge_method !== 'S256') {
      return fail('invalid_request', 'PKCE is required: code_challenge with method S256.');
    }
    if (!/^[A-Za-z0-9\-._~]{43,128}$/.test(p.code_challenge)) {
      return fail('invalid_request', 'Malformed code_challenge.');
    }
    if (p.resource !== undefined && p.resource !== urls.resource) {
      return fail('invalid_target', `Unknown resource; this server protects ${urls.resource}.`);
    }
    return {
      ok: true,
      req: {
        client,
        redirectUri,
        codeChallenge: p.code_challenge,
        state: p.state,
        resource: urls.resource,
      },
    };
  }

  const withParams = (uri: string, params: Record<string, string | undefined>) => {
    const u = new URL(uri);
    for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, v);
    return u.toString();
  };

  // ---------- discovery ----------

  const prm = protectedResourceMetadata(urls);
  const asm = authorizationServerMetadata(urls);
  for (const path of [
    '/.well-known/oauth-protected-resource',
    '/.well-known/oauth-protected-resource/mcp',
  ]) {
    app.get(path, async (_req, reply) => reply.header('Cache-Control', 'max-age=300').send(prm));
  }
  app.get('/.well-known/oauth-authorization-server', async (_req, reply) =>
    reply.header('Cache-Control', 'max-age=300').send(asm),
  );

  // ---------- web app ----------

  app.get('/api/mcp/setup', async (req): Promise<McpSetupView> => {
    requireUser(req);
    return { mcpUrl: urls.resource, mcpAddCommandOAuth: mcpAddCommandOAuth(urls.issuer) };
  });

  // Browser entry point from Claude Code. Sign-in first (and back), then the consent page.
  app.get('/api/oauth/authorize', async (req, reply) => {
    const p = parseBody(OAuthAuthorizeParamsSchema, req.query);
    const v = await validate(p);
    if (!v.ok && v.fatal) {
      return reply.status(400).type('text/html; charset=utf-8').send(errorPage(v.message));
    }
    if (!v.ok) {
      return reply.redirect(
        withParams(v.redirectUri, { error: v.error, error_description: v.message, state: p.state }),
        302,
      );
    }
    const query = new URL(req.url, urls.issuer).search;
    if (!req.user) {
      const next = `/api/oauth/authorize${query}`;
      return reply.redirect(`/api/auth/github/login?next=${encodeURIComponent(next)}`, 302);
    }
    return reply.redirect(`/oauth/consent${query}`, 302);
  });

  app.get('/api/oauth/consent', async (req): Promise<OAuthConsentInfo> => {
    const user = requireUser(req);
    const v = await validate(parseBody(OAuthAuthorizeParamsSchema, req.query));
    if (!v.ok) throw new HttpError(400, v.fatal ? 'invalid_client' : v.error, v.message);
    return {
      clientName: v.req.client.name,
      redirectHost: redirectHost(v.req.redirectUri),
      login: user.login,
      resource: v.req.resource,
    };
  });

  // Approval: POST with a session cookie, under the global Origin (CSRF) check.
  app.post('/api/oauth/consent', async (req): Promise<OAuthConsentResult> => {
    const user = requireUser(req);
    const body = parseBody(OAuthConsentDecisionSchema, req.body);
    const v = await validate(body);
    if (!v.ok && v.fatal) throw new HttpError(400, 'invalid_client', v.message);
    if (!v.ok) {
      return {
        redirectTo: withParams(v.redirectUri, {
          error: v.error,
          error_description: v.message,
          state: body.state,
        }),
      };
    }
    const r = v.req;
    if (!body.approve) {
      await audit(prisma, {
        actorUserId: user.id,
        action: 'oauth.denied',
        ip: req.ip,
        data: { clientId: r.client.id, clientName: r.client.name },
      });
      return { redirectTo: withParams(r.redirectUri, { error: 'access_denied', state: r.state }) };
    }
    const code = `${OAUTH_CODE_PREFIX}${randomToken()}`;
    // One code per authorization request (user + client + PKCE challenge): a double submit, a
    // replayed POST or two tabs must not mint a second code. The advisory lock makes the
    // check-then-create atomic across concurrent requests.
    const lockKey = `oauth-consent:${user.id}:${r.client.id}:${r.codeChallenge}`;
    const issued = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;
      const existing = await tx.oAuthCode.findFirst({
        where: { userId: user.id, clientId: r.client.id, codeChallenge: r.codeChallenge },
        select: { codeHash: true },
      });
      if (existing) return false;
      await tx.oAuthCode.create({
        data: {
          codeHash: sha256Hex(code),
          clientId: r.client.id,
          userId: user.id,
          redirectUri: r.redirectUri,
          codeChallenge: r.codeChallenge,
          resource: r.resource,
          scope: SCOPE,
          expiresAt: new Date(Date.now() + CODE_TTL_MS),
        },
      });
      return true;
    });
    if (!issued) {
      throw new HttpError(
        409,
        'already_approved',
        'This request was already approved. Go back to Claude Code, or start again from /mcp.',
      );
    }
    await audit(prisma, {
      actorUserId: user.id,
      action: 'oauth.granted',
      ip: req.ip,
      data: {
        clientId: r.client.id,
        clientName: r.client.name,
        redirectHost: redirectHost(r.redirectUri),
      },
    });
    return { redirectTo: withParams(r.redirectUri, { code, state: r.state }) };
  });

  app.get('/api/oauth/grants', async (req): Promise<OAuthGrantView[]> => {
    const user = requireUser(req);
    const rows = await prisma.oAuthGrant.findMany({
      where: {
        userId: user.id,
        revokedAt: null,
        tokens: { some: { expiresAt: { gt: new Date() } } },
      },
      include: { client: true },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((g) => ({
      id: g.id,
      clientName: g.client.name,
      redirectHost: redirectHost(g.client.redirectUris[0] ?? ''),
      createdAt: g.createdAt.toISOString(),
      lastUsedAt: g.lastUsedAt?.toISOString() ?? null,
    }));
  });

  app.delete('/api/oauth/grants/:id', async (req, reply) => {
    const user = requireUser(req);
    const { id } = req.params as { id: string };
    const grant = await prisma.oAuthGrant.findUnique({ where: { id } });
    if (!grant || grant.userId !== user.id) throw new HttpError(404, 'not_found', 'No such grant');
    await revokeGrant(grant.id, user.id, 'user', req.ip);
    return reply.status(204).send();
  });

  async function revokeGrant(grantId: string, userId: string, reason: string, ip?: string) {
    const res = await prisma.oAuthGrant.updateMany({
      where: { id: grantId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (res.count === 1) {
      await audit(prisma, {
        actorUserId: userId,
        action: 'oauth.revoked',
        ip,
        data: { grantId, reason },
      });
    }
  }

  // ---------- protocol endpoints (no cookies; form or JSON bodies) ----------

  app.register(async (scope) => {
    scope.addContentTypeParser(
      'application/x-www-form-urlencoded',
      { parseAs: 'string', bodyLimit: 64 * 1024 },
      (_req, body, done) => done(null, Object.fromEntries(new URLSearchParams(body as string))),
    );

    const field = (req: FastifyRequest, name: string): string | undefined => {
      const v = (req.body as Record<string, unknown> | undefined)?.[name];
      return typeof v === 'string' ? v : undefined;
    };

    scope.post('/api/oauth/register', async (req, reply) => {
      if (!limits.register.allow(req.ip)) {
        return sendOAuthError(reply, new OAuthError('slow_down', 'Too many registrations', 429));
      }
      const b = (req.body ?? {}) as Record<string, unknown>;
      const uris = b.redirect_uris;
      if (
        !Array.isArray(uris) ||
        uris.length === 0 ||
        uris.length > MAX_REDIRECT_URIS ||
        !uris.every((u): u is string => typeof u === 'string' && isAllowedRedirectUri(u))
      ) {
        return sendOAuthError(
          reply,
          new OAuthError(
            'invalid_redirect_uri',
            `1 to ${MAX_REDIRECT_URIS} redirect_uris, each https or http on localhost/127.0.0.1/[::1]`,
          ),
        );
      }
      const method = b.token_endpoint_auth_method ?? 'none';
      const grantTypes = b.grant_types ?? ['authorization_code', 'refresh_token'];
      const responseTypes = b.response_types ?? ['code'];
      if (
        method !== 'none' ||
        !Array.isArray(grantTypes) ||
        !grantTypes.every((g) => g === 'authorization_code' || g === 'refresh_token') ||
        !Array.isArray(responseTypes) ||
        !responseTypes.every((r) => r === 'code')
      ) {
        return sendOAuthError(
          reply,
          new OAuthError(
            'invalid_client_metadata',
            'Only public clients (token_endpoint_auth_method "none") with the authorization_code and refresh_token grants are supported',
          ),
        );
      }
      const rawName = typeof b.client_name === 'string' ? b.client_name.trim() : '';
      // Shown on the consent page: no control characters, bounded length.
      const name =
        [...rawName]
          .filter((c) => c.charCodeAt(0) >= 0x20)
          .join('')
          .slice(0, 100) || 'Unnamed client';
      const clientId = `${OAUTH_CLIENT_ID_PREFIX}${randomToken()}`;
      const row = await prisma.oAuthClient.create({
        data: { clientIdHash: sha256Hex(clientId), name, redirectUris: uris },
      });
      await audit(prisma, {
        actorType: 'SYSTEM',
        action: 'oauth.client_registered',
        ip: req.ip,
        data: { clientId: row.id, clientName: name, redirectHosts: uris.map(redirectHost) },
      });
      return reply
        .status(201)
        .header('Cache-Control', 'no-store')
        .send({
          client_id: clientId,
          client_id_issued_at: Math.floor(row.createdAt.getTime() / 1000),
          client_name: name,
          redirect_uris: uris,
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          token_endpoint_auth_method: 'none',
        });
    });

    async function issueTokens(grant: OAuthGrant) {
      const access = `${OAUTH_ACCESS_TOKEN_PREFIX}${randomToken()}`;
      const refresh = `${OAUTH_REFRESH_TOKEN_PREFIX}${randomToken()}`;
      const now = Date.now();
      await prisma.oAuthToken.createMany({
        data: [
          {
            tokenHash: sha256Hex(access),
            grantId: grant.id,
            kind: 'ACCESS',
            expiresAt: new Date(now + ACCESS_TOKEN_TTL_MS),
          },
          {
            tokenHash: sha256Hex(refresh),
            grantId: grant.id,
            kind: 'REFRESH',
            expiresAt: new Date(now + REFRESH_TOKEN_TTL_MS),
          },
        ],
      });
      return {
        access_token: access,
        token_type: 'Bearer',
        expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
        refresh_token: refresh,
        scope: grant.scope,
      };
    }

    /** The allowlist applies to tokens too: a removed user is denied (nothing is revoked). */
    async function ensureAllowed(user: User) {
      const decision = await app.allowlist.check(user);
      if (decision === 'refused') {
        throw new OAuthError('invalid_grant', 'This account is no longer allowed on this server');
      }
      if (decision === 'reauth') {
        throw new OAuthError('invalid_grant', 'Sign in with GitHub again');
      }
    }

    async function codeGrant(req: FastifyRequest, client: OAuthClient) {
      const code = field(req, 'code');
      if (!code || !code.startsWith(OAUTH_CODE_PREFIX) || code.length > 200) {
        throw new OAuthError('invalid_grant', 'Invalid authorization code');
      }
      const codeHash = sha256Hex(code);
      const row = await prisma.oAuthCode.findUnique({
        where: { codeHash },
        include: { user: true },
      });
      if (!row || row.clientId !== client.id) {
        throw new OAuthError('invalid_grant', 'Invalid authorization code');
      }
      // Single use: the first presentation burns it, whatever its outcome.
      const burned = await prisma.oAuthCode.updateMany({
        where: { codeHash, usedAt: null },
        data: { usedAt: new Date() },
      });
      if (burned.count !== 1) {
        const again = await prisma.oAuthCode.findUnique({ where: { codeHash } });
        if (again?.grantId) await revokeGrant(again.grantId, row.userId, 'code_reuse', req.ip);
        throw new OAuthError('invalid_grant', 'Authorization code already used');
      }
      if (row.expiresAt.getTime() <= Date.now()) {
        throw new OAuthError('invalid_grant', 'Authorization code expired');
      }
      if (field(req, 'redirect_uri') !== row.redirectUri) {
        throw new OAuthError(
          'invalid_grant',
          'redirect_uri does not match the authorization request',
        );
      }
      if (!verifyPkce(field(req, 'code_verifier'), row.codeChallenge)) {
        throw new OAuthError('invalid_grant', 'PKCE verification failed');
      }
      const resource = field(req, 'resource');
      if (resource !== undefined && resource !== row.resource) {
        throw new OAuthError('invalid_target', 'resource does not match the authorization request');
      }
      await ensureAllowed(row.user);
      const grant = await prisma.oAuthGrant.create({
        data: { userId: row.userId, clientId: client.id, resource: row.resource, scope: row.scope },
      });
      await prisma.oAuthCode.update({ where: { codeHash }, data: { grantId: grant.id } });
      const tokens = await issueTokens(grant);
      await audit(prisma, {
        actorUserId: row.userId,
        action: 'oauth.token_issued',
        ip: req.ip,
        data: { grantId: grant.id, clientId: client.id, grantType: 'authorization_code' },
      });
      return tokens;
    }

    async function refreshGrant(req: FastifyRequest, client: OAuthClient) {
      const raw = field(req, 'refresh_token');
      if (!raw || !raw.startsWith(OAUTH_REFRESH_TOKEN_PREFIX) || raw.length > 200) {
        throw new OAuthError('invalid_grant', 'Invalid refresh token');
      }
      const tokenHash = sha256Hex(raw);
      const row = await prisma.oAuthToken.findUnique({
        where: { tokenHash },
        include: { grant: { include: { user: true } } },
      });
      if (!row || row.kind !== 'REFRESH' || row.grant.clientId !== client.id) {
        throw new OAuthError('invalid_grant', 'Invalid refresh token');
      }
      const { user, ...grant } = row.grant;
      if (grant.revokedAt) throw new OAuthError('invalid_grant', 'Grant revoked');
      // Denied before rotating, so a temporarily removed user keeps a usable refresh token.
      await ensureAllowed(user);
      // Rotation: the first use wins; any later use is a replay and kills the family.
      const used = await prisma.oAuthToken.updateMany({
        where: { tokenHash, usedAt: null },
        data: { usedAt: new Date() },
      });
      if (used.count !== 1) {
        await revokeGrant(grant.id, grant.userId, 'refresh_token_reuse', req.ip);
        throw new OAuthError('invalid_grant', 'Refresh token already used; the grant is revoked');
      }
      if (row.expiresAt.getTime() <= Date.now()) {
        throw new OAuthError('invalid_grant', 'Refresh token expired');
      }
      const resource = field(req, 'resource');
      if (resource !== undefined && resource !== grant.resource) {
        throw new OAuthError('invalid_target', 'resource does not match the grant');
      }
      const tokens = await issueTokens(grant);
      await audit(prisma, {
        actorUserId: grant.userId,
        action: 'oauth.token_issued',
        ip: req.ip,
        data: { grantId: grant.id, clientId: client.id, grantType: 'refresh_token' },
      });
      return tokens;
    }

    scope.post('/api/oauth/token', async (req, reply) => {
      try {
        if (!limits.token.allow(req.ip)) {
          throw new OAuthError('slow_down', 'Too many token requests', 429);
        }
        await purge();
        const client = await findClient(field(req, 'client_id'));
        if (!client) throw new OAuthError('invalid_client', 'Unknown client', 401);
        const grantType = field(req, 'grant_type');
        const tokens =
          grantType === 'authorization_code'
            ? await codeGrant(req, client)
            : grantType === 'refresh_token'
              ? await refreshGrant(req, client)
              : null;
        if (!tokens) throw new OAuthError('unsupported_grant_type', 'Unsupported grant_type');
        return reply.header('Cache-Control', 'no-store').header('Pragma', 'no-cache').send(tokens);
      } catch (e) {
        if (e instanceof OAuthError) return sendOAuthError(reply, e);
        throw e;
      }
    });

    // RFC 7009: revoking an access or refresh token revokes its grant. Always 200.
    scope.post('/api/oauth/revoke', async (req, reply) => {
      if (!limits.token.allow(req.ip)) {
        return sendOAuthError(reply, new OAuthError('slow_down', 'Too many requests', 429));
      }
      const raw = field(req, 'token');
      if (raw && raw.length <= 200) {
        const row = await prisma.oAuthToken.findUnique({
          where: { tokenHash: sha256Hex(raw) },
          include: { grant: true },
        });
        if (row) await revokeGrant(row.grantId, row.grant.userId, 'revocation_endpoint', req.ip);
      }
      return reply.status(200).send({});
    });
  });
}
