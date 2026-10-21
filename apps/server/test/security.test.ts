import { createHash } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { ProjectViewSchema, TaskViewSchema } from '@orch/shared';
import { signBody } from '../src/webhooks';
import { loadConfig } from '../src/config';
import {
  FakeGithub,
  TEST_WEBHOOK_SECRET,
  api,
  loginAs,
  makeApp,
  prisma,
  repoFor,
  uid,
  type TestUser,
} from './harness';

const gh = new FakeGithub();
const app = makeApp(gh);
afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

async function world(visibility: 'ALL_MEMBERS' | 'COLLABORATORS' = 'ALL_MEMBERS') {
  const owner = await loginAs(app, gh);
  const repo = repoFor();
  gh.repos.set(owner.token, [repo]);
  gh.roles.set(`${repo.installationId}:${repo.fullName}:${owner.login}`, 'ADMIN');
  const res = await api(app, owner)('POST', '/api/projects', { githubRepoId: repo.githubRepoId });
  const project = ProjectViewSchema.parse(res.json());
  await api(app, owner)('PATCH', `/api/projects/${project.id}`, {
    visibility,
    whoCanParticipate: 'ALL_MEMBERS',
  });
  const t = await api(app, owner)('POST', `/api/projects/${project.id}/tasks`, { title: 'secret' });
  const task = TaskViewSchema.parse(t.json());
  return { owner, repo, project, task };
}

const setRole = (repo: { installationId: number; fullName: string }, u: TestUser, role: string) =>
  gh.roles.set(`${repo.installationId}:${repo.fullName}:${u.login}`, role as never);

describe('task board visibility needs an ACTIVE participation', () => {
  const sees = async (u: TestUser, projectId: string, taskId: string) => [
    (await api(app, u)('GET', `/api/projects/${projectId}/tasks`)).statusCode,
    (await api(app, u)('GET', `/api/tasks/${taskId}`)).statusCode,
    JSON.stringify((await api(app, u)('GET', '/api/tasks')).json()).includes(taskId),
  ];

  it('hides the board from a stranger, a rejected, a pending and an inactive member', async () => {
    const { owner, project, task } = await world();
    await api(app, owner)('PATCH', `/api/projects/${project.id}`, {
      requireParticipantApproval: true,
    });
    const stranger = await loginAs(app, gh);
    expect(await sees(stranger, project.id, task.id)).toEqual([404, 404, false]);

    // PUT participating:false by a stranger does not create a row.
    const off = await api(app, stranger)('PUT', `/api/projects/${project.id}/participation`, {
      participating: false,
      budgetPercent: 10,
      mode: 'approval',
    });
    expect(off.statusCode).toBe(200);
    expect(await prisma.participation.count({ where: { userId: stranger.userId } })).toBe(0);
    expect(await sees(stranger, project.id, task.id)).toEqual([404, 404, false]);

    // pending (approval required, not yet approved)
    const pending = await loginAs(app, gh);
    const put = (u: TestUser, participating: boolean) =>
      api(app, u)('PUT', `/api/projects/${project.id}/participation`, {
        participating,
        budgetPercent: 10,
        mode: 'approval',
      });
    expect((await put(pending, true)).json()).toMatchObject({ status: 'pending' });
    expect(await sees(pending, project.id, task.id)).toEqual([404, 404, false]);

    // approved -> visible; then switched off -> inactive -> hidden again
    await api(app, owner)(
      'POST',
      `/api/projects/${project.id}/participants/${pending.userId}/approve`,
    );
    expect(await sees(pending, project.id, task.id)).toEqual([200, 200, true]);
    await put(pending, false);
    expect(await sees(pending, project.id, task.id)).toEqual([404, 404, false]);

    // rejected
    const rejected = await loginAs(app, gh);
    await put(rejected, true);
    await api(app, owner)(
      'POST',
      `/api/projects/${project.id}/participants/${rejected.userId}/reject`,
    );
    expect(await sees(rejected, project.id, task.id)).toEqual([404, 404, false]);
  });

  it('still shows the board to the owner and to GitHub collaborators', async () => {
    const { owner, repo, project, task } = await world();
    expect(await sees(owner, project.id, task.id)).toEqual([200, 200, true]);
    const reader = await loginAs(app, gh);
    setRole(repo, reader, 'READ');
    expect(await sees(reader, project.id, task.id)).toEqual([200, 200, false]);
  });

  it('hides the pool of the project from a non-active member', async () => {
    const { owner, project } = await world();
    await api(app, owner)('PATCH', `/api/projects/${project.id}`, {
      requireParticipantApproval: true,
    });
    const pending = await loginAs(app, gh);
    await api(app, pending)('PUT', `/api/projects/${project.id}/participation`, {
      participating: true,
      budgetPercent: 10,
      mode: 'approval',
    });
    const res = await api(app, pending)('GET', `/api/pool?projectId=${project.id}`);
    expect([403, 404]).toContain(res.statusCode);
  });
});

describe('owner rights are re-checked against GitHub', () => {
  it('a former admin loses owner powers (tasks and project routes)', async () => {
    const { owner, repo, project, task } = await world();
    expect((await api(app, owner)('PATCH', `/api/projects/${project.id}`, {})).statusCode).toBe(
      200,
    );
    // GitHub now says WRITE; force the cached role to be stale so it is re-synced.
    setRole(repo, owner, 'WRITE');
    await prisma.projectPermission.updateMany({
      where: { userId: owner.userId },
      data: { syncedAt: new Date(0) },
    });
    const res = await api(app, owner)('GET', `/api/tasks/${task.id}`);
    expect(TaskViewSchema.parse(res.json()).canApprove).toBe(false);
    expect((await api(app, owner)('PATCH', `/api/projects/${project.id}`, {})).statusCode).toBe(
      403,
    );
    expect((await api(app, owner)('DELETE', `/api/projects/${project.id}`)).statusCode).toBe(403);
    expect(
      (await api(app, owner)('GET', `/api/projects/${project.id}/participants`)).statusCode,
    ).toBe(403);
  });
});

describe('webhook replay', () => {
  it('drops the same body re-sent under a fresh delivery id', async () => {
    const body = JSON.stringify({ zen: 'replay', n: uid() });
    const send = (delivery: string) =>
      app.inject({
        method: 'POST',
        url: '/api/github/webhook',
        payload: body,
        headers: {
          'content-type': 'application/json',
          'x-github-event': 'ping',
          'x-github-delivery': delivery,
          'x-hub-signature-256': signBody(TEST_WEBHOOK_SECRET, body),
        },
      });
    const first = await send(uid());
    expect(first.json()).toMatchObject({ ok: true, result: 'pong' });
    const replay = await send(uid());
    expect(replay.json()).toEqual({ ok: true, duplicate: true });
    const row = await prisma.webhookDelivery.findFirst({
      where: { bodyHash: createHash('sha256').update(body).digest('hex') },
    });
    expect(row).not.toBeNull();
  });
});

describe('logging', () => {
  it('never logs the OAuth code or state from the callback URL', async () => {
    const lines: string[] = [];
    const logApp = makeApp(gh, {
      env: { LOG_LEVEL: 'trace' },
      logStream: { write: (s: string) => void lines.push(s) },
    });
    try {
      await logApp.inject({
        method: 'GET',
        url: '/api/auth/github/callback?code=SECRETCODE123&state=SECRETSTATE456',
        headers: { cookie: 'orch_oauth_state=other' },
      });
      const all = lines.join('\n');
      expect(all).toContain('/api/auth/github/callback');
      expect(all).not.toContain('SECRETCODE123');
      expect(all).not.toContain('SECRETSTATE456');
    } finally {
      await logApp.close();
    }
  });
});

describe('sign-in allowlist', () => {
  const login = async (
    a: ReturnType<typeof makeApp>,
    g: FakeGithub,
    name: string,
    orgs: string[] = [],
  ) => {
    const code = `${name}-${uid()}`;
    g.users.set(`tok-${code}`, {
      id: Math.floor(Math.random() * 1e9) + 1,
      login: name,
      name: null,
      avatarUrl: null,
    });
    g.orgs.set(`tok-${code}`, new Set(orgs));
    const res = await a.inject({
      method: 'GET',
      url: `/api/auth/github/callback?code=${code}&state=s`,
      headers: { cookie: 'orch_oauth_state=s' },
    });
    const sc = ([] as string[]).concat((res.headers['set-cookie'] as string[]) ?? []);
    const cookie = sc.find((c) => c.startsWith('orch_session='))?.split(';')[0];
    return { res, cookie, code };
  };
  const me = (a: ReturnType<typeof makeApp>, cookie: string) =>
    a.inject({ method: 'GET', url: '/api/me', headers: { cookie } });

  it('refuses a login that is not on the list with a clear page and no session', async () => {
    const g = new FakeGithub();
    const alice = `Alice${uid()}`;
    const a = makeApp(g, { env: { ORCH_ALLOWED_GITHUB_LOGINS: ` ${alice} , bob` } });
    try {
      const nope = await login(a, g, `mallory-${uid()}`);
      expect(nope.res.statusCode).toBe(403);
      expect(nope.res.headers['content-type']).toContain('text/html');
      expect(nope.res.body).toContain('not allowed on this orch server');
      expect(nope.res.body).toContain('ORCH_ALLOWED_GITHUB_LOGINS');
      expect(nope.cookie).toBeUndefined();
      const ok = await login(a, g, alice.toUpperCase());
      expect(ok.res.statusCode).toBe(302);
      expect((await me(a, ok.cookie!)).statusCode).toBe(200);
    } finally {
      await a.close();
    }
  });

  it('accepts members of an allowed org, case-insensitively, and refuses others', async () => {
    const g = new FakeGithub();
    const a = makeApp(g, { env: { ORCH_ALLOWED_GITHUB_ORGS: 'Acme-Team' } });
    try {
      expect((await login(a, g, `in-${uid()}`, ['acme-team'])).res.statusCode).toBe(302);
      const out = await login(a, g, `out-${uid()}`, ['other']);
      expect(out.res.statusCode).toBe(403);
      expect(out.res.body).toContain('acme-team');
    } finally {
      await a.close();
    }
  });

  it('re-checks existing sessions: a removed org member is signed out (cached)', async () => {
    const g = new FakeGithub();
    const a = makeApp(g, {
      env: { ORCH_ALLOWED_GITHUB_ORGS: 'acme', ORCH_ALLOWLIST_CACHE_SEC: '300' },
    });
    try {
      const u = await login(a, g, `m-${uid()}`, ['acme']);
      expect((await me(a, u.cookie!)).statusCode).toBe(200);
      const calls = g.orgCalls;
      expect((await me(a, u.cookie!)).statusCode).toBe(200);
      expect(g.orgCalls).toBe(calls); // served from the cache
      g.orgs.get(`tok-${u.code}`)!.clear(); // removed from the org on GitHub
      expect((await me(a, u.cookie!)).statusCode).toBe(200); // still within the cache window
    } finally {
      await a.close();
    }
    const a2 = makeApp(g, {
      env: { ORCH_ALLOWED_GITHUB_ORGS: 'acme', ORCH_ALLOWLIST_CACHE_SEC: '0' },
    });
    try {
      const u = await login(a2, g, `m2-${uid()}`, ['acme']);
      expect((await me(a2, u.cookie!)).statusCode).toBe(200);
      g.orgs.get(`tok-${u.code}`)!.clear();
      expect((await me(a2, u.cookie!)).statusCode).toBe(401);
      expect(
        await prisma.session.count({ where: { user: { login: { startsWith: 'm2-' } } } }),
      ).toBe(0);
    } finally {
      await a2.close();
    }
  });

  it('config: production refuses to start without an allowlist unless explicitly opened', () => {
    const base = { DATABASE_URL: 'postgresql://x', NODE_ENV: 'production' };
    expect(() => loadConfig(base)).toThrow(/ORCH_ALLOWED_GITHUB_LOGINS/);
    expect(loadConfig({ ...base, ORCH_ALLOW_ANY_GITHUB_USER: 'true' })).toBeTruthy();
    expect(
      loadConfig({ ...base, ORCH_ALLOWED_GITHUB_ORGS: 'Acme, Beta' }).ORCH_ALLOWED_GITHUB_ORGS,
    ).toEqual(['acme', 'beta']);
    expect(loadConfig({ DATABASE_URL: 'postgresql://x' }).ORCH_ALLOWED_GITHUB_LOGINS).toEqual([]);
  });
});

describe('issue URLs use GITHUB_WEB_URL', () => {
  it('builds the task issueUrl on the configured web host', async () => {
    const g = new FakeGithub();
    const a = makeApp(g, { env: { GITHUB_WEB_URL: 'https://ghe.example.com/' } });
    try {
      const owner = await loginAs(a, g);
      const repo = repoFor();
      g.repos.set(owner.token, [repo]);
      g.roles.set(`${repo.installationId}:${repo.fullName}:${owner.login}`, 'ADMIN');
      const p = ProjectViewSchema.parse(
        (await api(a, owner)('POST', '/api/projects', { githubRepoId: repo.githubRepoId })).json(),
      );
      const t = TaskViewSchema.parse(
        (await api(a, owner)('POST', `/api/projects/${p.id}/tasks`, { title: 'x' })).json(),
      );
      expect(t.issueUrl).toBe(`https://ghe.example.com/${repo.fullName}/issues/${t.issueNumber}`);
    } finally {
      await a.close();
    }
  });
});
