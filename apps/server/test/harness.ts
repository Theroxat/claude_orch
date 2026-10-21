import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { GithubRole } from '@orch/shared';
import { buildApp } from '../src/app';
import { loadConfig } from '../src/config';
import type { GithubClient, GithubRepoAccess, GithubTokens, GithubUserInfo } from '../src/github';
import { testPrisma } from './db';

let seq = 0;
export const uid = () =>
  `${Date.now().toString(36)}${(seq++).toString(36)}${randomBytes(3).toString('hex')}`;
export const uniqueInt = () => Math.floor(Math.random() * 2_000_000_000) + seq++;

/** In-memory GitHub. No network. */
export class FakeGithub implements GithubClient {
  users = new Map<string, GithubUserInfo>(); // by access token
  repos = new Map<string, GithubRepoAccess[]>(); // by access token
  roles = new Map<string, GithubRole>(); // `${installationId}:${fullName}:${login}`
  roleCalls = 0;
  failRoles = false;

  async exchangeCode(code: string): Promise<GithubTokens> {
    return {
      accessToken: `tok-${code}`,
      refreshToken: `ref-${code}`,
      expiresAt: new Date(Date.now() + 8 * 3600_000),
    };
  }
  async refreshUserToken(refreshToken: string): Promise<GithubTokens> {
    return { accessToken: `new-${refreshToken}` };
  }
  async getUser(accessToken: string): Promise<GithubUserInfo> {
    const u = this.users.get(accessToken);
    if (!u) throw new Error('bad token');
    return u;
  }
  async listUserRepos(accessToken: string): Promise<GithubRepoAccess[]> {
    return this.repos.get(accessToken) ?? [];
  }
  async getUserRole(installationId: number, fullName: string, login: string): Promise<GithubRole> {
    this.roleCalls++;
    if (this.failRoles) throw new Error('github down');
    return this.roles.get(`${installationId}:${fullName}:${login}`) ?? 'NONE';
  }
}

export const prisma = testPrisma();

export interface MakeAppOptions {
  /** Extra config values (e.g. AGENT_HEARTBEAT_TIMEOUT_MS, LOG_LEVEL). */
  env?: Record<string, string>;
  /** Captures pino output. */
  logStream?: { write(msg: string): void };
}

export function makeApp(
  github: GithubClient | undefined = new FakeGithub(),
  opts: MakeAppOptions = {},
): FastifyInstance {
  const config = loadConfig({
    DATABASE_URL: process.env.DATABASE_URL_TEST ?? '',
    LOG_LEVEL: 'silent',
    ORCH_BASE_URL: 'http://localhost:8470',
    GITHUB_CLIENT_ID: 'test-client-id',
    GITHUB_APP_SLUG: 'orch-test',
    ORCH_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    ...opts.env,
  });
  return buildApp({ config, prisma, github, logStream: opts.logStream });
}

export interface TestUser {
  login: string;
  id: number;
  cookie: string;
  userId: string;
  token: string;
}

/** Signs a fake GitHub user in through the real OAuth callback. */
export async function loginAs(app: FastifyInstance, gh: FakeGithub): Promise<TestUser> {
  const login = `u-${uid()}`;
  const id = uniqueInt();
  const code = login;
  gh.users.set(`tok-${code}`, {
    id,
    login,
    name: `Name ${login}`,
    avatarUrl: `https://a/${login}.png`,
  });
  const res = await app.inject({
    method: 'GET',
    url: `/api/auth/github/callback?code=${code}&state=s1`,
    headers: { cookie: 'orch_oauth_state=s1' },
  });
  if (res.statusCode !== 302) throw new Error(`login failed: ${res.body}`);
  const setCookie = ([] as string[]).concat(res.headers['set-cookie'] as string | string[]);
  const session = setCookie.find((c) => c.startsWith('orch_session='));
  const cookie = session!.split(';')[0]!;
  const user = await prisma.user.findUniqueOrThrow({ where: { githubId: BigInt(id) } });
  return { login, id, cookie, userId: user.id, token: `tok-${code}` };
}

export function repoFor(over: Partial<GithubRepoAccess> = {}): GithubRepoAccess {
  const n = uniqueInt();
  return {
    githubRepoId: n,
    fullName: `acme/repo-${n}`,
    private: false,
    defaultBranch: 'main',
    installationId: 4242,
    accountLogin: 'acme',
    accountType: 'Organization',
    admin: true,
    ...over,
  };
}

export function api(app: FastifyInstance, user: TestUser | null) {
  return (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: unknown) =>
    app.inject({
      method,
      url,
      payload: payload as object,
      headers: user ? { cookie: user.cookie } : {},
    });
}
