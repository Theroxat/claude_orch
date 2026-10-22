import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { GithubRole } from '@orch/shared';
import { buildApp, type AppDeps } from '../src/app';
import { loadConfig } from '../src/config';
import type {
  CreateIssueInput,
  CreatePullRequestInput,
  GithubClient,
  GithubIssue,
  GithubRepoAccess,
  GithubTokens,
  GithubUserInfo,
  InstallationTokenScope,
} from '../src/github';
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
  orgs = new Map<string, Set<string>>(); // by access token -> org names (lower-case)
  orgCalls = 0;
  failOrgs = false;
  /** Thrown by isOrgMember when set (e.g. a 401 after the user revoked the App). */
  failOrgsWith: Error | undefined;
  async isOrgMember(accessToken: string, org: string): Promise<boolean> {
    this.orgCalls++;
    if (this.failOrgs) throw new Error('github down');
    if (this.failOrgsWith) throw this.failOrgsWith;
    return this.orgs.get(accessToken)?.has(org.toLowerCase()) ?? false;
  }
  async listUserRepos(accessToken: string): Promise<GithubRepoAccess[]> {
    return this.repos.get(accessToken) ?? [];
  }
  async getUserRole(installationId: number, fullName: string, login: string): Promise<GithubRole> {
    this.roleCalls++;
    if (this.failRoles) throw new Error('github down');
    return this.roles.get(`${installationId}:${fullName}:${login}`) ?? 'NONE';
  }

  // ---- M3: issues, installation tokens, pull requests ----
  issues = new Map<string, GithubIssue[]>(); // by fullName
  createdIssues: Array<CreateIssueInput & { fullName: string; number: number }> = [];
  tokenCalls: Array<{ installationId: number; scope: InstallationTokenScope }> = [];
  pullRequests: Array<CreatePullRequestInput & { fullName: string; number: number }> = [];

  /** Seeds an issue as if someone opened it on GitHub. */
  addIssue(fullName: string, partial: Partial<GithubIssue> & { number: number }): GithubIssue {
    const issue: GithubIssue = {
      nodeId: `I_${fullName}_${partial.number}`,
      htmlUrl: `https://github.com/${fullName}/issues/${partial.number}`,
      title: `Issue ${partial.number}`,
      body: '',
      labels: ['pool'],
      ...partial,
    };
    this.issues.set(fullName, [...(this.issues.get(fullName) ?? []), issue]);
    return issue;
  }
  async createIssue(
    _installationId: number,
    fullName: string,
    input: CreateIssueInput,
  ): Promise<GithubIssue> {
    if (
      this.failCreateIssueAfter !== null &&
      this.createdIssues.length >= this.failCreateIssueAfter
    ) {
      throw new Error('GitHub is down (fake)');
    }
    const list = this.issues.get(fullName) ?? [];
    const number = Math.max(0, ...list.map((i) => i.number)) + 1;
    const issue = this.addIssue(fullName, {
      number,
      title: input.title,
      body: input.body,
      labels: input.labels,
    });
    this.createdIssues.push({ ...input, fullName, number });
    return issue;
  }
  async listIssuesByLabel(
    _installationId: number,
    fullName: string,
    label: string,
  ): Promise<GithubIssue[]> {
    return (this.issues.get(fullName) ?? []).filter((i) => i.labels.includes(label));
  }
  async createInstallationToken(installationId: number, scope: InstallationTokenScope) {
    this.tokenCalls.push({ installationId, scope });
    return {
      token: `ghs_fake_${this.tokenCalls.length}`,
      expiresAt: new Date(Date.now() + 3600_000),
    };
  }
  async createPullRequest(
    _installationId: number,
    fullName: string,
    input: CreatePullRequestInput,
  ) {
    const number = this.pullRequests.length + 100;
    this.pullRequests.push({ ...input, fullName, number });
    return { number, htmlUrl: `https://github.com/${fullName}/pull/${number}` };
  }

  // ---- M5: branches, issue close (batch compensation), failure injection ----
  branches = new Map<string, Map<string, string>>(); // fullName -> branch -> sha
  createdBranches: Array<{ fullName: string; branch: string; sha: string }> = [];
  closedIssues: Array<{ fullName: string; number: number; labels: string[] }> = [];
  /** createIssue throws once this many issues were created by it (null = never). */
  failCreateIssueAfter: number | null = null;

  async getBranchSha(_installationId: number, fullName: string, branch: string) {
    const known = this.branches.get(fullName)?.get(branch);
    if (known) return known;
    return branch === 'main' ? `sha-main-${fullName}` : null;
  }
  async createBranch(_installationId: number, fullName: string, branch: string, sha: string) {
    const m = this.branches.get(fullName) ?? new Map<string, string>();
    m.set(branch, sha);
    this.branches.set(fullName, m);
    this.createdBranches.push({ fullName, branch, sha });
  }
  async closeIssue(_installationId: number, fullName: string, number: number, labels: string[]) {
    this.closedIssues.push({ fullName, number, labels });
  }
}

export const prisma = testPrisma();

/** Test-only webhook secret (not a real secret). */
export const TEST_WEBHOOK_SECRET = 'test-webhook-secret';

export interface MakeAppOptions {
  /** Extra config values (e.g. AGENT_HEARTBEAT_TIMEOUT_MS, LOG_LEVEL). */
  env?: Record<string, string>;
  /** Captures pino output. */
  logStream?: { write(msg: string): void };
  /** Notifier test hooks (webhook HTTP client, e-mail transport). */
  notify?: AppDeps['notify'];
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
    // M1-M3 suites drive tasks by hand; the M4 suite turns the dispatcher on.
    DISPATCHER_ENABLED: 'false',
    GITHUB_WEBHOOK_SECRET: TEST_WEBHOOK_SECRET,
    ...opts.env,
  });
  return buildApp({ config, prisma, github, logStream: opts.logStream, notify: opts.notify });
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
