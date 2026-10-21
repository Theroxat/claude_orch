import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { User } from '@prisma/client';
import type { ApiUser } from '@orch/shared';
import { audit } from '../audit';
import { signInIsRestricted, type Config } from '../config';
import type { PrismaClient } from '../db';
import type { GithubClient } from '../github';
import { HttpError } from '../http/errors';
import { decrypt, encrypt, randomToken, sha256Hex } from './crypto';

export const SESSION_COOKIE = 'orch_session';
const STATE_COOKIE = 'orch_oauth_state';
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;

const NEXT_COOKIE = 'orch_login_next';

declare module 'fastify' {
  interface FastifyRequest {
    user: User | null;
  }
  interface FastifyInstance {
    /** Sign-in allowlist, also applied to bearer tokens (PATs, OAuth access tokens). */
    allowlist: Allowlist;
  }
}

export interface Allowlist {
  /**
   * Whether the user may still use orch. `reauth` when the decision needs the user's GitHub
   * token and it can no longer be refreshed (treated as signed out).
   */
  check(user: User): Promise<'allowed' | 'refused' | 'reauth'>;
  isAllowed(login: string, accessToken: () => Promise<string>, cacheKey?: string): Promise<boolean>;
}

/** A relative in-app path that is safe to redirect to after sign-in, or null. */
export function safeNextPath(next: unknown): string | null {
  if (typeof next !== 'string' || next.length > 4000) return null;
  if (!next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return null;
  for (const ch of next) if (ch.charCodeAt(0) < 0x20 || ch === '\\') return null;
  return next;
}

export interface AuthDeps {
  config: Config;
  prisma: PrismaClient;
  github?: GithubClient;
}

export function toApiUser(u: User): ApiUser {
  return {
    id: u.id,
    githubLogin: u.login,
    name: u.name,
    avatarUrl: u.avatarUrl,
    onboardingCompletedAt: u.onboardingCompletedAt?.toISOString() ?? null,
    onboardingDismissedAt: u.onboardingDismissedAt?.toISOString() ?? null,
  };
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function cookie(name: string, value: string, secure: boolean, maxAgeSec: number): string {
  return [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSec}`,
    secure ? 'Secure' : '',
  ]
    .filter(Boolean)
    .join('; ');
}

/** Returns a valid GitHub user-to-server token for the user, refreshing it if needed. */
export async function getUserAccessToken(deps: AuthDeps, user: User): Promise<string> {
  const key = deps.config.ORCH_ENCRYPTION_KEY;
  if (!key || !deps.github || !user.ghAccessTokenEnc) {
    throw new HttpError(401, 'reauth_required', 'Sign in with GitHub again');
  }
  const expired = user.ghTokenExpiresAt && user.ghTokenExpiresAt.getTime() < Date.now() + 60_000;
  if (!expired) return decrypt(user.ghAccessTokenEnc, key);
  if (!user.ghRefreshTokenEnc) throw new HttpError(401, 'reauth_required', 'Sign in again');
  try {
    const t = await deps.github.refreshUserToken(decrypt(user.ghRefreshTokenEnc, key));
    await deps.prisma.user.update({
      where: { id: user.id },
      data: {
        ghAccessTokenEnc: encrypt(t.accessToken, key),
        ghRefreshTokenEnc: t.refreshToken ? encrypt(t.refreshToken, key) : null,
        ghTokenExpiresAt: t.expiresAt ?? null,
      },
    });
    return t.accessToken;
  } catch {
    throw new HttpError(401, 'reauth_required', 'Sign in with GitHub again');
  }
}

const BEARER_ONLY = ['/mcp', '/api/oauth/token', '/api/oauth/register', '/api/oauth/revoke'];

/** Paths authenticated by bearer token or OAuth client parameters only, never by cookie. */
export function isBearerOnlyPath(url: string): boolean {
  const path = url.split('?')[0]!;
  return BEARER_ONLY.includes(path);
}

export function requireUser(req: FastifyRequest): User {
  if (!req.user) throw new HttpError(401, 'unauthorized', 'Sign in required');
  return req.user;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function refusedPage(login: string, config: Config): string {
  const how = [
    config.ORCH_ALLOWED_GITHUB_LOGINS.length > 0 ? 'be listed in ORCH_ALLOWED_GITHUB_LOGINS' : '',
    config.ORCH_ALLOWED_GITHUB_ORGS.length > 0
      ? `be an active member of one of these GitHub organizations: ${config.ORCH_ALLOWED_GITHUB_ORGS.join(', ')}`
      : '',
  ].filter(Boolean);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Access denied - orch</title>
<style>body{font-family:system-ui,sans-serif;max-width:36rem;margin:4rem auto;padding:0 1rem;line-height:1.5}</style>
</head><body>
<h1>Access denied</h1>
<p>The GitHub account <strong>${escapeHtml(login)}</strong> is not allowed on this orch server.</p>
<p>To sign in, the account must ${escapeHtml(how.join(' or '))}. Ask the server administrator to add you.</p>
<p><a href="/">Back to the start page</a></p>
</body></html>`;
}

export function createAllowlist(deps: AuthDeps): Allowlist {
  const { config } = deps;
  const restricted = signInIsRestricted(config);
  // Org-membership results of signed-in users, so removing someone takes effect within the TTL.
  const orgCache = new Map<string, { ok: boolean; at: number }>();

  /** Allowlist decision for a user token. Login list first (free), then org membership. */
  async function isAllowed(
    login: string,
    accessToken: () => Promise<string>,
    cacheKey?: string,
  ): Promise<boolean> {
    if (!restricted) return true;
    if (config.ORCH_ALLOWED_GITHUB_LOGINS.includes(login.toLowerCase())) return true;
    if (config.ORCH_ALLOWED_GITHUB_ORGS.length === 0) return false;
    const ttl = config.ORCH_ALLOWLIST_CACHE_SEC * 1000;
    const hit = cacheKey ? orgCache.get(cacheKey) : undefined;
    if (hit && Date.now() - hit.at < ttl) return hit.ok;
    if (!deps.github) return false;
    const token = await accessToken();
    let ok = false;
    for (const org of config.ORCH_ALLOWED_GITHUB_ORGS) {
      if (await deps.github.isOrgMember(token, org)) {
        ok = true;
        break;
      }
    }
    if (cacheKey) orgCache.set(cacheKey, { ok, at: Date.now() });
    return ok;
  }

  async function check(user: User): Promise<'allowed' | 'refused' | 'reauth'> {
    try {
      const ok = await isAllowed(user.login, () => getUserAccessToken(deps, user), user.id);
      return ok ? 'allowed' : 'refused';
    } catch (err) {
      if (err instanceof HttpError) return 'reauth';
      throw err;
    }
  }
  return { isAllowed, check };
}

export function registerAuth(app: FastifyInstance, deps: AuthDeps): void {
  const { config, prisma } = deps;
  if (!signInIsRestricted(config)) {
    app.log.warn(
      'No sign-in allowlist: any GitHub account can sign in. Set ORCH_ALLOWED_GITHUB_LOGINS and/or ORCH_ALLOWED_GITHUB_ORGS.',
    );
  }
  const allowlist = createAllowlist(deps);
  app.decorate('allowlist', allowlist);
  const base = new URL(config.ORCH_BASE_URL);
  const secure = base.protocol === 'https:';
  const redirectUri = `${base.origin}/api/auth/github/callback`;

  app.decorateRequest('user', null);

  // CSRF: SameSite=Lax plus a same-origin check on state-changing requests.
  app.addHook('onRequest', async (req) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return;
    // The MCP endpoint and the OAuth protocol endpoints ignore cookies (bearer token, PKCE,
    // client_id): no CSRF exposure. The consent approval is NOT exempt.
    if (isBearerOnlyPath(req.url)) return;
    const origin = req.headers.origin;
    if (origin && origin !== base.origin) {
      throw new HttpError(403, 'csrf', 'Cross-origin request rejected');
    }
  });

  // Session lookup.
  app.addHook('onRequest', async (req) => {
    if (isBearerOnlyPath(req.url)) return; // bearer token only
    const raw = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (!raw) return;
    const session = await prisma.session.findUnique({
      where: { id: sha256Hex(raw) },
      include: { user: true },
    });
    if (!session || session.expiresAt.getTime() <= Date.now()) return;
    // Existing sessions are re-checked against the allowlist (org checks are cached).
    let decision: 'allowed' | 'refused' | 'reauth' = 'allowed';
    try {
      decision = await allowlist.check(session.user);
    } catch (err) {
      req.log.warn({ err }, 'Allowlist re-check failed; keeping the session');
    }
    // Token expired or revoked: treated as signed out, the user signs in again (and is checked).
    if (decision === 'reauth') return;
    // Not allowlisted: access is denied while that lasts. Nothing is deleted or revoked, so
    // re-adding the user restores their sessions, PATs and OAuth grants.
    if (decision === 'refused') return;
    req.user = session.user;
  });

  app.get('/api/auth/github/login', async (req, reply) => {
    if (!config.GITHUB_CLIENT_ID) {
      throw new HttpError(503, 'github_not_configured', 'GitHub App is not configured');
    }
    const state = randomToken();
    const url = new URL(`${config.GITHUB_WEB_URL}/login/oauth/authorize`);
    url.searchParams.set('client_id', config.GITHUB_CLIENT_ID);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('state', state);
    // Optional return path (e.g. the OAuth consent page), restricted to this origin.
    const next = safeNextPath((req.query as { next?: unknown }).next);
    reply.header('Set-Cookie', [
      cookie(STATE_COOKIE, state, secure, 600),
      cookie(NEXT_COOKIE, next ?? '', secure, next ? 600 : 0),
    ]);
    return reply.redirect(url.toString(), 302);
  });

  app.get('/api/auth/github/callback', async (req, reply) => {
    const key = config.ORCH_ENCRYPTION_KEY;
    if (!deps.github || !key) {
      throw new HttpError(503, 'github_not_configured', 'GitHub App is not configured');
    }
    const q = req.query as { code?: string; state?: string };
    const expected = parseCookies(req.headers.cookie)[STATE_COOKIE];
    if (!q.code || !q.state || !expected || q.state !== expected) {
      throw new HttpError(400, 'invalid_state', 'Invalid OAuth state');
    }
    let tokens, gh;
    try {
      tokens = await deps.github.exchangeCode(q.code, redirectUri);
      gh = await deps.github.getUser(tokens.accessToken);
    } catch (err) {
      req.log.warn({ err }, 'GitHub OAuth exchange failed');
      throw new HttpError(502, 'github_error', 'GitHub sign-in failed');
    }
    let allowed: boolean;
    try {
      allowed = await allowlist.isAllowed(gh.login, async () => tokens.accessToken);
    } catch (err) {
      req.log.warn({ err }, 'GitHub allowlist check failed');
      throw new HttpError(502, 'github_error', 'GitHub sign-in failed');
    }
    if (!allowed) {
      req.log.warn({ login: gh.login }, 'Sign-in refused: not on the allowlist');
      await audit(prisma, {
        actorType: 'SYSTEM',
        action: 'auth.refused',
        data: { login: gh.login },
        ip: req.ip,
      });
      reply.header('Set-Cookie', cookie(STATE_COOKIE, '', secure, 0));
      return reply.status(403).type('text/html; charset=utf-8').send(refusedPage(gh.login, config));
    }
    const fields = {
      login: gh.login,
      name: gh.name,
      avatarUrl: gh.avatarUrl,
      ghAccessTokenEnc: encrypt(tokens.accessToken, key),
      ghRefreshTokenEnc: tokens.refreshToken ? encrypt(tokens.refreshToken, key) : null,
      ghTokenExpiresAt: tokens.expiresAt ?? null,
      lastLoginAt: new Date(),
    };
    const user = await prisma.user.upsert({
      where: { githubId: BigInt(gh.id) },
      create: { githubId: BigInt(gh.id), ...fields },
      update: fields,
    });
    const sessionValue = randomToken();
    await prisma.session.create({
      data: {
        id: sha256Hex(sessionValue),
        userId: user.id,
        expiresAt: new Date(Date.now() + SESSION_TTL_MS),
        userAgent: req.headers['user-agent']?.slice(0, 255),
      },
    });
    await audit(prisma, { actorUserId: user.id, action: 'auth.login', ip: req.ip });
    const next = safeNextPath(parseCookies(req.headers.cookie)[NEXT_COOKIE]);
    reply.header('Set-Cookie', [
      cookie(SESSION_COOKIE, sessionValue, secure, SESSION_TTL_MS / 1000),
      cookie(STATE_COOKIE, '', secure, 0),
      cookie(NEXT_COOKIE, '', secure, 0),
    ]);
    return reply.redirect(next ?? '/', 302);
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const raw = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (raw) await prisma.session.deleteMany({ where: { id: sha256Hex(raw) } });
    reply.header('Set-Cookie', cookie(SESSION_COOKIE, '', secure, 0));
    return reply.status(204).send();
  });

  app.get('/api/me', async (req) => toApiUser(requireUser(req)));
}
