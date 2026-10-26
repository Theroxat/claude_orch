/**
 * Repository access re-check on the offer path: on a PRIVATE repository, a member GitHub no longer
 * lets in (former owner or participant) is never a candidate, cannot accept an offer still open,
 * cannot claim or list its tasks from an agent and gets no repository token. The check reads the
 * cached roles once per tick (one query) and asks GitHub at most once per stale (project, member).
 */
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { Dispatcher, dispatchTaskInclude } from '../src/dispatch/dispatcher';
import { configureRepoAccess, getRoleInfo, invalidateRepoAccess } from '../src/projects/service';
import { TaskService } from '../src/tasks/service';
import { FakeGithub, prisma } from './harness';
import {
  captureLog,
  dispatcherConfig,
  dropScenario,
  rng,
  seedScenario,
  type Scenario,
} from './support/dispatch-scenario';

const config = dispatcherConfig({ DISPATCHER_ENABLED: 'true' });
const scenarios: Scenario[] = [];

afterEach(async () => {
  for (const s of scenarios.splice(0)) await dropScenario(prisma, s);
});
afterAll(async () => {
  await prisma.$disconnect();
});

/** One private project, three members (owner, collaborator, removed member), a few tasks. */
async function world(seed: number) {
  const s = await seedScenario(
    prisma,
    rng(seed),
    { projects: 1, members: 3, tasksPerProject: 3, participation: 1 },
    { wild: false },
  );
  scenarios.push(s);
  const projectId = s.projectIds[0]!;
  const project = await prisma.project.update({
    where: { id: projectId },
    data: { isPrivate: true },
    include: { installation: true },
  });
  const ownerId = project.addedById;
  const [collabId, removedId] = s.userIds.filter((id) => id !== ownerId) as [string, string];
  const users = await prisma.user.findMany({ where: { id: { in: s.userIds } } });
  const login = (id: string) => users.find((u) => u.id === id)!.login;
  const gh = new FakeGithub();
  const key = (id: string) =>
    `${Number(project.installation.githubInstallationId)}:${project.fullName}:${login(id)}`;
  gh.roles.set(key(ownerId), 'ADMIN');
  gh.roles.set(key(collabId), 'WRITE');
  // removedId: no role (GitHub answers NONE for a non-collaborator).
  const { log } = captureLog();
  const dispatcher = new Dispatcher({
    prisma,
    config,
    gateway: s.gateway.asGateway(),
    log,
    github: gh,
  });
  const tasks = () =>
    prisma.task.findMany({
      where: { id: { in: s.taskIds }, status: 'TODO' },
      include: dispatchTaskInclude,
      orderBy: { createdAt: 'asc' },
    });
  return { s, gh, key, project, ownerId, collabId, removedId, dispatcher, tasks, users };
}

const reasonOf = (members: Awaited<ReturnType<Dispatcher['evaluateMembers']>>, userId: string) =>
  members.find((m) => m.userId === userId)?.reason?.code ?? 'eligible';

describe('dispatcher: private repository access', () => {
  it('a member GitHub no longer lets in is no candidate; others are', async () => {
    const w = await world(1);
    const list = await w.tasks();
    expect(list.length).toBeGreaterThan(0);
    const snap = await w.dispatcher.snapshot(list, w.s.now);
    const members = await w.dispatcher.evaluateMembers(list[0]!, snap, w.s.now);
    expect(reasonOf(members, w.removedId)).toBe('access_denied');
    expect(reasonOf(members, w.collabId)).toBe('eligible');
    expect(reasonOf(members, w.ownerId)).toBe('eligible');

    // The former owner removed from the repository is cut off too.
    w.gh.roles.delete(w.key(w.ownerId));
    await invalidateRepoAccess(prisma, { projectId: w.project.id, userId: w.ownerId });
    const snap2 = await w.dispatcher.snapshot(list, w.s.now);
    const again = await w.dispatcher.evaluateMembers(list[0]!, snap2, w.s.now);
    expect(reasonOf(again, w.ownerId)).toBe('access_denied');
  });

  it('asks GitHub at most once per stale (project, member) per tick, never per task', async () => {
    const w = await world(2);
    const list = await w.tasks();
    expect(list.length).toBeGreaterThan(1);
    const before = w.gh.roleCalls;
    const snap = await w.dispatcher.snapshot(list, w.s.now);
    for (const t of list) await w.dispatcher.evaluateMembers(t, snap, w.s.now);
    // No cached row yet: one call per member, whatever the number of tasks.
    expect(w.gh.roleCalls - before).toBe(3);
    // Next tick: every role is cached, no GitHub call.
    const snap2 = await w.dispatcher.snapshot(list, w.s.now);
    for (const t of list) await w.dispatcher.evaluateMembers(t, snap2, w.s.now);
    expect(w.gh.roleCalls - before).toBe(3);
  });

  it('a tick makes no offer to the removed member', async () => {
    const w = await world(3);
    const seeded = await prisma.assignment.findMany({ where: { taskId: { in: w.s.taskIds } } });
    await w.dispatcher.tick(w.s.now);
    const offered = await prisma.assignment.findMany({
      where: { taskId: { in: w.s.taskIds }, id: { notIn: seeded.map((a) => a.id) } },
    });
    expect(offered.length).toBeGreaterThan(0);
    expect(offered.filter((a) => a.userId === w.removedId)).toEqual([]);
  });

  it('ALL_MEMBERS policy or an owner override keeps a member without a GitHub role', async () => {
    const w = await world(4);
    await prisma.project.update({
      where: { id: w.project.id },
      data: { participationPolicy: 'ALL_MEMBERS' },
    });
    const list = await w.tasks();
    let members = await w.dispatcher.evaluateMembers(
      list[0]!,
      await w.dispatcher.snapshot(list, w.s.now),
      w.s.now,
    );
    expect(reasonOf(members, w.removedId)).toBe('eligible');
    await prisma.project.update({
      where: { id: w.project.id },
      data: { participationPolicy: 'GITHUB' },
    });
    await getRoleInfo(prisma, w.gh, w.project, { id: w.removedId, login: 'x' });
    await prisma.projectPermission.update({
      where: { projectId_userId: { projectId: w.project.id, userId: w.removedId } },
      data: { canParticipate: true },
    });
    members = await w.dispatcher.evaluateMembers(
      list[0]!,
      await w.dispatcher.snapshot(await w.tasks(), w.s.now),
      w.s.now,
    );
    expect(reasonOf(members, w.removedId)).toBe('eligible');
  });

  it('accept() refuses an offer still open once GitHub denies, and closes it', async () => {
    const w = await world(5);
    const [task] = await w.tasks();
    const a = await prisma.assignment.create({
      data: {
        taskId: task!.id,
        userId: w.removedId,
        kind: 'CONSENT_REQUEST',
        status: 'PENDING',
        offeredAt: w.s.now,
        expiresAt: new Date(Date.now() + 600_000),
      },
    });
    const r = await w.dispatcher.accept(a.id, { userId: w.removedId, via: 'web' });
    expect(r).toMatchObject({ ok: false, code: 'access_denied' });
    const after = await prisma.assignment.findUniqueOrThrow({ where: { id: a.id } });
    expect(after).toMatchObject({ status: 'CANCELLED', reason: 'access_denied' });
    expect((await prisma.task.findUniqueOrThrow({ where: { id: task!.id } })).status).toBe('TODO');
  });
});

describe('agent side: private repository access', () => {
  it('no takeable task, no claim and no repository token for the removed member', async () => {
    const w = await world(6);
    const svc = new TaskService({ prisma, config, github: w.gh });
    const agentOf = async (userId: string) =>
      prisma.agent.findFirstOrThrow({
        where: { userId, revokedAt: null },
        include: { user: true },
      });
    const removed = await agentOf(w.removedId);
    const collab = await agentOf(w.collabId);
    expect((await svc.takeable(removed)).tasks).toEqual([]);
    const listed = (await svc.takeable(collab)).tasks;
    expect(listed.length).toBeGreaterThan(0);

    const target = { projectFullName: w.project.fullName, issueNumber: listed[0]!.issueNumber };
    const refused = await svc.claim(removed, target);
    expect(refused.ack).toMatchObject({ ok: false, error: { code: 'access_denied' } });

    // A run already started: the collaborator is removed meanwhile, then asks for a token.
    const won = await svc.claim(collab, target);
    expect(won.ack.ok).toBe(true);
    w.gh.roles.delete(w.key(w.collabId));
    await invalidateRepoAccess(prisma, { projectId: w.project.id, userId: w.collabId });
    const tok = await svc.mintToken(collab, {
      assignmentId: won.offer!.assignmentId,
      purpose: 'clone',
    });
    expect(tok).toEqual({ ok: false, reason: 'access_denied' });
  });
});

describe('role cache hardening', () => {
  it('a rate-limited 403 is an outage (grace), not a denial', async () => {
    const w = await world(7);
    const who = { id: w.collabId, login: w.users.find((u) => u.id === w.collabId)!.login };
    expect((await getRoleInfo(prisma, w.gh, w.project, who)).role).toBe('WRITE');
    await prisma.projectPermission.updateMany({
      where: { userId: w.collabId },
      data: { syncedAt: new Date(Date.now() - 6 * 60_000) },
    });
    w.gh.failRolesWith = Object.assign(new Error('API rate limit exceeded'), {
      status: 403,
      response: { headers: { 'x-ratelimit-remaining': '0' } },
    });
    expect((await getRoleInfo(prisma, w.gh, w.project, who)).role).toBe('WRITE');
    // Nothing was cached: the row still holds the verified role.
    const row = await prisma.projectPermission.findFirstOrThrow({ where: { userId: w.collabId } });
    expect(row.githubRole).toBe('WRITE');
  });

  it('concurrent checks share one GitHub call', async () => {
    const w = await world(8);
    const who = { id: w.collabId, login: w.users.find((u) => u.id === w.collabId)!.login };
    const before = w.gh.roleCalls;
    const all = await Promise.all(
      Array.from({ length: 5 }, () => getRoleInfo(prisma, w.gh, w.project, who)),
    );
    expect(all.map((i) => i.role)).toEqual(Array(5).fill('WRITE'));
    expect(w.gh.roleCalls - before).toBe(1);
  });

  it('an invalidation during a refresh is not overwritten by the older answer', async () => {
    const w = await world(9);
    const who = { id: w.collabId, login: w.users.find((u) => u.id === w.collabId)!.login };
    await getRoleInfo(prisma, w.gh, w.project, who);
    await prisma.projectPermission.updateMany({
      where: { userId: w.collabId },
      data: { syncedAt: new Date(Date.now() - 6 * 60_000) },
    });
    // GitHub answers WRITE (before the removal) but the webhook lands while it is being asked.
    const real = w.gh.getUserRole.bind(w.gh);
    w.gh.getUserRole = async (...args) => {
      const role = await real(...args);
      await invalidateRepoAccess(prisma, { projectId: w.project.id, userId: w.collabId });
      return role;
    };
    expect((await getRoleInfo(prisma, w.gh, w.project, who)).role).toBe('WRITE');
    w.gh.getUserRole = real;
    const row = await prisma.projectPermission.findFirstOrThrow({ where: { userId: w.collabId } });
    // Still invalidated: the next check asks GitHub again.
    expect(row.syncedAt.getTime()).toBeLessThan(Date.now() - 50 * 365 * 24 * 3600_000);
  });

  it('settings are per app (keyed by its GitHub client)', async () => {
    const w = await world(10);
    const other = new FakeGithub();
    other.roles = w.gh.roles;
    configureRepoAccess(other, { ttlMs: 0 });
    const who = { id: w.collabId, login: w.users.find((u) => u.id === w.collabId)!.login };
    await getRoleInfo(prisma, w.gh, w.project, who);
    const before = w.gh.roleCalls;
    await getRoleInfo(prisma, w.gh, w.project, who); // default TTL: cached
    expect(w.gh.roleCalls).toBe(before);
    await getRoleInfo(prisma, other, w.project, who); // TTL 0 for the other app: asks
    expect(other.roleCalls).toBe(1);
  });
});
