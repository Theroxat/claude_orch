import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import WebSocket from 'ws';
import {
  EnrollResponseSchema,
  ProjectViewSchema,
  TaskBoardSchema,
  TaskViewSchema,
  agentMessage,
  type ServerMessage,
  type TaskView,
} from '@orch/shared';
import { buildIssueBody } from '../src/tasks/meta';
import { FakeGithub, api, loginAs, makeApp, prisma, repoFor, type TestUser } from './harness';

let gh: FakeGithub;
let app: FastifyInstance;
let wsUrl: string;

beforeAll(async () => {
  gh = new FakeGithub();
  app = makeApp(gh);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  if (!addr || typeof addr === 'string') throw new Error('no address');
  wsUrl = `ws://127.0.0.1:${addr.port}/agent/ws`;
});
afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

async function until(cond: () => Promise<boolean> | boolean, ms = 2000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error('condition not met in time');
}

class Client {
  readonly msgs: ServerMessage[] = [];
  constructor(readonly ws: WebSocket) {
    ws.on('message', (d) => this.msgs.push(JSON.parse(d.toString()) as ServerMessage));
  }
  send(m: unknown) {
    this.ws.send(JSON.stringify(m));
  }
  async next<T extends ServerMessage['type']>(
    type: T,
    pred: (m: Extract<ServerMessage, { type: T }>) => boolean = () => true,
  ): Promise<Extract<ServerMessage, { type: T }>> {
    let found: Extract<ServerMessage, { type: T }> | undefined;
    await until(() => {
      found = this.msgs.find(
        (m): m is Extract<ServerMessage, { type: T }> =>
          m.type === type && pred(m as Extract<ServerMessage, { type: T }>),
      );
      return !!found;
    });
    return found!;
  }
  /** Sends a message and returns its ack payload. */
  async call(m: { id: string } & Record<string, unknown>) {
    this.send(m);
    return (await this.next('ack', (a) => a.replyTo === m.id)).payload;
  }
}

interface Member {
  user: TestUser;
  agentId: string;
  client: Client;
  seq: number;
}

async function onlineAgent(user: TestUser): Promise<Member> {
  const tok = (await api(app, user)('POST', '/api/agents/enrollment-tokens')).json() as {
    token: string;
  };
  const enr = EnrollResponseSchema.parse(
    (
      await app.inject({
        method: 'POST',
        url: '/api/agents/enroll',
        payload: { token: tok.token, machineName: 'box', agentVersion: '0.1.0' },
      })
    ).json(),
  );
  const ws = new WebSocket(wsUrl, { headers: { authorization: `Bearer ${enr.credential}` } });
  const client = new Client(ws);
  await new Promise((r) => ws.once('open', r));
  const hello = agentMessage('hello', {
    agentVersion: '0.2.0',
    capabilities: ['manual'],
    localPaused: false,
    maxConcurrent: 1,
    running: [],
  });
  client.send(hello);
  await client.next('welcome');
  return { user, agentId: enr.agentId, client, seq: 0 };
}

const closers: Member[] = [];
afterAll(() => closers.forEach((m) => m.client.ws.close()));

/** Owner + project + one participating member with an online agent. */
async function world(opts: { participate?: boolean } = {}) {
  const owner = await loginAs(app, gh);
  const repo = repoFor();
  gh.repos.set(owner.token, [repo]);
  const project = ProjectViewSchema.parse(
    (await api(app, owner)('POST', '/api/projects', { githubRepoId: repo.githubRepoId })).json(),
  );
  const member = await loginAs(app, gh);
  if (opts.participate !== false) await participate(member, project.id);
  const agent = await onlineAgent(member);
  closers.push(agent);
  return { owner, repo, project, member, agent };
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

async function createTask(u: TestUser, projectId: string, over: object = {}): Promise<TaskView> {
  const res = await api(app, u)('POST', `/api/projects/${projectId}/tasks`, {
    title: 'Add a thing',
    body: 'Please add the thing.',
    acceptanceCriteria: ['it works'],
    ...over,
  });
  expect(res.statusCode, res.body).toBe(201);
  return TaskViewSchema.parse(res.json());
}

const claimMsg = (fullName: string, n: number) =>
  agentMessage('task.claim', { projectFullName: fullName, issueNumber: n });

async function claim(a: Member, fullName: string, n: number) {
  return a.client.call(claimMsg(fullName, n));
}

async function claimed(a: Member, fullName: string, n: number) {
  const ack = await claim(a, fullName, n);
  expect(ack.ok).toBe(true);
  return (await a.client.next('task.offer')).payload;
}

const auditActions = async (taskId: string) =>
  (await prisma.auditLog.findMany({ where: { taskId }, orderBy: { id: 'asc' } })).map(
    (a) => a.action,
  );

describe('create and import', () => {
  it('creates the issue with the pool label and a metadata block, and the task', async () => {
    const { owner, repo, project } = await world();
    const t = await createTask(owner, project.id, { size: 'L', model: 'OPUS' });
    expect(t).toMatchObject({ status: 'TODO', size: 'L', model: 'OPUS', canEdit: true });
    const issue = gh.createdIssues.find((i) => i.fullName === repo.fullName)!;
    expect(issue.labels).toEqual(['pool']);
    expect(issue.body).toContain('<!-- orch:meta');
    expect(issue.body).toContain('- [ ] it works');
    expect(t.issueNumber).toBe(issue.number);
    const row = await prisma.task.findUniqueOrThrow({ where: { id: t.id } });
    expect(row.branchName).toBe(`orch/issue-${issue.number}-add-a-thing`);
    expect(row.bodySnapshot).toBe('Please add the thing.');
    expect(await auditActions(t.id)).toEqual(['task.created']);
  });

  it('imports pool-labeled issues once, with metadata and dependencies', async () => {
    const { owner, repo, project } = await world();
    gh.addIssue(repo.fullName, { number: 1, title: 'Base', body: 'plain issue' });
    gh.addIssue(repo.fullName, {
      number: 2,
      title: 'Second',
      body: buildIssueBody('Do second', {
        v: 1,
        size: 'S',
        model: 'OPUS',
        acceptanceCriteria: ['a1'],
        dependsOn: [1],
        integrationBranch: null,
      }),
    });
    gh.addIssue(repo.fullName, { number: 3, title: 'Unlabeled', labels: ['bug'] });
    const res = await api(app, owner)('POST', `/api/projects/${project.id}/tasks/import`);
    expect(res.statusCode).toBe(200);
    const body = res.json() as { imported: TaskView[]; alreadyImported: number };
    expect(body.imported.map((t) => t.issueNumber)).toEqual([1, 2]);
    const second = body.imported[1]!;
    expect(second).toMatchObject({
      size: 'S',
      model: 'OPUS',
      acceptanceCriteria: ['a1'],
      body: 'Do second',
      origin: 'LABEL_IMPORT',
      status: 'BLOCKED',
    });
    expect(second.dependsOn.map((d) => d.issueNumber)).toEqual([1]);
    const again = (
      await api(app, owner)('POST', `/api/projects/${project.id}/tasks/import`)
    ).json() as { imported: TaskView[]; alreadyImported: number };
    expect(again.imported).toEqual([]);
    expect(again.alreadyImported).toBe(2);
    expect(await auditActions(second.id)).toEqual(['task.imported']);
  });

  it('proposer flow: read users propose, a submitter approves', async () => {
    const { owner, repo, project } = await world();
    const reader = await loginAs(app, gh);
    gh.roles.set(`${repo.installationId}:${repo.fullName}:${reader.login}`, 'READ');
    const t = await createTask(reader, project.id);
    expect(t).toMatchObject({ status: 'PROPOSED', canApprove: false });
    // reader may not approve, nor import
    expect((await api(app, reader)('POST', `/api/tasks/${t.id}/approve`)).statusCode).toBe(403);
    expect(
      (await api(app, reader)('POST', `/api/projects/${project.id}/tasks/import`)).statusCode,
    ).toBe(403);
    // a stranger cannot even see the project
    const stranger = await loginAs(app, gh);
    expect((await api(app, stranger)('GET', `/api/tasks/${t.id}`)).statusCode).toBe(404);
    const ok = await api(app, owner)('POST', `/api/tasks/${t.id}/approve`);
    expect(TaskViewSchema.parse(ok.json()).status).toBe('TODO');
    expect((await api(app, owner)('POST', `/api/tasks/${t.id}/approve`)).statusCode).toBe(409);
    expect(await auditActions(t.id)).toEqual(['task.proposed', 'task.approved']);
  });

  it('enforces the per-creator pending limit', async () => {
    const { owner, project } = await world();
    await prisma.user.update({ where: { id: owner.userId }, data: { maxPendingTasks: 2 } });
    await createTask(owner, project.id);
    await createTask(owner, project.id);
    const res = await api(app, owner)('POST', `/api/projects/${project.id}/tasks`, {
      title: 'third',
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: { code: 'pending_limit' } });
    await prisma.user.update({ where: { id: owner.userId }, data: { maxPendingTasks: 20 } });
  });
});

describe('backlog REST', () => {
  it('lists by status with access info, edits size/model/deps and rejects cycles', async () => {
    const { owner, member, project } = await world();
    const a = await createTask(owner, project.id, { title: 'A' });
    const b = await createTask(owner, project.id, { title: 'B', dependsOn: [a.id] });
    expect(b.status).toBe('BLOCKED');
    const res = await api(app, owner)('GET', `/api/projects/${project.id}/tasks`);
    const board = TaskBoardSchema.parse(res.json());
    expect(board.TODO.map((t) => t.id)).toEqual([a.id]);
    expect(board.BLOCKED.map((t) => t.id)).toEqual([b.id]);
    expect(board.access?.[project.id]).toMatchObject({ myRole: 'owner', canApprove: true });
    const all = TaskBoardSchema.parse((await api(app, owner)('GET', '/api/tasks')).json());
    expect(all.TODO.length).toBeGreaterThanOrEqual(1);

    const patched = await api(app, owner)('PATCH', `/api/tasks/${a.id}`, {
      size: 'L',
      model: 'OPUS',
    });
    expect(TaskViewSchema.parse(patched.json())).toMatchObject({ size: 'L', model: 'OPUS' });
    const cyc = await api(app, owner)('PATCH', `/api/tasks/${a.id}`, { dependsOn: [b.id] });
    expect(cyc.json()).toMatchObject({ error: { code: 'dependency_cycle' } });
    // a participant who is not the creator cannot edit
    expect((await api(app, member)('PATCH', `/api/tasks/${a.id}`, { size: 'S' })).statusCode).toBe(
      403,
    );
    // locked once started
    await prisma.task.update({ where: { id: a.id }, data: { status: 'IN_PROGRESS' } });
    expect((await api(app, owner)('PATCH', `/api/tasks/${a.id}`, { size: 'S' })).statusCode).toBe(
      409,
    );
  });
});

describe('claim', () => {
  it('claims atomically: the winner gets IN_PROGRESS and an offer', async () => {
    const { owner, project, repo, agent, member } = await world();
    const t = await createTask(owner, project.id);
    const offer = await claimed(agent, repo.fullName, t.issueNumber);
    expect(offer).toMatchObject({
      kind: 'CLAIM',
      task: {
        taskId: t.id,
        issueNumber: t.issueNumber,
        baseBranch: 'main',
        branchName: expect.stringMatching(/^orch\/issue-/),
        createdBy: { login: owner.login },
      },
    });
    const row = await prisma.task.findUniqueOrThrow({ where: { id: t.id } });
    expect(row).toMatchObject({
      status: 'IN_PROGRESS',
      assigneeId: member.userId,
      assigneeAgentId: agent.agentId,
    });
    const view = TaskViewSchema.parse((await api(app, owner)('GET', `/api/tasks/${t.id}`)).json());
    expect(view).toMatchObject({ status: 'IN_PROGRESS', assigneeMachineName: 'box' });
    expect(view.assignee?.githubLogin).toBe(member.login);
  });

  it('race: two claimers, exactly one winner', async () => {
    const { owner, project, repo, agent } = await world();
    const other = await loginAs(app, gh);
    await participate(other, project.id);
    const agent2 = await onlineAgent(other);
    closers.push(agent2);
    const t = await createTask(owner, project.id);
    const [r1, r2] = await Promise.all([
      claim(agent, repo.fullName, t.issueNumber),
      claim(agent2, repo.fullName, t.issueNumber),
    ]);
    expect([r1.ok, r2.ok].sort()).toEqual([false, true]);
    const loser = r1.ok ? r2 : r1;
    expect(loser.error?.code).toBe('already_taken');
    expect(await prisma.assignment.count({ where: { taskId: t.id } })).toBe(1);
  });

  it('refuses without consent, when paused, at max concurrency and with unmet dependencies', async () => {
    const { owner, project, repo, agent, member } = await world();
    const t1 = await createTask(owner, project.id, { title: 'one' });
    const t2 = await createTask(owner, project.id, { title: 'two' });
    const dep = await createTask(owner, project.id, { title: 'dep', dependsOn: [t1.id] });

    // not participating (pending approval)
    await prisma.participation.updateMany({
      where: { userId: member.userId },
      data: { approvedAt: null },
    });
    expect((await claim(agent, repo.fullName, t1.issueNumber)).error?.code).toBe(
      'not_participating',
    );
    await prisma.participation.updateMany({
      where: { userId: member.userId },
      data: { approvedAt: new Date() },
    });

    // paused
    await prisma.agent.update({ where: { id: agent.agentId }, data: { paused: true } });
    expect((await claim(agent, repo.fullName, t1.issueNumber)).error?.code).toBe('paused');
    await prisma.agent.update({ where: { id: agent.agentId }, data: { paused: false } });

    // unmet dependencies
    expect((await claim(agent, repo.fullName, dep.issueNumber)).error?.code).toBe(
      'dependencies_unmet',
    );

    // take one, then max concurrency (default 1)
    await claimed(agent, repo.fullName, t1.issueNumber);
    expect((await claim(agent, repo.fullName, t2.issueNumber)).error?.code).toBe('max_concurrency');

    // dependency done -> claimable once concurrency frees up
    await prisma.task.update({ where: { id: t1.id }, data: { status: 'DONE' } });
    await prisma.assignment.updateMany({
      where: { taskId: t1.id },
      data: { status: 'SUCCEEDED' },
    });
    expect((await claim(agent, repo.fullName, dep.issueNumber)).ok).toBe(true);
    expect((await claim(agent, repo.fullName, 9999)).error?.code).toBe('not_found');
  });

  it('refuses proposed tasks and models the member does not allow', async () => {
    const { owner, project, repo, agent, member } = await world();
    const reader = await loginAs(app, gh);
    gh.roles.set(`${repo.installationId}:${repo.fullName}:${reader.login}`, 'READ');
    const proposed = await createTask(reader, project.id);
    expect((await claim(agent, repo.fullName, proposed.issueNumber)).error?.code).toBe(
      'not_approved',
    );
    const opus = await createTask(owner, project.id, { model: 'OPUS' });
    await prisma.participation.updateMany({
      where: { userId: member.userId },
      data: { allowedModels: ['SONNET'] },
    });
    expect((await claim(agent, repo.fullName, opus.issueNumber)).error?.code).toBe(
      'model_not_allowed',
    );
  });

  it('tasks.list returns what the member can take', async () => {
    const { owner, project, repo, agent } = await world();
    const a = await createTask(owner, project.id, { title: 'listed' });
    await createTask(owner, project.id, { title: 'blocked', dependsOn: [a.id] });
    const req = agentMessage('tasks.list.request', { projectFullName: repo.fullName });
    agent.client.send(req);
    const res = await agent.client.next('tasks.list', (m) => m.replyTo === req.id);
    expect(res.payload.tasks.map((t) => t.taskId)).toEqual([a.id]);
    expect(res.payload.tasks[0]).toMatchObject({ projectFullName: repo.fullName, size: 'M' });
  });
});

describe('tokens, PRs and the lifecycle', () => {
  it('mints a token scoped to one repository, only for the assigned agent', async () => {
    const { owner, project, repo, agent } = await world();
    const t = await createTask(owner, project.id);
    const unassigned = agentMessage('token.request', {
      requestId: 'r0',
      assignmentId: 'nope',
      purpose: 'push',
    });
    agent.client.send(unassigned);
    expect(
      (await agent.client.next('token.deny', (m) => m.payload.requestId === 'r0')).payload,
    ).toMatchObject({ reason: 'unknown_assignment' });

    const offer = await claimed(agent, repo.fullName, t.issueNumber);
    const req = agentMessage('token.request', {
      requestId: 'r1',
      assignmentId: offer.assignmentId,
      purpose: 'push',
    });
    agent.client.send(req);
    const grant = await agent.client.next('token.grant', (m) => m.payload.requestId === 'r1');
    const call = gh.tokenCalls.at(-1)!;
    expect(call.scope).toEqual({
      repository: repo.fullName.split('/')[1],
      permissions: { contents: 'write' },
    });
    expect(grant.payload).toMatchObject({
      repository: repo.fullName,
      permissions: { contents: 'write' },
    });
    const clone = agentMessage('token.request', {
      requestId: 'r2',
      assignmentId: offer.assignmentId,
      purpose: 'clone',
    });
    agent.client.send(clone);
    await agent.client.next('token.grant', (m) => m.payload.requestId === 'r2');
    expect(gh.tokenCalls.at(-1)!.scope.permissions).toEqual({ contents: 'read' });

    // another agent cannot use the assignment
    const other = await loginAs(app, gh);
    const agent2 = await onlineAgent(other);
    closers.push(agent2);
    const steal = agentMessage('token.request', {
      requestId: 'r3',
      assignmentId: offer.assignmentId,
      purpose: 'push',
    });
    agent2.client.send(steal);
    expect(
      (await agent2.client.next('token.deny', (m) => m.payload.requestId === 'r3')).payload.reason,
    ).toBe('unknown_assignment');

    // after the task is over, no more tokens
    await prisma.assignment.update({
      where: { id: offer.assignmentId },
      data: { status: 'SUCCEEDED' },
    });
    const late = agentMessage('token.request', {
      requestId: 'r4',
      assignmentId: offer.assignmentId,
      purpose: 'push',
    });
    agent.client.send(late);
    expect(
      (await agent.client.next('token.deny', (m) => m.payload.requestId === 'r4')).payload.reason,
    ).toBe('assignment_not_live');

    const minted = await prisma.auditLog.findMany({
      where: { taskId: t.id, action: 'token.minted' },
    });
    expect(minted).toHaveLength(2);
    expect(JSON.stringify(minted.map((m) => m.data))).not.toContain('ghs_fake');
  });

  async function runToPush(auto: boolean) {
    const w = await world();
    const t = await createTask(w.owner, w.project.id, { title: 'Ship it' });
    const offer = await claimed(w.agent, w.repo.fullName, t.issueNumber);
    if (auto) {
      await prisma.assignment.update({
        where: { id: offer.assignmentId },
        data: { execMode: 'AUTO' },
      });
    }
    const a = w.agent;
    const status = agentMessage('task.status', {
      assignmentId: offer.assignmentId,
      seq: 1,
      state: 'running',
    });
    expect((await a.client.call(status)).ok).toBe(true);
    // replay with a different id but a stale seq is a no-op
    const stale = agentMessage('task.status', {
      assignmentId: offer.assignmentId,
      seq: 1,
      state: 'running',
    });
    expect((await a.client.call(stale)).duplicate).toBe(true);
    const wrong = agentMessage('task.pushed', {
      assignmentId: offer.assignmentId,
      seq: 2,
      branch: 'evil',
      headSha: 'abc',
      changedFiles: 1,
      summary: 's',
    });
    expect((await a.client.call(wrong)).error?.code).toBe('branch_mismatch');
    const pushed = agentMessage('task.pushed', {
      assignmentId: offer.assignmentId,
      seq: 2,
      branch: offer.task.branchName,
      headSha: 'abcdef1234567890',
      changedFiles: 3,
      summary: 'Did the thing',
    });
    expect((await a.client.call(pushed)).ok).toBe(true);
    const opened = await a.client.next('pr.opened');
    return { ...w, t, offer, opened };
  }

  it('manual mode opens a ready-for-review PR with Closes #n and finishes', async () => {
    const { t, offer, opened, agent, repo } = await runToPush(false);
    const pr = gh.pullRequests.find((p) => p.fullName === repo.fullName)!;
    expect(pr).toMatchObject({
      draft: false,
      head: offer.task.branchName,
      base: 'main',
      title: 'Ship it',
    });
    expect(pr.body).toContain(`Closes #${t.issueNumber}`);
    expect(pr.body).toContain('- [ ] it works');
    expect(opened.payload).toMatchObject({ assignmentId: offer.assignmentId, prNumber: pr.number });
    const row = await prisma.task.findUniqueOrThrow({ where: { id: t.id } });
    expect(row).toMatchObject({
      status: 'IN_REVIEW',
      prNumber: pr.number,
      headSha: 'abcdef1234567890',
    });

    const done = agentMessage('done.request', { assignmentId: offer.assignmentId });
    expect((await agent.client.call(done)).ok).toBe(true);
    const fin = agentMessage('task.finished', {
      assignmentId: offer.assignmentId,
      seq: 3,
      outcome: 'succeeded',
      usage: { weighted: 10, input: 1, output: 2 },
    });
    expect((await agent.client.call(fin)).ok).toBe(true);
    const a = await prisma.assignment.findUniqueOrThrow({ where: { id: offer.assignmentId } });
    expect(a.status).toBe('SUCCEEDED');
    expect((await prisma.task.findUniqueOrThrow({ where: { id: t.id } })).status).toBe('IN_REVIEW');
    expect(await auditActions(t.id)).toEqual([
      'task.created',
      'task.claimed',
      'task.started',
      'task.status',
      'task.pushed',
      'task.pr_opened',
      'task.done_requested',
      'task.finished',
    ]);
  });

  it('auto mode opens a draft PR', async () => {
    const { repo } = await runToPush(true);
    const pr = gh.pullRequests.filter((p) => p.fullName === repo.fullName);
    expect(pr).toHaveLength(1);
    expect(pr[0]!.draft).toBe(true);
  });

  it('a failed run returns the task to the pool', async () => {
    const { owner, project, repo, agent } = await world();
    const t = await createTask(owner, project.id);
    const offer = await claimed(agent, repo.fullName, t.issueNumber);
    const fin = agentMessage('task.finished', {
      assignmentId: offer.assignmentId,
      seq: 1,
      outcome: 'failed',
      usage: { weighted: 0, input: 0, output: 0 },
      error: 'boom',
    });
    expect((await agent.client.call(fin)).ok).toBe(true);
    const row = await prisma.task.findUniqueOrThrow({ where: { id: t.id } });
    expect(row).toMatchObject({ status: 'TODO', assigneeId: null, assigneeAgentId: null });
    expect(await auditActions(t.id)).toContain('task.finished');
    // and can be claimed again
    expect((await claim(agent, repo.fullName, t.issueNumber)).ok).toBe(true);
  });
});
