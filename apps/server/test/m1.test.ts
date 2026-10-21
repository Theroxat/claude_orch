import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  DiscoverItemSchema,
  ParticipationViewSchema,
  ProjectViewSchema,
  type DiscoverItem,
} from '@orch/shared';
import { FakeGithub, api, loginAs, makeApp, prisma, repoFor, type TestUser } from './harness';

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

/** Signs a user in and creates a project they own. */
async function ownerWithProject(over: Parameters<typeof repoFor>[0] = {}) {
  const owner = await loginAs(app, gh);
  const repo = repoFor(over);
  gh.repos.set(owner.token, [repo]);
  const res = await api(app, owner)('POST', '/api/projects', { githubRepoId: repo.githubRepoId });
  expect(res.statusCode).toBe(201);
  const project = ProjectViewSchema.parse(res.json());
  return { owner, repo, project };
}

function setRole(repo: { installationId: number; fullName: string }, u: TestUser, role: string) {
  gh.roles.set(`${repo.installationId}:${repo.fullName}:${u.login}`, role as never);
}

describe('auth', () => {
  it('login redirects to GitHub with a state cookie', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/auth/github/login' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain('https://github.com/login/oauth/authorize');
    expect(res.headers.location).toContain('client_id=test-client-id');
    expect(String(res.headers['set-cookie'])).toContain('orch_oauth_state=');
  });

  it('callback creates the user, sets a session cookie and redirects to /', async () => {
    const u = await loginAs(app, gh);
    const db = await prisma.user.findUniqueOrThrow({ where: { id: u.userId } });
    expect(db.login).toBe(u.login);
    expect(db.ghAccessTokenEnc).toBeTruthy();
    expect(Buffer.from(db.ghAccessTokenEnc!).toString('utf8')).not.toContain(u.token);
    const me = await api(app, u)('GET', '/api/me');
    expect(me.statusCode).toBe(200);
    expect(me.json()).toEqual({
      id: u.userId,
      githubLogin: u.login,
      name: `Name ${u.login}`,
      avatarUrl: `https://a/${u.login}.png`,
      onboardingCompletedAt: null,
      onboardingDismissedAt: null,
      isAdmin: false,
    });
  });

  it('session cookie is httpOnly and SameSite=Lax; callback redirects to /', async () => {
    const login = `c-${Date.now()}`;
    gh.users.set(`tok-${login}`, { id: Date.now(), login, name: null, avatarUrl: null });
    const res = await app.inject({
      method: 'GET',
      url: `/api/auth/github/callback?code=${login}&state=x`,
      headers: { cookie: 'orch_oauth_state=x' },
    });
    expect(res.headers.location).toBe('/');
    const c = ([] as string[])
      .concat(res.headers['set-cookie'] as string[])
      .find((x) => x.startsWith('orch_session='))!;
    expect(c).toContain('HttpOnly');
    expect(c).toContain('SameSite=Lax');
  });

  it('callback updates an existing user instead of duplicating', async () => {
    const u = await loginAs(app, gh);
    gh.users.set(u.token, { id: u.id, login: u.login, name: 'Renamed', avatarUrl: null });
    const res = await app.inject({
      method: 'GET',
      url: `/api/auth/github/callback?code=${u.login}&state=s`,
      headers: { cookie: 'orch_oauth_state=s' },
    });
    expect(res.statusCode).toBe(302);
    expect(await prisma.user.count({ where: { githubId: BigInt(u.id) } })).toBe(1);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: u.userId } })).name).toBe('Renamed');
  });

  it('rejects a callback with a bad state', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/auth/github/callback?code=x&state=a',
      headers: { cookie: 'orch_oauth_state=b' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('invalid_state');
  });

  it('returns 401 without a session on every protected route', async () => {
    const call = api(app, null);
    for (const [m, url] of [
      ['GET', '/api/me'],
      ['GET', '/api/github/install-url'],
      ['GET', '/api/repos/available'],
      ['POST', '/api/projects'],
      ['GET', '/api/projects/mine'],
      ['GET', '/api/projects/discover'],
      ['PATCH', '/api/projects/x'],
      ['DELETE', '/api/projects/x'],
      ['PUT', '/api/projects/x/participation'],
      ['GET', '/api/projects/x/participants'],
      ['POST', '/api/projects/x/participants/y/approve'],
      ['POST', '/api/projects/x/participants/y/reject'],
      ['POST', '/api/projects/x/participants/y/undo-rejection'],
    ] as const) {
      const res = await call(m, url, m === 'GET' ? undefined : {});
      expect(res.statusCode, `${m} ${url}`).toBe(401);
      expect(res.json().error.code).toBe('unauthorized');
    }
  });

  it('logout deletes the session', async () => {
    const u = await loginAs(app, gh);
    const out = await api(app, u)('POST', '/api/auth/logout');
    expect(out.statusCode).toBe(204);
    expect((await api(app, u)('GET', '/api/me')).statusCode).toBe(401);
  });

  it('rejects cross-origin state-changing requests', async () => {
    const u = await loginAs(app, gh);
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { cookie: u.cookie, origin: 'https://evil.example' },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('projects', () => {
  it('install-url returns the App installation link', async () => {
    const u = await loginAs(app, gh);
    const res = await api(app, u)('GET', '/api/github/install-url');
    expect(res.json()).toEqual({ url: 'https://github.com/apps/orch-test/installations/new' });
  });

  it('lists only admin repos as available, flagging added ones', async () => {
    const u = await loginAs(app, gh);
    const adminRepo = repoFor();
    const writeRepo = repoFor({ admin: false });
    gh.repos.set(u.token, [adminRepo, writeRepo]);
    let res = await api(app, u)('GET', '/api/repos/available');
    expect(res.json()).toEqual([
      {
        githubRepoId: adminRepo.githubRepoId,
        fullName: adminRepo.fullName,
        private: false,
        installationId: 4242,
        alreadyAdded: false,
      },
    ]);
    await api(app, u)('POST', '/api/projects', { githubRepoId: adminRepo.githubRepoId });
    res = await api(app, u)('GET', '/api/repos/available');
    expect(res.json()[0].alreadyAdded).toBe(true);
  });

  it('adds a project as admin and makes the caller the owner', async () => {
    const { owner, project, repo } = await ownerWithProject();
    expect(project.ownerId).toBe(owner.userId);
    expect(project.fullName).toBe(repo.fullName);
    const mine = await api(app, owner)('GET', '/api/projects/mine');
    expect(mine.json().map((p: { id: string }) => p.id)).toEqual([project.id]);
    const audits = await prisma.auditLog.count({
      where: { projectId: project.id, action: 'project.added' },
    });
    expect(audits).toBe(1);
  });

  it('requires repo admin to add a project', async () => {
    const u = await loginAs(app, gh);
    const repo = repoFor({ admin: false });
    gh.repos.set(u.token, [repo]);
    const res = await api(app, u)('POST', '/api/projects', { githubRepoId: repo.githubRepoId });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('not_admin');
    expect(await prisma.project.count({ where: { githubRepoId: BigInt(repo.githubRepoId) } })).toBe(
      0,
    );
  });

  it('answers app_not_installed when the repo is not reachable through the App', async () => {
    const u = await loginAs(app, gh);
    const res = await api(app, u)('POST', '/api/projects', { githubRepoId: 999 });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('app_not_installed');
  });

  it('refuses to add the same repo twice and validates the body', async () => {
    const { owner, repo } = await ownerWithProject();
    const dup = await api(app, owner)('POST', '/api/projects', { githubRepoId: repo.githubRepoId });
    expect(dup.statusCode).toBe(409);
    const bad = await api(app, owner)('POST', '/api/projects', { githubRepoId: 'x' });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe('invalid_request');
  });

  it('owner can patch settings; invalid values are rejected', async () => {
    const { owner, project } = await ownerWithProject();
    const res = await api(app, owner)('PATCH', `/api/projects/${project.id}`, {
      visibility: 'ALL_MEMBERS',
      requireParticipantApproval: false,
      whoCanParticipate: 'ALL_MEMBERS',
    });
    expect(res.statusCode).toBe(200);
    expect(ProjectViewSchema.parse(res.json())).toMatchObject({
      visibility: 'ALL_MEMBERS',
      requireParticipantApproval: false,
      whoCanParticipate: 'ALL_MEMBERS',
    });
    const bad = await api(app, owner)('PATCH', `/api/projects/${project.id}`, {
      visibility: 'public',
    });
    expect(bad.statusCode).toBe(400);
  });

  it('owner can delete a project', async () => {
    const { owner, project } = await ownerWithProject();
    const res = await api(app, owner)('DELETE', `/api/projects/${project.id}`);
    expect(res.statusCode).toBe(204);
    expect(await prisma.project.count({ where: { id: project.id } })).toBe(0);
  });

  it('forbids non-owners on every owner route, even GitHub admins', async () => {
    const { project, repo } = await ownerWithProject();
    const other = await loginAs(app, gh);
    setRole(repo, other, 'ADMIN');
    const call = api(app, other);
    const victim = await loginAs(app, gh);
    for (const [m, url, body] of [
      ['PATCH', `/api/projects/${project.id}`, { visibility: 'ALL_MEMBERS' }],
      ['DELETE', `/api/projects/${project.id}`, undefined],
      ['GET', `/api/projects/${project.id}/participants`, undefined],
      ['POST', `/api/projects/${project.id}/participants/${victim.userId}/approve`, {}],
      ['POST', `/api/projects/${project.id}/participants/${victim.userId}/reject`, {}],
      [
        'POST',
        `/api/projects/${project.id}/participants/${victim.userId}/undo-rejection`,
        { to: 'approved' },
      ],
    ] as const) {
      const res = await call(m, url, body);
      expect(res.statusCode, `${m} ${url}`).toBe(403);
      expect(res.json().error.code).toBe('forbidden');
    }
    expect(await prisma.project.count({ where: { id: project.id } })).toBe(1);
  });
});

describe('discover', () => {
  it('exposes canParticipate and the reason for each item', async () => {
    const a = await ownerWithProject(); // participation policy GITHUB by default
    await api(app, a.owner)('PATCH', `/api/projects/${a.project.id}`, {
      visibility: 'ALL_MEMBERS',
    });
    const reader = await loginAs(app, gh);
    setRole(a.repo, reader, 'READ');
    const outsider = await loginAs(app, gh);
    const find = async (u: TestUser) =>
      ((await api(app, u)('GET', '/api/projects/discover')).json() as DiscoverItem[]).find(
        (i) => i.project.id === a.project.id,
      )!;
    expect(await find(reader)).toMatchObject({
      canParticipate: true,
      cannotParticipateReason: null,
    });
    expect(await find(outsider)).toMatchObject({
      canParticipate: false,
      cannotParticipateReason: 'NOT_GITHUB_COLLABORATOR',
    });
    await api(app, a.owner)('PATCH', `/api/projects/${a.project.id}`, {
      whoCanParticipate: 'ALL_MEMBERS',
    });
    expect(await find(outsider)).toMatchObject({ canParticipate: true });
  });

  it('excludes my own projects and applies visibility rules', async () => {
    const a = await ownerWithProject(); // COLLABORATORS (default)
    const b = await ownerWithProject();
    await api(app, b.owner)('PATCH', `/api/projects/${b.project.id}`, {
      visibility: 'ALL_MEMBERS',
    });
    const c = await ownerWithProject();
    await api(app, c.owner)('PATCH', `/api/projects/${c.project.id}`, { visibility: 'ALLOWLIST' });

    const reader = await loginAs(app, gh);
    setRole(a.repo, reader, 'READ');
    const outsider = await loginAs(app, gh);

    const ids = async (u: TestUser) =>
      ((await api(app, u)('GET', '/api/projects/discover')).json() as DiscoverItem[]).map(
        (i) => i.project.id,
      );

    const readerIds = await ids(reader);
    expect(readerIds).toContain(a.project.id);
    expect(readerIds).toContain(b.project.id);
    expect(readerIds).not.toContain(c.project.id);

    const outIds = await ids(outsider);
    expect(outIds).not.toContain(a.project.id);
    expect(outIds).toContain(b.project.id);
    expect(outIds).not.toContain(c.project.id);

    // The owner never sees their own project.
    expect(await ids(a.owner)).not.toContain(a.project.id);

    // Allowlist override makes it visible.
    await prisma.projectPermission.upsert({
      where: { projectId_userId: { projectId: c.project.id, userId: outsider.userId } },
      create: {
        projectId: c.project.id,
        userId: outsider.userId,
        githubRole: 'NONE',
        canParticipate: true,
        syncedAt: new Date(),
      },
      update: { canParticipate: true },
    });
    expect(await ids(outsider)).toContain(c.project.id);
  });

  it('returns owner, role and own participation, and maps roles', async () => {
    const { owner, repo, project } = await ownerWithProject();
    const writer = await loginAs(app, gh);
    setRole(repo, writer, 'WRITE');
    const reader = await loginAs(app, gh);
    setRole(repo, reader, 'READ');
    const get = async (u: TestUser) =>
      DiscoverItemSchema.array()
        .parse((await api(app, u)('GET', '/api/projects/discover')).json())
        .find((i) => i.project.id === project.id)!;
    const w = await get(writer);
    expect(w.myRole).toBe('submitter');
    expect(w.owner.githubLogin).toBe(owner.login);
    expect(w.myParticipation).toBeNull();
    expect((await get(reader)).myRole).toBe('proposer');
    await api(app, reader)('PUT', `/api/projects/${project.id}/participation`, {
      participating: true,
      budgetPercent: 10,
      mode: 'auto',
    });
    expect((await get(reader)).myParticipation).toMatchObject({
      budgetPercent: 10,
      status: 'pending',
    });
  });

  it('caches GitHub roles briefly and survives GitHub failures', async () => {
    const { repo } = await ownerWithProject();
    const u = await loginAs(app, gh);
    setRole(repo, u, 'READ');
    await api(app, u)('GET', '/api/projects/discover');
    const calls = gh.roleCalls;
    await api(app, u)('GET', '/api/projects/discover');
    expect(gh.roleCalls).toBe(calls); // served from the cache
    gh.failRoles = true;
    const other = await loginAs(app, gh);
    const res = await api(app, other)('GET', '/api/projects/discover');
    gh.failRoles = false;
    expect(res.statusCode).toBe(200);
  });
});

describe('participation', () => {
  async function setup() {
    const ctx = await ownerWithProject();
    const member = await loginAs(app, gh);
    setRole(ctx.repo, member, 'READ');
    const put = (u: TestUser, body: unknown, projectId = ctx.project.id) =>
      api(app, u)('PUT', `/api/projects/${projectId}/participation`, body);
    return { ...ctx, member, put };
  }

  it('validates percent bounds and mode', async () => {
    const { member, put } = await setup();
    for (const body of [
      { participating: true, budgetPercent: -1, mode: 'auto' },
      { participating: true, budgetPercent: 101, mode: 'auto' },
      { participating: true, budgetPercent: 10.5, mode: 'auto' },
      { participating: true, budgetPercent: 10, mode: 'manual' },
      { participating: 'yes', budgetPercent: 10, mode: 'auto' },
      { budgetPercent: 10, mode: 'auto' },
    ]) {
      const res = await put(member, body);
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
    }
    for (const p of [0, 100]) {
      expect(
        (await put(member, { participating: true, budgetPercent: p, mode: 'approval' })).statusCode,
      ).toBe(200);
    }
  });

  it('is pending until the owner approves, then active', async () => {
    const { owner, member, project, put } = await setup();
    const res = await put(member, { participating: true, budgetPercent: 30, mode: 'approval' });
    expect(ParticipationViewSchema.parse(res.json())).toMatchObject({
      participating: true,
      budgetPercent: 30,
      mode: 'approval',
      status: 'pending',
      approvedAt: null,
    });
    const list = await api(app, owner)('GET', `/api/projects/${project.id}/participants`);
    expect(list.json()).toHaveLength(1);
    expect(list.json()[0].user.githubLogin).toBe(member.login);
    const ok = await api(app, owner)(
      'POST',
      `/api/projects/${project.id}/participants/${member.userId}/approve`,
    );
    expect(ok.json()).toMatchObject({ status: 'active', participating: true, budgetPercent: 30 });
    expect(ok.json().approvedAt).toBeTruthy();
  });

  it('reject keeps the member choices and a new request goes back to pending', async () => {
    const { owner, member, project, put } = await setup();
    await put(member, { participating: true, budgetPercent: 20, mode: 'auto' });
    const rej = await api(app, owner)(
      'POST',
      `/api/projects/${project.id}/participants/${member.userId}/reject`,
    );
    expect(rej.json()).toMatchObject({
      status: 'rejected',
      participating: true,
      budgetPercent: 20,
      mode: 'auto',
    });
    const again = await put(member, { participating: true, budgetPercent: 20, mode: 'auto' });
    expect(again.json().status).toBe('pending');
  });

  it('the owner joins their own pool through the same PUT and is active at once', async () => {
    const { owner, project, put } = await setup();
    const res = await put(owner, { participating: true, budgetPercent: 40, mode: 'auto' });
    expect(res.statusCode).toBe(200);
    expect(ParticipationViewSchema.parse(res.json())).toMatchObject({
      participating: true,
      status: 'active',
      rejectionReason: null,
      previouslyRejectedAt: null,
    });
    const log = await prisma.auditLog.findFirstOrThrow({
      where: { projectId: project.id, action: 'participation.updated', actorUserId: owner.userId },
    });
    expect(log.data).toMatchObject({ active: true, ownerAutoApproved: true, reapplied: false });
    // The owner cannot be rejected from their own pool.
    const rej = await api(app, owner)(
      'POST',
      `/api/projects/${project.id}/participants/${owner.userId}/reject`,
      { reason: 'no' },
    );
    expect(rej.statusCode).toBe(400);
    expect(rej.json().error.code).toBe('cannot_reject_owner');
    const off = await put(owner, { participating: false, budgetPercent: 40, mode: 'auto' });
    expect(off.json().status).toBe('inactive');
  });

  it('stores a rejection reason, shows it to the member and keeps it on re-application', async () => {
    const { owner, member, project, put } = await setup();
    const path = `/api/projects/${project.id}/participants/${member.userId}`;
    await put(member, { participating: true, budgetPercent: 20, mode: 'auto' });
    const tooLong = await api(app, owner)('POST', `${path}/reject`, { reason: 'x'.repeat(501) });
    expect(tooLong.statusCode).toBe(400);
    const rej = await api(app, owner)('POST', `${path}/reject`, { reason: '  Not now  ' });
    expect(rej.json()).toMatchObject({ status: 'rejected', rejectionReason: 'Not now' });
    expect(rej.json().previouslyRejectedAt).toBeNull();

    const disc = await api(app, member)('GET', '/api/projects/discover');
    const item = (disc.json() as DiscoverItem[]).find((i) => i.project.id === project.id);
    expect(item?.myParticipation).toMatchObject({ status: 'rejected', rejectionReason: 'Not now' });

    const again = await put(member, { participating: true, budgetPercent: 20, mode: 'auto' });
    expect(again.json()).toMatchObject({ status: 'pending', rejectionReason: 'Not now' });
    expect(again.json().previouslyRejectedAt).toBeTruthy();
    const list = await api(app, owner)('GET', `/api/projects/${project.id}/participants`);
    expect(list.json()[0].participation).toMatchObject({
      status: 'pending',
      rejectionReason: 'Not now',
    });
    expect(list.json()[0].participation.previouslyRejectedAt).toBeTruthy();

    const actions = await prisma.auditLog.findMany({
      where: { projectId: project.id, action: { startsWith: 'participation.' } },
      orderBy: { id: 'asc' },
    });
    expect(actions.map((a) => a.action)).toEqual([
      'participation.updated',
      'participation.rejected',
      'participation.updated',
    ]);
    expect(actions[1]!.data).toEqual({ reason: 'Not now' });
    expect(actions[2]!.data).toMatchObject({ reapplied: true, ownerAutoApproved: false });

    // Approving clears the rejection history.
    const ok = await api(app, owner)('POST', `${path}/approve`);
    expect(ok.json()).toMatchObject({
      status: 'active',
      rejectionReason: null,
      previouslyRejectedAt: null,
    });
  });

  it('a reject without a body stores no reason', async () => {
    const { owner, member, project, put } = await setup();
    await put(member, { participating: true, budgetPercent: 20, mode: 'auto' });
    const rej = await api(app, owner)(
      'POST',
      `/api/projects/${project.id}/participants/${member.userId}/reject`,
    );
    expect(rej.json()).toMatchObject({ status: 'rejected', rejectionReason: null });
  });

  it('the owner can undo a rejection, back to pending or approved', async () => {
    const { owner, member, project, put } = await setup();
    const path = `/api/projects/${project.id}/participants/${member.userId}`;
    await put(member, { participating: true, budgetPercent: 20, mode: 'auto' });

    const notRejected = await api(app, owner)('POST', `${path}/undo-rejection`, { to: 'pending' });
    expect(notRejected.statusCode).toBe(409);
    expect(notRejected.json().error.code).toBe('not_rejected');
    const bad = await api(app, owner)('POST', `${path}/undo-rejection`, { to: 'active' });
    expect(bad.statusCode).toBe(400);

    await api(app, owner)('POST', `${path}/reject`, { reason: 'later' });
    const pending = await api(app, owner)('POST', `${path}/undo-rejection`, { to: 'pending' });
    expect(pending.statusCode).toBe(200);
    expect(pending.json()).toMatchObject({
      status: 'pending',
      participating: true,
      budgetPercent: 20,
      rejectionReason: null,
      previouslyRejectedAt: null,
    });

    await api(app, owner)('POST', `${path}/reject`);
    const approved = await api(app, owner)('POST', `${path}/undo-rejection`, { to: 'approved' });
    expect(approved.json()).toMatchObject({ status: 'active', mode: 'auto' });

    const undone = await prisma.auditLog.findMany({
      where: { projectId: project.id, action: 'participation.rejection_undone' },
      orderBy: { id: 'asc' },
    });
    expect(undone.map((a) => [a.targetUserId, a.data])).toEqual([
      [member.userId, { to: 'pending' }],
      [member.userId, { to: 'approved' }],
    ]);
  });

  it('is active at once when the project does not require approval', async () => {
    const { owner, member, project, put } = await setup();
    await api(app, owner)('PATCH', `/api/projects/${project.id}`, {
      requireParticipantApproval: false,
    });
    const res = await put(member, { participating: true, budgetPercent: 5, mode: 'auto' });
    expect(res.json().status).toBe('active');
    const off = await put(member, { participating: false, budgetPercent: 5, mode: 'auto' });
    expect(off.json().status).toBe('inactive');
  });

  it('approve/reject of an unknown participation is 404', async () => {
    const { owner, project } = await setup();
    const res = await api(app, owner)(
      'POST',
      `/api/projects/${project.id}/participants/nobody/approve`,
    );
    expect(res.statusCode).toBe(404);
  });

  it('caps the sum of active budgets at 100 percent', async () => {
    const a = await setup();
    const b = await ownerWithProject();
    setRole(b.repo, a.member, 'READ');
    expect(
      (await a.put(a.member, { participating: true, budgetPercent: 70, mode: 'auto' })).statusCode,
    ).toBe(200);
    const over = await a.put(
      a.member,
      { participating: true, budgetPercent: 40, mode: 'auto' },
      b.project.id,
    );
    expect(over.statusCode).toBe(409);
    expect(over.json().error.code).toBe('budget_exceeded');
    expect(
      (
        await a.put(
          a.member,
          { participating: true, budgetPercent: 30, mode: 'auto' },
          b.project.id,
        )
      ).statusCode,
    ).toBe(200);
  });

  it('keeps the 100 percent cap under concurrent PUTs on different projects', async () => {
    const a = await setup();
    const others = await Promise.all([ownerWithProject(), ownerWithProject(), ownerWithProject()]);
    for (const o of others) setRole(o.repo, a.member, 'READ');
    const results = await Promise.all(
      [a.project.id, ...others.map((o) => o.project.id)].map((pid) =>
        a.put(a.member, { participating: true, budgetPercent: 60, mode: 'auto' }, pid),
      ),
    );
    expect(results.filter((r) => r.statusCode === 200)).toHaveLength(1);
    expect(results.filter((r) => r.statusCode === 409)).toHaveLength(3);
    const sum = await prisma.participation.aggregate({
      where: { userId: a.member.userId, active: true },
      _sum: { percent: true },
    });
    expect(sum._sum.percent).toBe(60);
  });

  it('refuses users who may not see or join the project', async () => {
    const { put } = await setup();
    const stranger = await loginAs(app, gh);
    expect(
      (await put(stranger, { participating: true, budgetPercent: 5, mode: 'auto' })).statusCode,
    ).toBe(404);
  });

  it('nobody but the member can change their participation (consent rule)', async () => {
    const { owner, member, project, repo, put } = await setup();
    await put(member, { participating: true, budgetPercent: 25, mode: 'approval' });
    const admin = await loginAs(app, gh);
    setRole(repo, admin, 'ADMIN');
    const before = await prisma.participation.findFirstOrThrow({
      where: { userId: member.userId, projectId: project.id },
    });

    // No route accepts a target user on the PUT; the owner and admins only touch their own row.
    for (const actor of [owner, admin]) {
      await api(app, actor)('PUT', `/api/projects/${project.id}/participation`, {
        participating: false,
        budgetPercent: 99,
        mode: 'auto',
        userId: member.userId,
      });
      const res = await api(app, actor)('PUT', `/api/projects/${member.userId}/participation`, {
        participating: false,
        budgetPercent: 99,
        mode: 'auto',
      });
      expect(res.statusCode).toBe(404);
    }
    // Owner decisions only move the approval timestamps.
    await api(app, owner)(
      'POST',
      `/api/projects/${project.id}/participants/${member.userId}/approve`,
    );
    await api(app, owner)(
      'POST',
      `/api/projects/${project.id}/participants/${member.userId}/reject`,
    );
    // A non-owner admin cannot decide at all.
    expect(
      (
        await api(app, admin)(
          'POST',
          `/api/projects/${project.id}/participants/${member.userId}/approve`,
        )
      ).statusCode,
    ).toBe(403);

    const after = await prisma.participation.findFirstOrThrow({
      where: { userId: member.userId, projectId: project.id },
    });
    expect({ a: after.active, p: after.percent, m: after.mode }).toEqual({
      a: before.active,
      p: before.percent,
      m: before.mode,
    });
  });

  it('writes audit rows and the audit log is append-only', async () => {
    const { member, project, put } = await setup();
    await put(member, { participating: true, budgetPercent: 1, mode: 'auto' });
    const row = await prisma.auditLog.findFirstOrThrow({
      where: { projectId: project.id, action: 'participation.updated', actorUserId: member.userId },
    });
    await expect(
      prisma.auditLog.update({ where: { id: row.id }, data: { action: 'x' } }),
    ).rejects.toThrow();
    await expect(prisma.auditLog.delete({ where: { id: row.id } })).rejects.toThrow();
  });
});
