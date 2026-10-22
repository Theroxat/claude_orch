/** Usage dashboard: aggregation correctness and who sees what. Seeds rows directly. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { UsageDashboardSchema } from '@orch/shared';
import { computeUsageDashboard } from '../src/usage/dashboard';
import {
  FakeGithub,
  api,
  loginAs,
  makeApp,
  prisma,
  uid,
  uniqueInt,
  type TestUser,
} from './harness';

let app: FastifyInstance;
let gh: FakeGithub;
let installationId: string;

beforeAll(async () => {
  gh = new FakeGithub();
  app = makeApp(gh);
  const inst = await prisma.installation.create({
    data: {
      githubInstallationId: BigInt(uniqueInt()),
      accountLogin: 'acme',
      accountType: 'Organization',
    },
  });
  installationId = inst.id;
});
afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

const HOUR = 3600_000;
const ago = (days: number, hours = 0) => new Date(Date.now() - days * 24 * HOUR - hours * HOUR);

async function project(owner: TestUser, name: string) {
  return prisma.project.create({
    data: {
      githubRepoId: BigInt(uniqueInt()),
      fullName: `acme/${name}-${uid()}`,
      installationId,
      defaultBranch: 'main',
      isPrivate: true,
      addedById: owner.userId,
    },
  });
}
async function task(projectId: string, creator: TestUser, title: string) {
  return prisma.task.create({
    data: {
      projectId,
      githubIssueNumber: uniqueInt(),
      githubIssueNodeId: `n${uid()}`,
      title,
      bodySnapshot: '',
      bodyHash: 'h',
      baseBranch: 'main',
      createdById: creator.userId,
    },
  });
}
async function run(
  taskId: string,
  user: TestUser,
  status: 'SUCCEEDED' | 'FAILED' | 'RUNNING',
  weighted: number | null,
  finishedAt: Date | null,
) {
  return prisma.assignment.create({
    data: {
      taskId,
      userId: user.userId,
      kind: 'CLAIM',
      status,
      finishedAt,
      usageWeighted: weighted === null ? null : BigInt(weighted),
    },
  });
}
async function agentOf(user: TestUser) {
  return prisma.agent.create({
    data: {
      id: `agt_${uid()}`,
      userId: user.userId,
      name: 'box',
      secretHash: 'x',
      secretPrefix: 'x',
    },
  });
}
async function report(
  agentId: string,
  user: TestUser,
  windowStart: Date,
  reportedAt: Date,
  input: number,
) {
  return prisma.usageReport.create({
    data: {
      agentId,
      userId: user.userId,
      reportedAt,
      windowStart,
      windowResetAt: new Date(windowStart.getTime() + 5 * HOUR),
      inputTokens: BigInt(input),
      outputTokens: BigInt(input * 2),
      cacheWriteTokens: BigInt(3),
      cacheReadTokens: BigInt(4),
      weightedTokens: BigInt(input),
      byProject: {},
      byModel: {},
      source: 'jsonl',
    },
  });
}

describe('aggregation', () => {
  it('sums runs and tokens per day, member, project and task, and zero-fills the range', async () => {
    const owner = await loginAs(app, gh);
    const other = await loginAs(app, gh);
    const p = await project(owner, 'agg');
    const t1 = await task(p.id, owner, 'Big task');
    const t2 = await task(p.id, owner, 'Small task');
    await run(t1.id, owner, 'SUCCEEDED', 1000, ago(1));
    await run(t1.id, other, 'FAILED', 500, ago(1));
    await run(t2.id, owner, 'SUCCEEDED', 100, ago(3));
    await run(t2.id, owner, 'RUNNING', null, null); // not finished: ignored
    await run(t2.id, owner, 'SUCCEEDED', 9999, ago(40)); // outside 30d, inside 90d

    const viewer = { id: owner.userId, isAdmin: false };
    const d30 = await computeUsageDashboard(prisma, viewer, '30d', 0);
    UsageDashboardSchema.parse(d30);
    expect(d30.series).toHaveLength(30);
    expect(d30.totals).toEqual({ runs: 3, succeeded: 2, failed: 1, weighted: 1600 });
    expect(d30.series.reduce((n, s) => n + s.weighted, 0)).toBe(1600);
    expect(d30.series.at(-1)!.day).toBe(new Date().toISOString().slice(0, 10));
    expect(d30.projects).toEqual([
      { projectId: p.id, fullName: p.fullName, runs: 3, succeeded: 2, failed: 1, weighted: 1600 },
    ]);
    expect(d30.members.map((m) => [m.login, m.weighted, m.runs])).toEqual([
      [owner.login, 1100, 2],
      [other.login, 500, 1],
    ]);
    expect(d30.topTasks.map((t) => [t.title, t.weighted, t.runs])).toEqual([
      ['Big task', 1500, 2],
      ['Small task', 100, 1],
    ]);

    const d7 = await computeUsageDashboard(prisma, viewer, '7d', 0);
    expect(d7.series).toHaveLength(7);
    expect(d7.totals.weighted).toBe(1600);
    const d90 = await computeUsageDashboard(prisma, viewer, '90d', 0);
    expect(d90.series).toHaveLength(90);
    expect(d90.totals.weighted).toBe(1600 + 9999);
  });

  it('counts the latest report of each window once for the token split', async () => {
    const u = await loginAs(app, gh);
    const a = await agentOf(u);
    const w = ago(2, 6);
    await report(a.id, u, w, new Date(w.getTime() + HOUR), 100);
    await report(a.id, u, w, new Date(w.getTime() + 2 * HOUR), 400); // supersedes the first
    const d = await computeUsageDashboard(prisma, { id: u.userId, isAdmin: false }, '7d', 0);
    expect(d.tokenSplit).toEqual({ input: 400, output: 800, cacheWrite: 3, cacheRead: 4 });
    expect(d.series.find((s) => s.input !== null)?.input).toBe(400);
    const empty = await loginAs(app, gh);
    const e = await computeUsageDashboard(prisma, { id: empty.userId, isAdmin: false }, '7d', 0);
    expect(e.tokenSplit).toBeNull();
    expect(e.totals.runs).toBe(0);
    expect(e.members).toEqual([]);
  });

  it('computes budget consumption against the participation percent', async () => {
    const u = await loginAs(app, gh);
    const owner = await loginAs(app, gh);
    const p = await project(owner, 'budget');
    await prisma.participation.create({
      data: { userId: u.userId, projectId: p.id, active: true, percent: 40, mode: 'AUTO' },
    });
    const a = await agentOf(u);
    const now = new Date();
    const windowStart = new Date(now.getTime() - HOUR);
    await prisma.usageReport.create({
      data: {
        agentId: a.id,
        userId: u.userId,
        reportedAt: now,
        windowStart,
        windowResetAt: new Date(windowStart.getTime() + 5 * HOUR),
        inputTokens: 0n,
        outputTokens: 0n,
        cacheWriteTokens: 0n,
        cacheReadTokens: 0n,
        weightedTokens: 5_000n,
        byProject: { [p.id]: 5_000 },
        byModel: {},
        capacityEstimate: 100_000n,
        source: 'jsonl',
      },
    });
    const d = await computeUsageDashboard(prisma, { id: u.userId, isAdmin: false }, '7d', 0);
    expect(d.budgets).toEqual([
      {
        projectId: p.id,
        fullName: p.fullName,
        percent: 40,
        budget: 40_000,
        used: 5_000,
        usedFraction: 0.125,
      },
    ]);
  });
});

describe('authorization', () => {
  it('requires a session and validates the range', async () => {
    const anon = await api(app, null)('GET', '/api/usage');
    expect(anon.statusCode).toBe(401);
    const u = await loginAs(app, gh);
    expect((await api(app, u)('GET', '/api/usage?range=1y')).statusCode).toBe(400);
    const ok = await api(app, u)('GET', '/api/usage');
    expect(ok.statusCode).toBe(200);
    expect(UsageDashboardSchema.parse(ok.json()).range).toBe('30d');
  });

  it('shows members their own runs and owners the whole project, nothing else', async () => {
    const owner = await loginAs(app, gh);
    const member = await loginAs(app, gh);
    const stranger = await loginAs(app, gh);
    const p = await project(owner, 'authz');
    const mine = await project(member, 'mine');
    const t = await task(p.id, owner, 'Shared');
    const tm = await task(mine.id, member, 'Mine');
    await run(t.id, owner, 'SUCCEEDED', 700, ago(1));
    await run(t.id, member, 'SUCCEEDED', 300, ago(1));
    await run(tm.id, member, 'SUCCEEDED', 50, ago(1));

    const get = async (u: TestUser) => {
      const res = await api(app, u)('GET', '/api/usage?range=7d');
      expect(res.statusCode).toBe(200);
      return UsageDashboardSchema.parse(res.json());
    };
    const own = await get(owner);
    expect(own.totals.weighted).toBe(1000); // both runs of the owned project
    expect(own.members.map((m) => m.login).sort()).toEqual([member.login, owner.login].sort());

    const mem = await get(member);
    expect(mem.totals.weighted).toBe(350); // own run in the shared project + own project
    expect(mem.members.map((m) => m.login)).toEqual([member.login]);
    expect(mem.projects.map((x) => x.projectId).sort()).toEqual([p.id, mine.id].sort());
    expect(mem.projects.find((x) => x.projectId === p.id)!.weighted).toBe(300);
    expect(mem.scope).toBe('own');

    const none = await get(stranger);
    expect(none.totals.runs).toBe(0);
    expect(none.projects).toEqual([]);
    expect(none.topTasks).toEqual([]);
  });

  it('never leaks the token split of another member to a project owner', async () => {
    const owner = await loginAs(app, gh);
    const member = await loginAs(app, gh);
    const a = await agentOf(member);
    await report(a.id, member, ago(1, 3), ago(1, 2), 123);
    const d = await computeUsageDashboard(prisma, { id: owner.userId, isAdmin: false }, '7d', 0);
    expect(d.tokenSplit).toBeNull();
  });

  it('lets an admin see every project and every token split', async () => {
    const owner = await loginAs(app, gh);
    const admin = await loginAs(app, gh);
    const p = await project(owner, 'admin');
    const t = await task(p.id, owner, 'Hidden');
    await run(t.id, owner, 'SUCCEEDED', 42, ago(1));
    const a = await agentOf(owner);
    await report(a.id, owner, ago(1, 3), ago(1, 2), 77);
    const d = await computeUsageDashboard(prisma, { id: admin.userId, isAdmin: true }, '7d', 0);
    expect(d.scope).toBe('admin');
    expect(d.projects.map((x) => x.projectId)).toContain(p.id);
    expect(d.tokenSplit!.input).toBeGreaterThanOrEqual(77);
  });
});
