/**
 * v0.5.1: failed-run classes (shut-out counts only task/timeout), Claude login flag, env failures
 * and needsAttention, retry, and "why isn't this running?" (same eligibility code as the dispatcher).
 * Helpers mirror m4.test.ts.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import WebSocket from 'ws';
import {
  EnrollResponseSchema,
  ProjectViewSchema,
  TaskViewSchema,
  WhyNotRunningResponseSchema,
  agentMessage,
  type ServerMessage,
  type TaskView,
} from '@orch/shared';
import { FakeGithub, api, loginAs, makeApp, prisma, repoFor, type TestUser } from './harness';

let gh: FakeGithub;
let app: FastifyInstance;
let wsUrl: string;

beforeAll(async () => {
  gh = new FakeGithub();
  // The dispatcher runs; the interval is long so ticks happen on kicks and explicit tick() calls.
  app = makeApp(gh, { env: { DISPATCHER_ENABLED: 'true', DISPATCHER_INTERVAL_MS: '3600000' } });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  if (!addr || typeof addr === 'string') throw new Error('no address');
  wsUrl = `ws://127.0.0.1:${addr.port}/agent/ws`;
});
afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

async function until(cond: () => Promise<boolean> | boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error('condition not met in time');
}

const settle = async () => {
  await app.dispatcher.settle();
  await new Promise((r) => setTimeout(r, 30)); // let socket frames arrive
  await app.dispatcher.settle();
};
/** Runs a tick at `now + ms` (fake clock for expiries and leases). */
const tickAt = async (ms = 0) => {
  await app.dispatcher.tick(new Date(Date.now() + ms));
  await settle();
};

class Client {
  readonly msgs: ServerMessage[] = [];
  constructor(readonly ws: WebSocket) {
    ws.on('message', (d) => this.msgs.push(JSON.parse(d.toString()) as ServerMessage));
  }
  send(m: unknown) {
    this.ws.send(JSON.stringify(m));
  }
  find<T extends ServerMessage['type']>(
    type: T,
    pred: (m: Extract<ServerMessage, { type: T }>) => boolean = () => true,
  ): Array<Extract<ServerMessage, { type: T }>> {
    return this.msgs.filter(
      (m): m is Extract<ServerMessage, { type: T }> =>
        m.type === type && pred(m as Extract<ServerMessage, { type: T }>),
    );
  }
  async next<T extends ServerMessage['type']>(
    type: T,
    pred: (m: Extract<ServerMessage, { type: T }>) => boolean = () => true,
  ): Promise<Extract<ServerMessage, { type: T }>> {
    let found: Extract<ServerMessage, { type: T }> | undefined;
    await until(() => {
      found = this.find(type, pred)[0];
      return !!found;
    });
    return found!;
  }
  async call(m: { id: string } & Record<string, unknown>) {
    this.send(m);
    return (await this.next('ack', (a) => a.replyTo === m.id)).payload;
  }
}

interface Member {
  user: TestUser;
  agentId: string;
  client: Client;
}

let open: Member[] = [];
afterEach(() => {
  for (const m of open) m.client.ws.close();
  open = [];
});

async function onlineAgent(user: TestUser, maxConcurrent = 1): Promise<Member> {
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
  client.send(
    agentMessage('hello', {
      agentVersion: '0.4.0',
      capabilities: ['auto', 'manual'],
      localPaused: false,
      maxConcurrent,
      running: [],
    }),
  );
  await client.next('welcome');
  await settle();
  const m = { user, agentId: enr.agentId, client };
  open.push(m);
  return m;
}

/** Fresh usage report (ESTIMATE). capacity 1M weighted; `used` attributed to the project. */
async function report(
  m: Member,
  over: { projectId?: string; used?: number; capacity?: number | null; ageMs?: number } = {},
) {
  const now = Date.now();
  await prisma.usageReport.create({
    data: {
      agentId: m.agentId,
      userId: m.user.userId,
      reportedAt: new Date(now - (over.ageMs ?? 0)),
      windowStart: new Date(now - 3600_000),
      windowResetAt: new Date(now + 4 * 3600_000),
      inputTokens: 0n,
      outputTokens: 0n,
      cacheWriteTokens: 0n,
      cacheReadTokens: 0n,
      weightedTokens: BigInt(over.used ?? 0),
      byProject: over.projectId ? { [over.projectId]: over.used ?? 0 } : {},
      byModel: {},
      capacityEstimate:
        over.capacity === null
          ? null
          : BigInt(over.capacity === undefined ? 1_000_000 : over.capacity),
      source: 'jsonl',
    },
  });
}

async function participate(
  u: TestUser,
  projectId: string,
  over: {
    mode?: 'AUTO' | 'APPROVAL';
    percent?: number;
    approvedAt?: Date | null;
    active?: boolean;
  } = {},
) {
  await prisma.participation.create({
    data: {
      userId: u.userId,
      projectId,
      active: over.active ?? true,
      approvedAt: over.approvedAt === undefined ? new Date() : over.approvedAt,
      percent: over.percent ?? 50,
      mode: over.mode ?? 'AUTO',
    },
  });
}

/** Owner + project. Members are added by each test. */
async function project() {
  const owner = await loginAs(app, gh);
  const repo = repoFor();
  gh.repos.set(owner.token, [repo]);
  const p = ProjectViewSchema.parse(
    (await api(app, owner)('POST', '/api/projects', { githubRepoId: repo.githubRepoId })).json(),
  );
  return { owner, repo, project: p };
}

/** A participating member with an online agent and a fresh usage report. */
async function member(
  projectId: string,
  over: Parameters<typeof participate>[2] & { used?: number; capacity?: number } = {},
) {
  const u = await loginAs(app, gh);
  await participate(u, projectId, over);
  const m = await onlineAgent(u);
  await report(m, { projectId, used: over.used, capacity: over.capacity });
  return m;
}

async function createTask(u: TestUser, projectId: string, over: object = {}): Promise<TaskView> {
  const res = await api(app, u)('POST', `/api/projects/${projectId}/tasks`, {
    title: 'Auto thing',
    body: 'Do the auto thing.',
    size: 'S',
    ...over,
  });
  expect(res.statusCode, res.body).toBe(201);
  const t = TaskViewSchema.parse(res.json());
  await settle();
  return t;
}

const autoOffers = (m: Member, taskId?: string) =>
  m.client.find(
    'task.offer',
    (o) => o.payload.kind === 'AUTO_OFFER' && (!taskId || o.payload.task.taskId === taskId),
  );

const auditActions = async (taskId: string) =>
  (await prisma.auditLog.findMany({ where: { taskId }, orderBy: { id: 'asc' } })).map(
    (a) => a.action,
  );

const AUTH_ERROR =
  'claude exited with code 1: Failed to authenticate. API Error: 401 OAuth access token is invalid.';
const ENV_ERROR = 'docker compose failed: env file /some/path/.env not found';

/** Accepts the n-th auto offer of `m` for task `taskId` and finishes it as failed. */
async function failNth(
  m: Member,
  taskId: string,
  n: number,
  error: string,
  extra: Record<string, unknown> = {},
) {
  await until(() => autoOffers(m, taskId).length >= n);
  const o = autoOffers(m, taskId)[n - 1]!;
  const acc = await m.client.call(
    agentMessage('offer.accept', { assignmentId: o.payload.assignmentId, execMode: 'AUTO' }),
  );
  expect(acc.ok).toBe(true);
  const fin = await m.client.call(
    agentMessage('task.finished', {
      assignmentId: o.payload.assignmentId,
      seq: 1,
      outcome: 'failed',
      usage: { weighted: 0, input: 0, output: 0 },
      error,
      ...extra,
    } as never),
  );
  expect(fin.ok).toBe(true);
  await settle();
  return o.payload.assignmentId;
}

/** Seeds closed FAILED runs (2 h ago: past every backoff, inside the 24 h window). */
async function seedFailures(m: Member, taskId: string, classes: string[], ago = 2 * 3600_000) {
  for (const c of classes) {
    await prisma.assignment.create({
      data: {
        taskId,
        userId: m.user.userId,
        agentId: m.agentId,
        kind: 'AUTO_OFFER',
        status: 'FAILED',
        reason: `seeded ${c} failure`,
        failureClass: c,
        offeredAt: new Date(Date.now() - ago),
        finishedAt: new Date(Date.now() - ago),
      },
    });
  }
}

async function why(u: TestUser, taskId: string) {
  const res = await api(app, u)('GET', `/api/tasks/${taskId}/why-not-running`);
  expect(res.statusCode, res.body).toBe(200);
  return WhyNotRunningResponseSchema.parse(res.json());
}

const reasonOf = async (u: TestUser, taskId: string, m: Member) =>
  (await why(u, taskId)).members.find((x) => x.user.id === m.user.userId)!;

/** A TODO task nobody is offered (no member yet), then the member joins. */
async function quietTask() {
  const { owner, project: p, repo } = await project();
  const t = await createTask(owner, p.id);
  return { owner, p, repo, t };
}

describe('shut-out counts only task and timeout failures', () => {
  it('5 rate-limited / env / claude_auth failures do not shut a member out; 5 task+timeout do', async () => {
    const { owner, p, t } = await quietTask();
    const m = await member(p.id);
    await app.dispatcher.withdrawForTask(t.id, 'test');
    await seedFailures(m, t.id, ['rate_limited', 'rate_limited', 'claude_auth', 'env', 'env']);
    await seedFailures(m, t.id, ['task', 'task', 'task', 'timeout']);
    let r = await reasonOf(owner, t.id, m);
    expect(r.reasons.map((x) => x.code)).not.toContain('shut_out');

    await seedFailures(m, t.id, ['timeout']);
    r = await reasonOf(owner, t.id, m);
    expect(r.eligible).toBe(false);
    expect(r.reasons[0]).toMatchObject({ code: 'shut_out' });
    expect(r.reasons[0]!.until).toBeTruthy();
    // the dispatcher agrees: no new offer
    const before = autoOffers(m, t.id).length;
    await tickAt(0);
    expect(autoOffers(m, t.id)).toHaveLength(before);
  });

  it('pre-0.5.1 rows without a class are classified from their stored error', async () => {
    const { owner, p, t } = await quietTask();
    const m = await member(p.id);
    await app.dispatcher.withdrawForTask(t.id, 'test');
    for (let i = 0; i < 5; i++) {
      await prisma.assignment.create({
        data: {
          taskId: t.id,
          userId: m.user.userId,
          agentId: m.agentId,
          kind: 'AUTO_OFFER',
          status: 'FAILED',
          reason: ENV_ERROR,
          finishedAt: new Date(Date.now() - 2 * 3600_000),
        },
      });
    }
    const r = await reasonOf(owner, t.id, m);
    expect(r.reasons.map((x) => x.code)).not.toContain('shut_out');
  });
});

describe('claude_auth failures', () => {
  it('flag the agent, exclude it from auto offers, and clear only on a real claude.auth check', async () => {
    const { owner, project: p } = await project();
    const m = await member(p.id);
    const t = await createTask(owner, p.id);
    const id = await failNth(m, t.id, 1, AUTH_ERROR); // old-agent style: no failureClass
    const a = await prisma.assignment.findUniqueOrThrow({ where: { id } });
    expect(a.failureClass).toBe('claude_auth');
    let agent = await prisma.agent.findUniqueOrThrow({ where: { id: m.agentId } });
    expect(agent.claudeAuthValid).toBe(false);
    expect(await auditActions(t.id)).toContain('agent.claude_auth_invalid');

    await tickAt(2 * 3600_000);
    expect(autoOffers(m, t.id)).toHaveLength(1); // not offered while the login is invalid
    expect((await reasonOf(owner, t.id, m)).reasons[0]).toMatchObject({
      code: 'claude_login_expired',
    });
    const mine = (await api(app, m.user)('GET', '/api/agents/mine')).json() as Array<{
      id: string;
      claudeAuthValid?: boolean;
    }>;
    expect(mine.find((x) => x.id === m.agentId)?.claudeAuthValid).toBe(false);
    const onboarding = (await api(app, m.user)('GET', '/api/onboarding')).json() as {
      steps: Array<{ id: string; state: string; reason?: string }>;
    };
    expect(onboarding.steps.find((s) => s.id === 'claude_connected')).toMatchObject({
      state: 'todo',
      reason: 'claude_login_expired',
    });

    // A usage.report with claudeAuthValid true (a token merely being present) never clears it.
    const rep = agentMessage('usage.report', {
      estimate: true,
      windowStart: new Date(Date.now() - 3600_000).toISOString(),
      windowResetAt: new Date(Date.now() + 4 * 3600_000).toISOString(),
      tokens: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 },
      weighted: 0,
      byModel: {},
      byProject: {},
      capacityEstimate: 1_000_000,
      source: 'jsonl',
      claudeTokenPresent: true,
      claudeAuthValid: true,
    });
    expect((await m.client.call(rep)).ok).toBe(true);
    agent = await prisma.agent.findUniqueOrThrow({ where: { id: m.agentId } });
    expect(agent.claudeAuthValid).toBe(false);
    await tickAt(0);
    await settle();
    expect(autoOffers(m, t.id)).toHaveLength(1); // still no offer

    // Inconclusive checks leave the flag alone.
    const check = (over: Record<string, unknown>) =>
      m.client.call(
        agentMessage('claude.auth', { valid: false, checkedAt: new Date().toISOString(), ...over }),
      );
    expect((await check({ errorClass: 'timeout' })).ok).toBe(true);
    agent = await prisma.agent.findUniqueOrThrow({ where: { id: m.agentId } });
    expect(agent).toMatchObject({ claudeAuthValid: false, claudeAuthError: 'timeout' });
    expect(agent.claudeAuthCheckedAt).not.toBeNull();

    // A definitive 401 keeps the original invalid-since date.
    const since = agent.claudeAuthInvalidAt!.getTime();
    expect((await check({ errorClass: 'unauthorized' })).ok).toBe(true);
    agent = await prisma.agent.findUniqueOrThrow({ where: { id: m.agentId } });
    expect(agent).toMatchObject({ claudeAuthValid: false, claudeAuthError: 'unauthorized' });
    expect(agent.claudeAuthInvalidAt!.getTime()).toBe(since);

    // Only a real check that passed clears it, and the dispatcher offers again.
    expect((await check({ valid: true })).ok).toBe(true);
    agent = await prisma.agent.findUniqueOrThrow({ where: { id: m.agentId } });
    expect(agent).toMatchObject({
      claudeAuthValid: true,
      claudeAuthInvalidAt: null,
      claudeAuthError: null,
    });
    await tickAt(0);
    await until(() => autoOffers(m, t.id).length === 2);
  });

  it('claude.auth unauthorized flags a valid agent; a hello reporting true does not clear it', async () => {
    const { owner, project: p } = await project();
    const m = await member(p.id);
    const checkedAt = new Date().toISOString();
    expect(
      (
        await m.client.call(
          agentMessage('claude.auth', { valid: false, errorClass: 'unauthorized', checkedAt }),
        )
      ).ok,
    ).toBe(true);
    expect(
      (await prisma.agent.findUniqueOrThrow({ where: { id: m.agentId } })).claudeAuthValid,
    ).toBe(false);
    const hello = (claudeAuthValid?: boolean) =>
      m.client.send(
        agentMessage('hello', {
          agentVersion: '0.5.2',
          capabilities: ['auto', 'manual'],
          localPaused: false,
          maxConcurrent: 1,
          running: [],
          claudeTokenPresent: true,
          ...(claudeAuthValid !== undefined && { claudeAuthValid }),
        }),
      );
    hello(true);
    hello(); // old agent: nothing reported
    await settle();
    const agent = await prisma.agent.findUniqueOrThrow({ where: { id: m.agentId } });
    expect(agent.claudeAuthValid).toBe(false);
    const t = await createTask(owner, p.id);
    await settle();
    expect(autoOffers(m, t.id)).toHaveLength(0);
    const mine = (await api(app, m.user)('GET', '/api/agents/mine')).json() as Array<{
      id: string;
      claudeAuthError?: string;
      claudeAuthCheckedAt?: string;
    }>;
    expect(mine.find((x) => x.id === m.agentId)).toMatchObject({
      claudeAuthError: 'unauthorized',
      claudeAuthCheckedAt: checkedAt,
    });
    // Reports of false still set the flag on a valid agent.
    await m.client.call(
      agentMessage('claude.auth', { valid: true, checkedAt: new Date().toISOString() }),
    );
    hello(false);
    await until(
      async () =>
        !(await prisma.agent.findUniqueOrThrow({ where: { id: m.agentId } })).claudeAuthValid,
    );
  });

  it('a claude_auth failure never counts toward the shut-out, and a passing claude.auth check clears the flag', async () => {
    const { owner, project: p } = await project();
    const m = await member(p.id);
    const t = await createTask(owner, p.id);
    await failNth(m, t.id, 1, 'whatever', { failureClass: 'claude_auth' });
    expect(
      (await prisma.agent.findUniqueOrThrow({ where: { id: m.agentId } })).claudeAuthValid,
    ).toBe(false);
    // A succeeded run clears it: here the member's own claude.auth check passes.
    await m.client.call(
      agentMessage('claude.auth', { valid: true, checkedAt: new Date().toISOString() }),
    );
    await tickAt(0);
    await until(() => autoOffers(m, t.id).length === 2);
    const o = autoOffers(m, t.id)[1]!;
    const r = await reasonOf(owner, t.id, m);
    expect(r.reasons.map((x) => x.code)).not.toContain('backoff');
    expect(r.reasons.map((x) => x.code)).not.toContain('shut_out');
    void o;
  });

  it('a local claude_auth refusal by the agent does not shut the member out', async () => {
    const { owner, project: p } = await project();
    const m = await member(p.id);
    const t = await createTask(owner, p.id);
    await until(() => autoOffers(m, t.id).length === 1);
    const o = autoOffers(m, t.id)[0]!;
    await m.client.call(
      agentMessage('offer.reject', {
        assignmentId: o.payload.assignmentId,
        reason: 'error',
        detail: 'claude_auth: Claude login expired: run "orch login"',
      }),
    );
    await settle();
    // The server takes the hint: the agent is flagged and gets no new offer.
    expect(
      (await prisma.agent.findUniqueOrThrow({ where: { id: m.agentId } })).claudeAuthValid,
    ).toBe(false);
    expect(autoOffers(m, t.id)).toHaveLength(1);
    const r = await reasonOf(owner, t.id, m);
    expect(r.reasons.map((x) => x.code)).toEqual(['claude_login_expired']);
  });
});

describe('env failures', () => {
  it('3 env failures mark the task needsAttention; a retry clears it and re-dispatches', async () => {
    const { owner, project: p } = await project();
    const m = await member(p.id);
    const t = await createTask(owner, p.id);
    await failNth(m, t.id, 1, ENV_ERROR);
    expect(
      (await prisma.assignment.findMany({ where: { taskId: t.id, status: 'FAILED' } }))[0]!
        .failureClass,
    ).toBe('env');
    await tickAt(61_000);
    await failNth(m, t.id, 2, ENV_ERROR);
    await tickAt(121_000);
    await failNth(m, t.id, 3, ENV_ERROR);
    const row = await prisma.task.findUniqueOrThrow({ where: { id: t.id } });
    expect(row.needsAttention).toBe(true);
    expect(row.needsAttentionReason).toContain('env file .env not found');
    expect(row.needsAttentionReason).not.toContain('/some/path');
    expect(await auditActions(t.id)).toContain('task.needs_attention');

    // Shown on the card, and why-not-running says so; never dispatched meanwhile.
    const view = TaskViewSchema.parse((await api(app, owner)('GET', `/api/tasks/${t.id}`)).json());
    expect(view).toMatchObject({ needsAttention: true, failedAttempts: 3, canRetry: true });
    expect(view.lastError).toBe('docker compose failed: env file .env not found');
    expect((await why(owner, t.id)).taskReasons.map((x) => x.code)).toContain('needs_attention');
    await tickAt(3 * 3600_000);
    expect(autoOffers(m, t.id)).toHaveLength(3);

    const res = await api(app, owner)('POST', `/api/tasks/${t.id}/retry`);
    expect(res.statusCode, res.body).toBe(200);
    expect(TaskViewSchema.parse(res.json())).toMatchObject({
      needsAttention: false,
      failedAttempts: 0,
    });
    await settle();
    await until(() => autoOffers(m, t.id).length === 4); // re-dispatched at once, no backoff
    expect(await prisma.assignment.count({ where: { taskId: t.id, status: 'FAILED' } })).toBe(3);
  });
});

describe('rate_limited failures', () => {
  it('set rateLimitedUntil on the member and do not count as a failure of the task', async () => {
    const { owner, project: p } = await project();
    const m = await member(p.id);
    const t = await createTask(owner, p.id);
    const until1 = new Date(Date.now() + 2 * 3600_000);
    await failNth(m, t.id, 1, 'rate limited: claude exited with code 1: usage limit reached', {
      rateLimitedUntil: until1.toISOString(),
    });
    const r = await reasonOf(owner, t.id, m);
    expect(r.reasons[0]).toMatchObject({ code: 'rate_limited', until: until1.toISOString() });
  });
});

describe('retry', () => {
  it('owner and creator only (others 403), audited, and failures before it are ignored', async () => {
    const { owner, project: p, repo } = await project();
    const creator = await loginAs(app, gh);
    gh.roles.set(`${repo.installationId}:${repo.fullName}:${creator.login}`, 'WRITE');
    await participate(creator, p.id);
    const t = await createTask(creator, p.id);
    const m = await member(p.id);
    await app.dispatcher.withdrawForTask(t.id, 'test');
    await seedFailures(m, t.id, ['task', 'task', 'task', 'task', 'task']);
    expect((await reasonOf(owner, t.id, m)).reasons[0]?.code).toBe('shut_out');
    const card = TaskViewSchema.parse((await api(app, owner)('GET', `/api/tasks/${t.id}`)).json());
    expect(card.failedAttempts).toBe(5);
    expect(card.lastError).toBe('seeded task failure');

    // another member: may see why, may not retry
    expect((await api(app, m.user)('POST', `/api/tasks/${t.id}/retry`)).statusCode).toBe(403);
    expect(
      TaskViewSchema.parse((await api(app, m.user)('GET', `/api/tasks/${t.id}`)).json()).canRetry,
    ).toBe(false);
    expect((await why(m.user, t.id)).members.length).toBeGreaterThan(0);
    // an outsider sees nothing
    const outsider = await loginAs(app, gh);
    expect((await api(app, outsider)('GET', `/api/tasks/${t.id}/why-not-running`)).statusCode).toBe(
      404,
    );

    expect((await api(app, creator)('POST', `/api/tasks/${t.id}/retry`)).statusCode).toBe(200);
    expect((await api(app, owner)('POST', `/api/tasks/${t.id}/retry`)).statusCode).toBe(200);
    const audits = await prisma.auditLog.findMany({
      where: { taskId: t.id, action: 'task.retried' },
    });
    expect(audits.map((a) => a.actorUserId).sort()).toEqual([creator.userId, owner.userId].sort());
    await settle();
    await until(() => autoOffers(m, t.id).length >= 1);
    expect(await prisma.assignment.count({ where: { taskId: t.id, status: 'FAILED' } })).toBe(5);
  });

  it('refuses a task that is not waiting in To do', async () => {
    const { owner, p, t } = await quietTask();
    void p;
    await prisma.task.update({ where: { id: t.id }, data: { status: 'DONE' } });
    const res = await api(app, owner)('POST', `/api/tasks/${t.id}/retry`);
    expect(res.statusCode).toBe(409);
  });
});

describe('why-not-running', () => {
  it('explains dependencies, offline agents, pauses, budget and missing reports', async () => {
    const { owner, project: p } = await project();
    const dep = await createTask(owner, p.id);
    const t = await createTask(owner, p.id, { dependsOn: [dep.id] });
    expect((await why(owner, t.id)).taskReasons.map((x) => x.code)).toContain('dependencies');

    const offline = await loginAs(app, gh);
    await participate(offline, p.id);
    const paused = await member(p.id);
    await api(app, paused.user)('POST', `/api/agents/${paused.agentId}/pause`);
    const broke = await member(p.id, { used: 990_000 });
    const noReport = await loginAs(app, gh);
    await participate(noReport, p.id);
    await onlineAgent(noReport);
    await settle();

    const w = await why(owner, dep.id);
    const code = (id: string) => w.members.find((x) => x.user.id === id)?.reasons[0]?.code;
    expect(code(offline.userId)).toBe('no_agent_online');
    expect(code(paused.user.userId)).toBe('agents_paused');
    expect(code(broke.user.userId)).toBe('budget_exhausted');
    expect(code(noReport.userId)).toBe('no_usage_report');
  });
});
