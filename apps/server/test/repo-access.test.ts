/**
 * Repository access re-check: a project's stored owner (`addedById`) who lost access to a PRIVATE
 * repository on GitHub gets nothing from usage, history, templates, the pool, MCP, the project list
 * or notifications. Also: cache TTL, webhook invalidation, outage grace, public repos unaffected.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  CreatePersonalTokenResponseSchema,
  ProjectViewSchema,
  UsageDashboardSchema,
} from '@orch/shared';
import { recipientCheck } from '../src/notifications/access';
import {
  configureRepoAccess,
  getRoleInfo,
  invalidateRepoAccess,
  ROLE_CACHE_TTL_MS,
} from '../src/projects/service';
import { signBody } from '../src/webhooks';
import {
  FakeGithub,
  TEST_WEBHOOK_SECRET,
  api,
  loginAs,
  makeApp,
  prisma,
  repoFor,
  uid,
  uniqueInt,
  type TestUser,
} from './harness';

const gh = new FakeGithub();
const app = makeApp(gh);
let base: string;
const results: string[] = [];
const warnings: string[] = [];

beforeAll(async () => {
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  if (!addr || typeof addr === 'string') throw new Error('no address');
  base = `http://127.0.0.1:${addr.port}`;
  // After buildApp (which wires the real metrics): capture the access-check results.
  configureRepoAccess(gh, {
    ttlMs: ROLE_CACHE_TTL_MS,
    graceMs: 15 * 60_000,
    observer: { count: (r) => results.push(r), warn: (_o, m) => warnings.push(m) },
  });
});
afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});
afterEach(() => {
  gh.failRoles = false;
  gh.failRolesWith = undefined;
  results.length = 0;
  warnings.length = 0;
});

const asUser = (u: TestUser) => ({ id: u.userId, login: u.login });
const roleKey = (repo: { installationId: number; fullName: string }, u: { login: string }) =>
  `${repo.installationId}:${repo.fullName}:${u.login}`;
const status = (code: number) => Object.assign(new Error(`github ${code}`), { status: code });
const stale = (userId: string) =>
  prisma.projectPermission.updateMany({ where: { userId }, data: { syncedAt: new Date(0) } });
const age = (userId: string, ms: number) =>
  prisma.projectPermission.updateMany({
    where: { userId },
    data: { syncedAt: new Date(Date.now() - ms) },
  });

async function world(isPrivate = true, installationId?: number) {
  const owner = await loginAs(app, gh);
  const repo = repoFor({ private: isPrivate, ...(installationId ? { installationId } : {}) });
  gh.repos.set(owner.token, [repo]);
  gh.roles.set(roleKey(repo, owner), 'ADMIN');
  const project = ProjectViewSchema.parse(
    (await api(app, owner)('POST', '/api/projects', { githubRepoId: repo.githubRepoId })).json(),
  );
  const row = await prisma.project.findUniqueOrThrow({
    where: { id: project.id },
    include: { installation: true },
  });
  // A task the owner ran (history, usage), a shared template, and the owner in the pool.
  const task = await prisma.task.create({
    data: {
      projectId: project.id,
      githubIssueNumber: uniqueInt(),
      githubIssueNodeId: `n${uid()}`,
      title: 'secret task',
      bodySnapshot: '',
      bodyHash: 'h',
      baseBranch: 'main',
      createdById: owner.userId,
      status: 'DONE',
    },
  });
  await prisma.assignment.create({
    data: {
      taskId: task.id,
      userId: owner.userId,
      kind: 'CLAIM',
      status: 'SUCCEEDED',
      startedAt: new Date(Date.now() - 3600_000),
      finishedAt: new Date(Date.now() - 1800_000),
      usageWeighted: BigInt(500),
    },
  });
  await api(app, owner)('PUT', `/api/projects/${project.id}/participation`, {
    participating: true,
    budgetPercent: 20,
    mode: 'approval',
  });
  const tpl = await api(app, owner)('POST', '/api/templates', {
    scope: 'project',
    projectId: project.id,
    name: 'Shared tpl',
    description: 'd',
    titleTemplate: 'T {{x}}',
    bodyTemplate: 'B {{x}}',
    acceptanceCriteria: [],
    size: 'S',
    model: 'SONNET',
    labels: [],
    dependenciesMode: 'none',
  });
  expect(tpl.statusCode, tpl.body).toBeLessThan(300);
  return { owner, repo, project, row };
}

const sees = async (u: TestUser, projectId: string) => {
  const usage = UsageDashboardSchema.parse(
    (await api(app, u)('GET', '/api/usage?range=7d')).json(),
  );
  const history = (await api(app, u)('GET', '/api/tasks/history')).json();
  const pool = (await api(app, u)('GET', '/api/pool')).json();
  const board = (await api(app, u)('GET', '/api/tasks')).json();
  const mine = (await api(app, u)('GET', '/api/projects/mine')).json();
  const tpl = await api(app, u)('GET', `/api/templates?projectId=${projectId}`);
  const direct = await api(app, u)('GET', `/api/projects/${projectId}/tasks`);
  return {
    usageRuns: usage.totals.runs,
    usageProjects: usage.projects.length,
    budgets: usage.budgets.length,
    historyItems: history.items.length,
    historyProjects: (history.facets?.projects ?? []).length,
    poolProjects: pool.projects.length,
    boardProjects: Object.keys(board.access ?? {}).length,
    mine: mine.length,
    templatesStatus: tpl.statusCode,
    projectBoardStatus: direct.statusCode,
  };
};

const mcps: McpClient[] = [];
afterEach(async () => {
  for (const c of mcps.splice(0)) await c.close();
});
async function mcpAs(u: TestUser): Promise<McpClient> {
  const res = await api(app, u)('POST', '/api/tokens', { name: 'laptop' });
  const { token } = CreatePersonalTokenResponseSchema.parse(res.json());
  const client = new McpClient({ name: 'orch-test', version: '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  );
  mcps.push(client);
  return client;
}
async function call(c: McpClient, name: string, args: Record<string, unknown>) {
  const res = await c.callTool({ name, arguments: args });
  return { isError: res.isError === true, text: (res.content as Array<{ text: string }>)[0]!.text };
}

async function hook(event: string, payload: object) {
  const body = JSON.stringify(payload);
  return app.inject({
    method: 'POST',
    url: '/api/github/webhook',
    payload: body,
    headers: {
      'content-type': 'application/json',
      'x-github-event': event,
      'x-github-delivery': uid(),
      'x-hub-signature-256': signBody(TEST_WEBHOOK_SECRET, body),
    },
  });
}

describe('an owner who lost access to a private repository', () => {
  it('sees nothing: usage, history, templates, pool, board, project list, MCP, notifications', async () => {
    const { owner, repo, project, row } = await world();
    const before = await sees(owner, project.id);
    expect(before).toMatchObject({
      usageRuns: 1,
      usageProjects: 1,
      budgets: 1,
      historyItems: 1,
      historyProjects: 1,
      poolProjects: 1,
      boardProjects: 1,
      mine: 1,
      templatesStatus: 200,
      projectBoardStatus: 200,
    });
    const mcp = await mcpAs(owner);
    expect((await call(mcp, 'view_pool', { projectFullName: repo.fullName })).isError).toBe(false);
    const check = recipientCheck({ prisma, github: gh, isAllowed: async () => true });
    expect(await check(owner.userId, project.id)).toBe(true);

    // GitHub: the owner was removed from the repository (404). Cache still fresh: nothing yet.
    gh.roles.delete(roleKey(repo, owner));
    expect((await sees(owner, project.id)).usageRuns).toBe(1);
    // Once the cached answer expires, everything closes at once.
    await stale(owner.userId);
    const after = await sees(owner, project.id);
    expect(after).toEqual({
      usageRuns: 0,
      usageProjects: 0,
      budgets: 0,
      historyItems: 0,
      historyProjects: 0,
      poolProjects: 0,
      boardProjects: 0,
      mine: 0,
      templatesStatus: 404,
      projectBoardStatus: 404,
    });
    expect((await call(mcp, 'view_pool', { projectFullName: repo.fullName })).isError).toBe(true);
    expect((await call(mcp, 'list_templates', { projectFullName: repo.fullName })).isError).toBe(
      true,
    );
    expect((await call(mcp, 'list_tasks', { projectFullName: repo.fullName })).isError).toBe(true);
    expect(await check(owner.userId, row.id)).toBe(false);
  });

  it('a 403 from GitHub (installation suspended or lost) also closes it', async () => {
    const { owner, project } = await world();
    gh.failRolesWith = status(403);
    await stale(owner.userId);
    expect((await sees(owner, project.id)).historyItems).toBe(0);
    expect(results).toContain('denied');
  });

  it('keeps working while GitHub still says ADMIN', async () => {
    const { owner, project } = await world();
    await stale(owner.userId);
    expect((await sees(owner, project.id)).usageRuns).toBe(1);
  });

  it('the label webhook no longer trusts the stored owner of a private repository', async () => {
    const { owner, repo, project } = await world();
    gh.roles.delete(roleKey(repo, owner));
    const res = await hook('issues', {
      action: 'labeled',
      sender: { id: owner.id, login: owner.login },
      repository: { id: repo.githubRepoId, full_name: repo.fullName },
      issue: { number: uniqueInt(), node_id: 'n1', html_url: 'https://x/1', title: 't', body: '' },
      label: {
        name: (await prisma.project.findUniqueOrThrow({ where: { id: project.id } })).poolLabel,
      },
    });
    expect(res.json().result).toBe('refused_not_writer');
  });
});

describe('cache TTL', () => {
  it('asks GitHub once per TTL, then again after it', async () => {
    const { owner, repo, row } = await world();
    const calls = () => gh.roleCalls;
    const start = calls();
    await getRoleInfo(prisma, gh, row, asUser(owner)); // fresh from project creation: cached
    await getRoleInfo(prisma, gh, row, asUser(owner));
    expect(calls()).toBe(start);
    await age(owner.userId, ROLE_CACHE_TTL_MS + 1000);
    expect((await getRoleInfo(prisma, gh, row, asUser(owner))).role).toBe('ADMIN');
    expect(calls()).toBe(start + 1);
    await getRoleInfo(prisma, gh, row, asUser(owner));
    expect(calls()).toBe(start + 1);
    gh.roles.set(roleKey(repo, owner), 'WRITE');
    await age(owner.userId, ROLE_CACHE_TTL_MS + 1000);
    expect((await getRoleInfo(prisma, gh, row, asUser(owner))).role).toBe('WRITE');
  });

  it('the TTL is configurable', async () => {
    const { owner, row } = await world();
    configureRepoAccess(gh, { ttlMs: 1000 });
    try {
      const start = gh.roleCalls;
      await age(owner.userId, 2000);
      await getRoleInfo(prisma, gh, row, asUser(owner));
      expect(gh.roleCalls).toBe(start + 1);
    } finally {
      configureRepoAccess(gh, { ttlMs: ROLE_CACHE_TTL_MS });
    }
  });
});

describe('webhook invalidation', () => {
  // 0 once invalidated (the row is then dated decades back).
  const syncedAt = async (userId: string) => {
    const t = (await prisma.projectPermission.findFirstOrThrow({ where: { userId } })).syncedAt;
    return t.getTime() < Date.now() - 50 * 365 * 24 * 3600_000 ? 0 : t.getTime();
  };

  it('member removed: that collaborator is re-checked at once', async () => {
    const { owner, repo, project } = await world();
    expect(await syncedAt(owner.userId)).toBeGreaterThan(0);
    gh.roles.delete(roleKey(repo, owner));
    const res = await hook('member', {
      action: 'removed',
      member: { id: owner.id, login: owner.login },
      repository: { id: repo.githubRepoId, full_name: repo.fullName },
    });
    expect(res.json().result).toBe('member.removed');
    expect(await syncedAt(owner.userId)).toBe(0);
    expect((await sees(owner, project.id)).historyItems).toBe(0);
  });

  it('repository privatized / publicized updates the visibility and invalidates', async () => {
    const { owner, repo, project } = await world(false);
    const priv = await hook('repository', {
      action: 'privatized',
      repository: { id: repo.githubRepoId, full_name: repo.fullName, private: true },
    });
    expect(priv.json().result).toBe('repository.privatized');
    expect((await prisma.project.findUniqueOrThrow({ where: { id: project.id } })).isPrivate).toBe(
      true,
    );
    expect(await syncedAt(owner.userId)).toBe(0);
    await hook('repository', {
      action: 'publicized',
      repository: { id: repo.githubRepoId, full_name: repo.fullName, private: false },
    });
    expect((await prisma.project.findUniqueOrThrow({ where: { id: project.id } })).isPrivate).toBe(
      false,
    );
  });

  it('installation deleted and organization member removed invalidate too', async () => {
    const { owner, row } = await world(true, uniqueInt());
    const orgRes = await hook('organization', {
      action: 'member_removed',
      organization: { login: row.installation.accountLogin },
      membership: { user: { id: owner.id } },
    });
    expect(orgRes.json().result).toBe('organization.member_removed');
    expect(await syncedAt(owner.userId)).toBe(0);

    await getRoleInfo(prisma, gh, row, asUser(owner)); // refreshed
    expect(await syncedAt(owner.userId)).toBeGreaterThan(0);
    const inst = await hook('installation', {
      action: 'suspend',
      installation: { id: Number(row.installation.githubInstallationId) },
      sender: { id: uniqueInt(), login: `s-${uid()}` },
    });
    expect(inst.json().result).toBe('installation.suspend');
    expect(await syncedAt(owner.userId)).toBe(0);
  });

  it('team membership and team repository changes invalidate too', async () => {
    const { owner, repo, row } = await world(true, uniqueInt());
    const m = await hook('membership', {
      action: 'removed',
      scope: 'team',
      member: { id: owner.id, login: owner.login },
      organization: { login: row.installation.accountLogin },
    });
    expect(m.json().result).toBe('membership.removed');
    expect(await syncedAt(owner.userId)).toBe(0);

    await getRoleInfo(prisma, gh, row, asUser(owner));
    expect(await syncedAt(owner.userId)).toBeGreaterThan(0);
    const t = await hook('team', {
      action: 'removed_from_repository',
      repository: { id: repo.githubRepoId, full_name: repo.fullName },
      organization: { login: row.installation.accountLogin },
    });
    expect(t.json().result).toBe('team.removed_from_repository');
    expect(await syncedAt(owner.userId)).toBe(0);
  });

  it('a participant removed from the private repository loses the board too', async () => {
    const { repo, project } = await world();
    const member = await loginAs(app, gh);
    gh.roles.set(roleKey(repo, member), 'READ');
    await prisma.participation.create({
      data: {
        userId: member.userId,
        projectId: project.id,
        active: true,
        approvedAt: new Date(),
        percent: 10,
        mode: 'APPROVAL',
      },
    });
    expect((await api(app, member)('GET', `/api/projects/${project.id}/tasks`)).statusCode).toBe(
      200,
    );
    gh.roles.delete(roleKey(repo, member));
    await hook('member', {
      action: 'removed',
      member: { id: member.id, login: member.login },
      repository: { id: repo.githubRepoId, full_name: repo.fullName },
    });
    expect((await api(app, member)('GET', `/api/projects/${project.id}/tasks`)).statusCode).toBe(
      404,
    );
    expect((await sees(member, project.id)).poolProjects).toBe(0);
  });

  it('keeps the owner overrides when invalidating', async () => {
    const { owner, row } = await world();
    await prisma.projectPermission.update({
      where: { projectId_userId: { projectId: row.id, userId: owner.userId } },
      data: { canSubmit: true },
    });
    await invalidateRepoAccess(prisma, { projectId: row.id });
    expect((await getRoleInfo(prisma, gh, row, asUser(owner))).canSubmit).toBe(true);
  });
});

describe('GitHub outage', () => {
  it('private: reuses the last verified role inside the grace window and logs it', async () => {
    const { owner, row } = await world();
    gh.failRolesWith = status(503);
    await age(owner.userId, ROLE_CACHE_TTL_MS + 60_000);
    expect((await getRoleInfo(prisma, gh, row, asUser(owner))).role).toBe('ADMIN');
    expect(results).toContain('grace');
    expect(warnings.length).toBeGreaterThan(0);
  });

  it('private: denies once the grace window is over, or without a verified role', async () => {
    const { owner, row } = await world();
    gh.failRoles = true; // plain network error, no status
    await age(owner.userId, 16 * 60_000);
    expect((await getRoleInfo(prisma, gh, row, asUser(owner))).role).toBe('NONE');
    expect(results).toContain('outage_denied');
    const stranger = await loginAs(app, gh);
    expect((await getRoleInfo(prisma, gh, row, asUser(stranger))).role).toBe('NONE');
  });

  it('private: an invalidated row gets no grace', async () => {
    const { owner, row } = await world();
    await invalidateRepoAccess(prisma, { projectId: row.id });
    gh.failRolesWith = status(502);
    expect((await getRoleInfo(prisma, gh, row, asUser(owner))).role).toBe('NONE');
  });

  it('private: 404 and 403 deny even inside the grace window', async () => {
    const { owner, row } = await world();
    for (const code of [403, 404]) {
      await age(owner.userId, ROLE_CACHE_TTL_MS + 1000);
      gh.failRolesWith = status(code);
      expect((await getRoleInfo(prisma, gh, row, asUser(owner))).role).toBe('NONE');
    }
  });

  it('private: a rate-limited 403 or a 429 keeps the cached role inside the grace window', async () => {
    const rateLimited403 = Object.assign(status(403), {
      response: { headers: { 'x-ratelimit-remaining': '0' } },
    });
    for (const err of [rateLimited403, status(429)]) {
      const { owner, row } = await world();
      await age(owner.userId, ROLE_CACHE_TTL_MS + 1000);
      gh.failRolesWith = err;
      expect((await getRoleInfo(prisma, gh, row, asUser(owner))).role).toBe('ADMIN');
      expect(results).toContain('grace');
      results.length = 0;
    }
  });

  it('private: a 401 (the app credentials, not the user) does not revoke the cached role', async () => {
    const { owner, row } = await world();
    await age(owner.userId, ROLE_CACHE_TTL_MS + 1000);
    gh.failRolesWith = status(401);
    expect((await getRoleInfo(prisma, gh, row, asUser(owner))).role).toBe('ADMIN');
    expect(results).toContain('grace');
  });
});

describe('public repositories are unaffected', () => {
  it('keep the stored owner and the old outage behaviour', async () => {
    const { owner, repo, project, row } = await world(false);
    gh.roles.delete(roleKey(repo, owner)); // GitHub would say NONE, but it is public
    await stale(owner.userId);
    const s = await sees(owner, project.id);
    expect(s).toMatchObject({ usageRuns: 1, usageProjects: 1, poolProjects: 1, mine: 1 });
    expect(s.templatesStatus).not.toBe(404);

    // Outage far beyond the grace window: the cached role is still used (legacy behaviour).
    gh.roles.set(roleKey(repo, owner), 'ADMIN');
    await stale(owner.userId);
    await getRoleInfo(prisma, gh, row, asUser(owner));
    await age(owner.userId, 24 * 3600_000);
    gh.failRolesWith = status(403);
    expect((await getRoleInfo(prisma, gh, row, asUser(owner))).role).toBe('ADMIN');
    expect(results).not.toContain('outage_denied');
  });
});
