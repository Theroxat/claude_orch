import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { HistoryResponseSchema, ProjectViewSchema, type HistoryResponse } from '@orch/shared';
import {
  FakeGithub,
  api,
  loginAs,
  makeApp,
  prisma,
  repoFor,
  uniqueInt,
  type TestUser,
} from './harness';

let gh: FakeGithub;
let app: FastifyInstance;

beforeAll(() => {
  gh = new FakeGithub();
  app = makeApp(gh);
});
afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

async function project(owner: TestUser, isPrivate = false) {
  const repo = repoFor({ private: isPrivate });
  gh.repos.set(owner.token, [repo]);
  return ProjectViewSchema.parse(
    (await api(app, owner)('POST', '/api/projects', { githubRepoId: repo.githubRepoId })).json(),
  );
}

async function participate(u: TestUser, projectId: string, over: object = {}) {
  await prisma.participation.create({
    data: {
      userId: u.userId,
      projectId,
      active: true,
      approvedAt: new Date(),
      percent: 10,
      mode: 'APPROVAL',
      ...over,
    },
  });
}

let issue = 0;
async function seed(
  projectId: string,
  creator: TestUser,
  over: Record<string, unknown> = {},
  runs: Array<Record<string, unknown> & { user: TestUser }> = [],
) {
  const n = ++issue + uniqueInt() * 0;
  const t = await prisma.task.create({
    data: {
      projectId,
      githubIssueNumber: n,
      githubIssueNodeId: `I_${projectId}_${n}`,
      title: `Task ${n}`,
      bodySnapshot: '',
      bodyHash: 'h',
      baseBranch: 'main',
      createdById: creator.userId,
      status: 'DONE',
      ...over,
    },
  });
  for (const { user, ...r } of runs) {
    await prisma.assignment.create({
      data: {
        taskId: t.id,
        userId: user.userId,
        kind: 'CLAIM',
        status: 'SUCCEEDED',
        startedAt: new Date('2026-03-01T10:00:00Z'),
        finishedAt: new Date('2026-03-01T10:10:00Z'),
        ...r,
      } as never,
    });
  }
  return t;
}

const history = async (u: TestUser | null, qs = ''): Promise<HistoryResponse> => {
  const res = await api(app, u)('GET', `/api/tasks/history${qs}`);
  expect(res.statusCode, res.body).toBe(200);
  return HistoryResponseSchema.parse(res.json());
};

async function world() {
  const owner = await loginAs(app, gh);
  const member = await loginAs(app, gh);
  const p = await project(owner);
  await participate(member, p.id);
  return { owner, member, p };
}

describe('GET /api/tasks/history', () => {
  it('requires a session', async () => {
    const res = await api(app, null)('GET', '/api/tasks/history');
    expect(res.statusCode).toBe(401);
  });

  it('returns the per-task summary', async () => {
    const { owner, member, p } = await world();
    const t = await seed(
      p.id,
      owner,
      { prNumber: 7, prUrl: 'https://github.com/x/y/pull/7', model: 'OPUS', size: 'L' },
      [
        {
          user: member,
          status: 'FAILED',
          failureClass: 'timeout',
          startedAt: new Date('2026-03-01T09:00:00Z'),
          finishedAt: new Date('2026-03-01T09:30:00Z'),
          usageWeighted: 1000n,
        },
        { user: member, usageWeighted: 500n },
      ],
    );
    const r = await history(owner, `?project=${p.id}`);
    expect(r.items).toHaveLength(1);
    expect(r.items[0]).toMatchObject({
      id: t.id,
      projectFullName: p.fullName,
      issueNumber: t.githubIssueNumber,
      issueUrl: expect.stringContaining(`/${p.fullName}/issues/${t.githubIssueNumber}`) as string,
      status: 'DONE',
      model: 'OPUS',
      prNumber: 7,
      attempts: 2,
      lastFailureClass: 'timeout',
      durationMs: 40 * 60_000,
      tokens: 1500,
      createdBy: { githubLogin: owner.login },
      executor: { githubLogin: member.login },
    });
    expect(r.facets?.projects.map((x) => x.id)).toContain(p.id);
    expect(r.facets?.people.map((x) => x.githubLogin)).toEqual(
      expect.arrayContaining([owner.login, member.login]),
    );
  });

  it('leaves out tasks that never ran', async () => {
    const { owner, p } = await world();
    await seed(p.id, owner, { status: 'TODO' });
    await seed(p.id, owner, { status: 'PROPOSED' });
    await seed(p.id, owner, { status: 'TODO' }, [{ user: owner, status: 'FAILED' }]);
    const r = await history(owner, `?project=${p.id}`);
    expect(r.items).toHaveLength(1);
    expect(r.items[0]?.status).toBe('TODO');
  });

  it('filters by status, model, creator, executor, dates and search', async () => {
    const { owner, member, p } = await world();
    const a = await seed(p.id, owner, {
      title: 'Fix login redirect',
      status: 'DONE',
      model: 'SONNET',
      createdAt: new Date('2026-02-10T12:00:00Z'),
      prNumber: 4242,
    });
    const b = await seed(
      p.id,
      member,
      {
        title: 'Add dark mode',
        status: 'IN_REVIEW',
        model: 'OPUS',
        createdAt: new Date('2026-03-05T12:00:00Z'),
      },
      [{ user: member }],
    );
    const c = await seed(p.id, owner, {
      title: 'Cancelled thing',
      status: 'CANCELLED',
      createdAt: new Date('2026-03-20T12:00:00Z'),
    });
    const ids = async (qs: string) =>
      (await history(owner, `?project=${p.id}&${qs}`)).items.map((i) => i.id);

    expect(await ids('status=DONE')).toEqual([a.id]);
    expect((await ids('status=DONE&status=CANCELLED')).sort()).toEqual([a.id, c.id].sort());
    expect(await ids('model=OPUS')).toEqual([b.id]);
    expect(await ids(`creator=${member.login.toUpperCase()}`)).toEqual([b.id]);
    expect(await ids(`executor=${member.login}`)).toEqual([b.id]);
    expect(await ids('from=2026-03-01&to=2026-03-05')).toEqual([b.id]);
    expect(await ids('to=2026-02-10')).toEqual([a.id]);
    expect(await ids('q=DARK')).toEqual([b.id]);
    expect(await ids('q=4242')).toEqual([a.id]);
    expect(await ids(`q=%23${a.githubIssueNumber}`)).toContain(a.id);
    expect(await ids('q=nothing-matches-this')).toEqual([]);
    expect(await ids('status=DONE&model=OPUS')).toEqual([]);
  });

  it('treats % and _ in the search as literal characters', async () => {
    const { owner, p } = await world();
    const a = await seed(p.id, owner, { title: 'Reach 100% coverage' });
    const b = await seed(p.id, owner, { title: 'snake_case rename' });
    await seed(p.id, owner, { title: 'snakeXcase other' });
    const ids = async (q: string) =>
      (await history(owner, `?project=${p.id}&q=${encodeURIComponent(q)}`)).items.map((i) => i.id);
    expect(await ids('%')).toEqual([a.id]);
    expect(await ids('snake_case')).toEqual([b.id]);
    expect(await ids('_')).toEqual([b.id]);
  });

  it('a crafted cursor cannot widen visibility', async () => {
    const { owner, p } = await world();
    const stranger = await loginAs(app, gh);
    const secret = await seed(p.id, owner, { title: 'secret' });
    const cursor = Buffer.from(`2099-01-01T00:00:00.000Z|${secret.id}`).toString('base64url');
    expect((await history(stranger, `?cursor=${cursor}`)).items).toEqual([]);
  });

  it('rejects malformed filters', async () => {
    const { owner } = await world();
    for (const qs of [
      '?status=NOPE',
      '?from=yesterday',
      '?limit=0',
      '?limit=1000',
      '?cursor=%25',
      `?cursor=${Buffer.from('2026-01-01|x').toString('base64url')}`,
      `?cursor=${Buffer.from("2026-01-01T00:00:00.000Z|a'b").toString('base64url')}`,
      `?cursor=${Buffer.from('2026-01-01T00:00:00.000Z|a|b').toString('base64url')}`,
    ]) {
      const res = await api(app, owner)('GET', `/api/tasks/history${qs}`);
      expect(res.statusCode, qs).toBe(400);
    }
  });

  it('paginates in a stable order, even with equal timestamps and concurrent inserts', async () => {
    const { owner, p } = await world();
    const same = new Date('2026-04-01T00:00:00Z');
    const made: string[] = [];
    for (let i = 0; i < 7; i++) {
      made.push(
        (await seed(p.id, owner, { createdAt: i < 4 ? same : new Date(same.getTime() + i * 1000) }))
          .id,
      );
    }
    const expected = (
      await prisma.task.findMany({
        where: { projectId: p.id },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      })
    ).map((t) => t.id);
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const qs: string = `?project=${p.id}&limit=3${cursor ? `&cursor=${cursor}` : ''}`;
      const r: HistoryResponse = await history(owner, qs);
      if (pages === 0) {
        expect(r.facets).toBeDefined();
        // A newer task appearing between pages must not shift or duplicate the next ones.
        await seed(p.id, owner, { createdAt: new Date('2026-05-01T00:00:00Z') });
      } else {
        expect(r.facets).toBeUndefined();
      }
      seen.push(...r.items.map((i) => i.id));
      cursor = r.nextCursor;
      pages++;
    } while (cursor);
    expect(pages).toBe(3);
    expect(seen).toEqual(expected);
    expect(new Set(seen).size).toBe(made.length);
  });

  it('only shows projects the caller owns or actively participates in', async () => {
    const owner = await loginAs(app, gh);
    const member = await loginAs(app, gh);
    const pending = await loginAs(app, gh);
    const outsider = await loginAs(app, gh);
    const priv = await project(owner, true);
    const pub = await project(owner, false);
    await participate(member, priv.id);
    await participate(pending, priv.id, { active: false, approvedAt: null });
    const secret = await seed(priv.id, owner, { title: 'Secret roadmap' });
    const open = await seed(pub.id, owner, { title: 'Public work' });

    const idsOf = async (u: TestUser, qs = '') => (await history(u, qs)).items.map((i) => i.id);
    expect(await idsOf(owner)).toEqual(expect.arrayContaining([secret.id, open.id]));
    expect(await idsOf(member, `?project=${priv.id}`)).toEqual([secret.id]);

    // Pending participation: no access to the private repository.
    expect(await idsOf(pending, `?project=${priv.id}`)).toEqual([]);
    // Nobody related to the project: nothing, even when asking for it by id or by text.
    for (const qs of [`?project=${priv.id}`, `?project=${pub.id}`, '?q=Secret', '?q=Public']) {
      expect(await idsOf(outsider, qs), qs).toEqual([]);
    }
    const r = await history(outsider, `?project=${priv.id}`);
    expect(r.facets).toEqual({ projects: [], people: [] });
    // Facets of the member do not reveal other projects either.
    const f = (await history(member)).facets;
    expect(f?.projects.map((x) => x.id)).toEqual([priv.id]);
  });
});
