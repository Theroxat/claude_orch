import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { User } from '@prisma/client';
import type { ApiUser } from '@orch/shared';
import { audit } from '../audit';
import type { Config } from '../config';
import type { PrismaClient } from '../db';
import type { GithubClient } from '../github';
import { HttpError } from '../http/errors';
import { decrypt, encrypt, randomToken, sha256Hex } from './crypto';

export const SESSION_COOKIE = 'orch_session';
const STATE_COOKIE = 'orch_oauth_state';
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;

declare module 'fastify' {
  interface FastifyRequest {
    user: User | null;
  }
}

export interface AuthDeps {
  config: Config;
  prisma: PrismaClient;
  github?: GithubClient;
}

export function toApiUser(u: User): ApiUser {
  return { id: u.id, githubLogin: u.login, name: u.name, avatarUrl: u.avatarUrl };
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

export function requireUser(req: FastifyRequest): User {
  if (!req.user) throw new HttpError(401, 'unauthorized', 'Sign in required');
  return req.user;
}

export function registerAuth(app: FastifyInstance, deps: AuthDeps): void {
  const { config, prisma } = deps;
  const base = new URL(config.ORCH_BASE_URL);
  const secure = base.protocol === 'https:';
  const redirectUri = `${base.origin}/api/auth/github/callback`;

  app.decorateRequest('user', null);

  // CSRF: SameSite=Lax plus a same-origin check on state-changing requests.
  app.addHook('onRequest', async (req) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return;
    // The MCP endpoint ignores cookies and requires a bearer token: no CSRF exposure.
    if (req.url === '/mcp' || req.url.startsWith('/mcp?')) return;
    const origin = req.headers.origin;
    if (origin && origin !== base.origin) {
      throw new HttpError(403, 'csrf', 'Cross-origin request rejected');
    }
  });

  // Session lookup.
  app.addHook('onRequest', async (req) => {
    if (req.url === '/mcp' || req.url.startsWith('/mcp?')) return; // bearer token only
    const raw = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (!raw) return;
    const session = await prisma.session.findUnique({
      where: { id: sha256Hex(raw) },
      include: { user: true },
    });
    if (session && session.expiresAt.getTime() > Date.now()) req.user = session.user;
  });

  app.get('/api/auth/github/login', async (_req, reply) => {
    if (!config.GITHUB_CLIENT_ID) {
      throw new HttpError(503, 'github_not_configured', 'GitHub App is not configured');
    }
    const state = randomToken();
    const url = new URL(`${config.GITHUB_WEB_URL}/login/oauth/authorize`);
    url.searchParams.set('client_id', config.GITHUB_CLIENT_ID);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('state', state);
    reply.header('Set-Cookie', cookie(STATE_COOKIE, state, secure, 600));
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
    reply.header('Set-Cookie', [
      cookie(SESSION_COOKIE, sessionValue, secure, SESSION_TTL_MS / 1000),
      cookie(STATE_COOKIE, '', secure, 0),
    ]);
    return reply.redirect('/', 302);
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const raw = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (raw) await prisma.session.deleteMany({ where: { id: sha256Hex(raw) } });
    reply.header('Set-Cookie', cookie(SESSION_COOKIE, '', secure, 0));
    return reply.status(204).send();
  });

  app.get('/api/me', async (req) => toApiUser(requireUser(req)));
}
