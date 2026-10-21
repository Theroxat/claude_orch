import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AccessGrant, AccessGrantStatus, User } from '@prisma/client';
import type { ApiUser } from '@orch/shared';
import { audit } from '../audit';
import { signInIsRestricted, type Config } from '../config';
import type { PrismaClient } from '../db';
import type { GithubClient } from '../github';
import { HttpError } from '../http/errors';
import {
  ACCESS_REQUEST_PURPOSE,
  ACCESS_REQUEST_TTL_MS,
  INVITE_COOKIE,
  INVITE_COOKIE_PURPOSE,
  useInvite,
} from '../access/core';
import { declinedPage, requestAccessPage } from '../access/pages';
import { cookie, parseCookies } from './cookies';
import { decrypt, encrypt, randomToken, sha256Hex, signToken, verifyToken } from './crypto';

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

/**
 * The org-membership check could not be made (GitHub unreachable, 5xx, rate limit, revoked App
 * authorization, token not refreshable) and no recent enough decision exists: fail closed.
 */
export class AccessUnknownError extends Error {
  constructor(
    cause: unknown,
    /** The user's GitHub token is gone or cannot be refreshed. */
    readonly reauth: boolean,
  ) {
    super('GitHub access check unavailable', { cause });
  }
}

export interface Allowlist {
  /**
   * Whether the user may still use orch. When GitHub cannot answer the org check, the last known
   * decision is reused while it is younger than ORCH_ACCESS_GRACE_SEC; after that the user is
   * refused (`reauth` when their GitHub token can no longer be refreshed). Callers treat both
   * `refused` and `reauth` as a denial.
   */
  check(user: User): Promise<'allowed' | 'refused' | 'reauth'>;
  /**
   * Admin OR env login OR allowed-org member OR APPROVED access grant (or no restriction at all).
   * `githubId`: an APPROVED grant bound to another GitHub account id (renamed login) is ignored.
   */
  isAllowed(
    login: string,
    accessToken: () => Promise<string>,
    cacheKey?: string,
    githubId?: bigint,
  ): Promise<boolean>;
  /** ORCH_ADMIN_GITHUB_LOGINS member. */
  isAdmin(login: string): boolean;
  /** Drops the cached access-grant decision of a login (after approve, deny or remove). */
  invalidate(login: string): void;
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

export function toApiUser(u: User, isAdmin = false): ApiUser {
  return {
    id: u.id,
    githubLogin: u.login,
    name: u.name,
    avatarUrl: u.avatarUrl,
    onboardingCompletedAt: u.onboardingCompletedAt?.toISOString() ?? null,
    onboardingDismissedAt: u.onboardingDismissedAt?.toISOString() ?? null,
    isAdmin,
  };
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

export function createAllowlist(deps: AuthDeps): Allowlist {
  const { config, prisma } = deps;
  const envRestricted = signInIsRestricted(config);
  const ttl = config.ORCH_ALLOWLIST_CACHE_SEC * 1000;
  // Outage policy: on a failed org check, reuse the last known decision for at most `grace`.
  const grace = config.ORCH_ACCESS_GRACE_SEC * 1000;
  // After a failed check, GitHub is not asked again for that user for a short while.
  const retryMs = Math.min(30_000, grace);
  // Org-membership results of signed-in users, so removing someone takes effect within the TTL.
  // Entries outlive the TTL: they are the last known decision used during a GitHub outage.
  const orgCache = new Map<string, { ok: boolean; at: number }>();
  const orgFailures = new Map<string, { at: number; err: unknown }>();
  // Access grants by lower-cased login (same TTL), dropped by invalidate() on admin decisions.
  const grantCache = new Map<
    string,
    { status: AccessGrantStatus | null; githubId: bigint | null; at: number }
  >();
  // Whether any APPROVED grant exists: it restricts sign-in even with no env allowlist.
  let anyApproved: { v: boolean; at: number } | null = null;
  const fresh = (at: number) => ttl > 0 && Date.now() - at < ttl;

  async function restricted(): Promise<boolean> {
    if (config.ORCH_ALLOW_ANY_GITHUB_USER) return false; // explicit opt-out wins
    if (envRestricted) return true;
    if (anyApproved && fresh(anyApproved.at)) return anyApproved.v;
    const v = (await prisma.accessGrant.count({ where: { status: 'APPROVED' } })) > 0;
    anyApproved = { v, at: Date.now() };
    return v;
  }

  /**
   * Status of the login's access grant, or null. A grant bound to another GitHub account id (the
   * login was renamed and reused) does not apply to this one.
   */
  async function grantStatus(login: string, githubId?: bigint): Promise<AccessGrantStatus | null> {
    let hit = grantCache.get(login);
    if (!hit || !fresh(hit.at)) {
      const g = await prisma.accessGrant.findUnique({ where: { githubLogin: login } });
      hit = { status: g?.status ?? null, githubId: g?.githubUserId ?? null, at: Date.now() };
      if (ttl > 0) grantCache.set(login, hit);
    }
    if (githubId !== undefined && hit.githubId !== null && hit.githubId !== githubId) return null;
    return hit.status;
  }

  const isAdmin = (login: string) => config.ORCH_ADMIN_GITHUB_LOGINS.includes(login.toLowerCase());

  function invalidate(login: string): void {
    grantCache.delete(login.toLowerCase());
    anyApproved = null;
  }

  /** Allowlist decision for a user token. Lists and grants first (cheap), then org membership. */
  async function isAllowed(
    login: string,
    accessToken: () => Promise<string>,
    cacheKey?: string,
    githubId?: bigint,
  ): Promise<boolean> {
    const lower = login.toLowerCase();
    if (isAdmin(lower)) return true;
    // An admin's DENIED (declined or removed) wins over the env lists, orgs and open mode.
    const status = await grantStatus(lower, githubId);
    if (status === 'DENIED') return false;
    if (!(await restricted())) return true;
    if (config.ORCH_ALLOWED_GITHUB_LOGINS.includes(lower)) return true;
    if (status === 'APPROVED') return true;
    if (config.ORCH_ALLOWED_GITHUB_ORGS.length === 0) return false;
    const hit = cacheKey ? orgCache.get(cacheKey) : undefined;
    if (hit && fresh(hit.at)) return hit.ok;
    if (!deps.github) return false;
    /** GitHub could not answer: the last known decision while it is recent enough, else deny. */
    const lastKnown = (err: unknown): boolean => {
      if (hit && Date.now() - hit.at < grace) return hit.ok;
      throw new AccessUnknownError(err, err instanceof HttpError);
    };
    const failed = cacheKey ? orgFailures.get(cacheKey) : undefined;
    if (failed && Date.now() - failed.at < retryMs) return lastKnown(failed.err);
    let ok = false;
    try {
      const token = await accessToken();
      for (const org of config.ORCH_ALLOWED_GITHUB_ORGS) {
        if (await deps.github.isOrgMember(token, org)) {
          ok = true;
          break;
        }
      }
    } catch (err) {
      if (!cacheKey) throw err; // sign-in: fails closed with an error page
      orgFailures.set(cacheKey, { at: Date.now(), err });
      return lastKnown(err);
    }
    if (cacheKey) {
      orgCache.set(cacheKey, { ok, at: Date.now() });
      orgFailures.delete(cacheKey);
    }
    return ok;
  }

  async function check(user: User): Promise<'allowed' | 'refused' | 'reauth'> {
    try {
      const ok = await isAllowed(
        user.login,
        () => getUserAccessToken(deps, user),
        user.id,
        user.githubId,
      );
      return ok ? 'allowed' : 'refused';
    } catch (err) {
      // GitHub unavailable past the grace period, or token gone: fail closed.
      if (err instanceof AccessUnknownError) return err.reauth ? 'reauth' : 'refused';
      if (err instanceof HttpError) return 'reauth';
      throw err;
    }
  }
  return { isAllowed, check, isAdmin, invalidate };
}

export function registerAuth(app: FastifyInstance, deps: AuthDeps): void {
  const { config, prisma } = deps;
  if (config.ORCH_ALLOW_ANY_GITHUB_USER) {
    app.log.warn(
      'ORCH_ALLOW_ANY_GITHUB_USER=true: any GitHub account can sign in, except those declined or removed on the Access page.',
    );
  } else if (!signInIsRestricted(config)) {
    app.log.warn(
      'No sign-in allowlist in the environment: unless access was approved on the Access page, any GitHub account can sign in. Set ORCH_ADMIN_GITHUB_LOGINS (and/or ORCH_ALLOWED_GITHUB_LOGINS, ORCH_ALLOWED_GITHUB_ORGS).',
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
    let decision: 'allowed' | 'refused' | 'reauth';
    try {
      decision = await allowlist.check(session.user);
    } catch (err) {
      // GitHub outages are handled by check() (grace, then deny); anything else fails closed.
      req.log.warn({ err }, 'Allowlist re-check failed; denying the session');
      return;
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
    const githubId = BigInt(gh.id);
    let allowed: boolean;
    try {
      allowed = await allowlist.isAllowed(
        gh.login,
        async () => tokens.accessToken,
        undefined,
        githubId,
      );
    } catch (err) {
      req.log.warn({ err }, 'GitHub allowlist check failed');
      throw new HttpError(502, 'github_error', 'GitHub sign-in failed');
    }
    const githubLogin = gh.login.toLowerCase();
    const cookies = parseCookies(req.headers.cookie);
    const clearCookies = [cookie(STATE_COOKIE, '', secure, 0)];
    if (cookies[INVITE_COOKIE] !== undefined)
      clearCookies.push(cookie(INVITE_COOKIE, '', secure, 0));
    let grant: AccessGrant | null = null;
    if (!allowed) {
      grant = await prisma.accessGrant.findUnique({ where: { githubLogin } });
      // Invite link opened before signing in: auto-approve (never over an admin's decline).
      const invite = verifyToken(key, INVITE_COOKIE_PURPOSE, cookies[INVITE_COOKIE]);
      const inviteId = typeof invite?.id === 'string' ? invite.id : null;
      if (inviteId && grant?.status !== 'DENIED' && (await useInvite(prisma, inviteId))) {
        const decided = {
          status: 'APPROVED' as const,
          decidedAt: new Date(),
          decidedBy: `invite:${inviteId}`,
          githubUserId: githubId,
          avatarUrl: gh.avatarUrl,
        };
        // Conditional on the grant not being DENIED, so a concurrent decline is never overwritten.
        let g = await prisma.accessGrant
          .create({ data: { githubLogin, ...decided } })
          .catch(() => null); // already exists
        if (!g) {
          const res = await prisma.accessGrant.updateMany({
            where: { githubLogin, status: { not: 'DENIED' } },
            data: decided,
          });
          g =
            res.count === 1
              ? await prisma.accessGrant.findUnique({ where: { githubLogin } })
              : null;
        }
        allowlist.invalidate(githubLogin);
        await audit(prisma, {
          actorType: 'SYSTEM',
          action: 'access.invite_used',
          data: { login: githubLogin, inviteId, grantId: g?.id ?? null, declined: !g },
          ip: req.ip,
        });
        if (g) allowed = true;
        else grant = await prisma.accessGrant.findUnique({ where: { githubLogin } });
      }
    }
    if (!allowed) {
      if (grant?.status === 'DENIED') {
        req.log.warn({ login: gh.login }, 'Sign-in refused: access declined');
        await audit(prisma, {
          actorType: 'SYSTEM',
          action: 'auth.refused',
          data: { login: gh.login, grant: 'DENIED' },
          ip: req.ip,
        });
        reply.header('Set-Cookie', clearCookies);
        return reply
          .status(403)
          .type('text/html; charset=utf-8')
          .send(declinedPage(gh.login, gh.avatarUrl));
      } else {
        req.log.warn({ login: gh.login }, 'Sign-in refused: not on the allowlist');
        await audit(prisma, {
          actorType: 'SYSTEM',
          action: 'auth.refused',
          data: { login: gh.login },
          ip: req.ip,
        });
        // No session: a short-lived signed token lets the user ask an admin for access.
        const token = signToken(
          key,
          ACCESS_REQUEST_PURPOSE,
          { login: gh.login, id: String(gh.id), avatarUrl: gh.avatarUrl },
          ACCESS_REQUEST_TTL_MS,
        );
        reply.header('Set-Cookie', clearCookies);
        return reply
          .status(403)
          .type('text/html; charset=utf-8')
          .send(
            requestAccessPage({
              login: gh.login,
              avatarUrl: gh.avatarUrl,
              token,
              pending: grant?.status === 'PENDING',
              note: grant?.note,
              orgs: config.ORCH_ALLOWED_GITHUB_ORGS,
            }),
          );
      }
    } else {
      // Signed in through an APPROVED grant: remember who it is (id and avatar).
      const bound = await prisma.accessGrant.updateMany({
        where: {
          githubLogin,
          status: 'APPROVED',
          OR: [{ githubUserId: null }, { githubUserId: githubId }],
        },
        data: { githubUserId: githubId, avatarUrl: gh.avatarUrl },
      });
      if (bound.count > 0) allowlist.invalidate(githubLogin); // the cached grant had no id yet
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
      ...clearCookies,
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

  app.get('/api/me', async (req) => {
    const user = requireUser(req);
    return toApiUser(user, allowlist.isAdmin(user.login));
  });
}
