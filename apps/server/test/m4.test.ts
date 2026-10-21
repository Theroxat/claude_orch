import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import WebSocket from 'ws';
import {
  EnrollResponseSchema,
  OfferListResponseSchema,
  OfferViewSchema,
  PoolResponseSchema,
  ProjectViewSchema,
  TaskViewSchema,
  agentMessage,
  type ServerMessage,
  type TaskView,
} from '@orch/shared';
import { OfferRefusedError } from '../src/agents/gateway';
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
  type TestUser,
} from './harness';

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

const assignmentsOf = (taskId: string) =>
  prisma.assignment.findMany({ where: { taskId }, orderBy: { createdAt: 'asc' } });

const autoOffers = (m: Member, taskId?: string) =>
  m.client.find(
    'task.offer',
    (o) => o.payload.kind === 'AUTO_OFFER' && (!taskId || o.payload.task.taskId === taskId),
  );

const auditActions = async (taskId: string) =>
  (await prisma.auditLog.findMany({ where: { taskId }, orderBy: { id: 'asc' } })).map(
    (a) => a.action,
  );

async function hook(
  event: string,
  payload: object,
  opts: { delivery?: string; sig?: string | null } = {},
) {
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-github-event': event,
    'x-github-delivery': opts.delivery ?? uid(),
  };
  const sig = opts.sig === undefined ? signBody(TEST_WEBHOOK_SECRET, body) : opts.sig;
  if (sig !== null) headers['x-hub-signature-256'] = sig;
  return app.inject({ method: 'POST', url: '/api/github/webhook', payload: body, headers });
}

// ---------------------------------------------------------------------------

describe('dispatcher: eligibility and ranking', () => {
  it('offers AUTO to the member with the highest margin fraction, with everything claude -p needs', async () => {
    const { owner, project: p } = await project();
    // capacityEstimate is already net of the agent's 20 % reserve: B = 50% of 1M = 500k, 100k left
    const tight = await member(p.id, { used: 400_000 });
    const roomy = await member(p.id, { used: 0 });
    const t = await createTask(owner, p.id, {
      acceptanceCriteria: ['works'],
      integrationBranch: 'feat/x',
    });
    const offer = await roomy.client.next('task.offer', (o) => o.payload.task.taskId === t.id);
    expect(offer.payload).toMatchObject({
      kind: 'AUTO_OFFER',
      execMode: 'AUTO',
      accepted: false,
      timeoutSec: 30 * 60,
      task: {
        taskId: t.id,
        model: 'SONNET',
        size: 'S',
        baseBranch: 'feat/x',
        integrationBranch: 'feat/x',
        branchName: expect.stringMatching(/^orch\/issue-\d+-auto-thing$/),
        prompt: expect.stringContaining('Do the auto thing.'),
      },
    });
    expect(offer.payload.task.prompt).toContain('- works');
    expect(offer.payload.expiresAt).not.toBeNull();
    expect(autoOffers(tight, t.id)).toHaveLength(0);
    const rows = await assignmentsOf(t.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: 'AUTO_OFFER',
      status: 'PENDING',
      userId: roomy.user.userId,
    });
    expect(await auditActions(t.id)).toContain('offer.created');
  });

  it('excludes stale usage from auto offers until a fresh report arrives', async () => {
    const { owner, project: p } = await project();
    const u = await loginAs(app, gh);
    await participate(u, p.id);
    const m = await onlineAgent(u);
    await report(m, { projectId: p.id, ageMs: 20 * 60_000 });
    const t = await createTask(owner, p.id);
    await tickAt();
    expect(await assignmentsOf(t.id)).toHaveLength(0);
    // no report at all is not enough either; a fresh one is
    await report(m, { projectId: p.id });
    await tickAt();
    expect((await assignmentsOf(t.id)).map((a) => a.kind)).toEqual(['AUTO_OFFER']);
  });

  it('excludes members whose project budget is exhausted, and rate-limited members', async () => {
    const { owner, project: p } = await project();
    const spent = await member(p.id, { used: 499_000 }); // budget 500k, an S task needs 4.4k
    const limited = await member(p.id);
    await prisma.usageReport.updateMany({
      where: { userId: limited.user.userId },
      data: { rateLimitedUntil: new Date(Date.now() + 3600_000) },
    });
    const t = await createTask(owner, p.id);
    await tickAt();
    expect(await assignmentsOf(t.id)).toHaveLength(0);
    const ok = await member(p.id, { used: 0 });
    await tickAt();
    const rows = await assignmentsOf(t.id);
    expect(rows.map((r) => r.userId)).toEqual([ok.user.userId]);
    expect(autoOffers(spent)).toHaveLength(0);
    expect(autoOffers(limited)).toHaveLength(0);
  });

  it('excludes paused members; pausing during an offer withdraws it and the next member gets it', async () => {
    const { owner, project: p } = await project();
    const pausedM = await member(p.id);
    await api(app, pausedM.user)('POST', `/api/agents/${pausedM.agentId}/pause`);
    const a = await member(p.id, { used: 0 });
    const b = await member(p.id, { used: 200_000 });
    const t = await createTask(owner, p.id);
    const first = await a.client.next('task.offer', (o) => o.payload.task.taskId === t.id);
    expect(autoOffers(pausedM)).toHaveLength(0);
    // `orch pause` on A while the offer is pending
    expect((await a.client.call(agentMessage('pause.set', { paused: true }))).ok).toBe(true);
    await settle();
    const cancel = await a.client.next(
      'task.cancel',
      (c) => c.payload.assignmentId === first.payload.assignmentId,
    );
    expect(cancel.payload.reason).toBe('paused');
    const row = await prisma.assignment.findUniqueOrThrow({
      where: { id: first.payload.assignmentId },
    });
    expect(row.status).toBe('CANCELLED');
    await tickAt();
    await b.client.next('task.offer', (o) => o.payload.task.taskId === t.id);
    // a late accept from A is refused
    const late = await a.client.call(
      agentMessage('offer.accept', { assignmentId: first.payload.assignmentId, execMode: 'AUTO' }),
    );
    expect(late.ok).toBe(false);
    expect(await auditActions(t.id)).toEqual(
      expect.arrayContaining(['offer.created', 'offer.withdrawn']),
    );
  });

  it('respects maxConcurrent from hello and the model allow-list', async () => {
    const { owner, project: p } = await project();
    const m = await member(p.id);
    await prisma.participation.updateMany({
      where: { userId: m.user.userId },
      data: { allowedModels: ['SONNET'] },
    });
    const opus = await createTask(owner, p.id, { model: 'OPUS', title: 'opus' });
    const t1 = await createTask(owner, p.id, { title: 'one' });
    const t2 = await createTask(owner, p.id, { title: 'two' });
    await tickAt();
    expect(await assignmentsOf(opus.id)).toHaveLength(0);
    const offered = (await prisma.assignment.findMany({ where: { userId: m.user.userId } })).length;
    expect(offered).toBe(1); // one slot: one live auto offer at a time
    expect((await assignmentsOf(t1.id)).length + (await assignmentsOf(t2.id)).length).toBe(1);
  });
});

describe('offers: accept, reject, timeout', () => {
  it('auto offer accepted by the agent runs to a draft PR', async () => {
    const { owner, project: p, repo } = await project();
    const m = await member(p.id);
    const t = await createTask(owner, p.id);
    const offer = await m.client.next('task.offer', (o) => o.payload.task.taskId === t.id);
    const ack = await m.client.call(
      agentMessage('offer.accept', { assignmentId: offer.payload.assignmentId, execMode: 'AUTO' }),
    );
    expect(ack.ok).toBe(true);
    const row = await prisma.task.findUniqueOrThrow({ where: { id: t.id } });
    expect(row).toMatchObject({ status: 'IN_PROGRESS', assigneeAgentId: m.agentId });
    const a = await prisma.assignment.findUniqueOrThrow({
      where: { id: offer.payload.assignmentId },
    });
    expect(a).toMatchObject({ status: 'ACCEPTED', execMode: 'AUTO' });
    expect(a.leaseExpiresAt).not.toBeNull();
    const id = offer.payload.assignmentId;
    expect(
      (
        await m.client.call(
          agentMessage('task.status', { assignmentId: id, seq: 1, state: 'running' }),
        )
      ).ok,
    ).toBe(true);
    const pushed = await m.client.call(
      agentMessage('task.pushed', {
        assignmentId: id,
        seq: 2,
        branch: offer.payload.task.branchName,
        headSha: 'abc123',
        changedFiles: 1,
        summary: 'done',
      }),
    );
    expect(pushed.ok).toBe(true);
    const pr = gh.pullRequests.find((x) => x.fullName === repo.fullName)!;
    expect(pr.draft).toBe(true);
  });

  it('reject moves the offer to the next candidate; timeout too', async () => {
    const { owner, project: p } = await project();
    const a = await member(p.id, { used: 0 });
    const b = await member(p.id, { used: 100_000 });
    const c = await member(p.id, { used: 200_000 });
    const t = await createTask(owner, p.id);
    const o1 = await a.client.next('task.offer', (o) => o.payload.task.taskId === t.id);
    const rej = await a.client.call(
      agentMessage('offer.reject', { assignmentId: o1.payload.assignmentId, reason: 'budget' }),
    );
    expect(rej.ok).toBe(true);
    await settle();
    const o2 = await b.client.next('task.offer', (o) => o.payload.task.taskId === t.id);
    // B never answers: the offer expires after 60 s (fake clock) and C gets it.
    await tickAt(61_000);
    const expired = await prisma.assignment.findUniqueOrThrow({
      where: { id: o2.payload.assignmentId },
    });
    expect(expired.status).toBe('EXPIRED');
    await b.client.next('task.cancel', (x) => x.payload.assignmentId === o2.payload.assignmentId);
    await tickAt();
    await c.client.next('task.offer', (o) => o.payload.task.taskId === t.id);
    // A rejected and B let it expire: neither is asked again today
    expect(autoOffers(a, t.id)).toHaveLength(1);
    expect(autoOffers(b, t.id)).toHaveLength(1);
    expect(await auditActions(t.id)).toEqual(
      expect.arrayContaining(['offer.created', 'offer.rejected', 'offer.expired']),
    );
  });

  it('approval-mode request: listed, accepted on the web, then handed to the agent', async () => {
    const { owner, project: p } = await project();
    const m = await member(p.id, { mode: 'APPROVAL' });
    const t = await createTask(owner, p.id);
    const req = await m.client.next('offer.request', (o) => o.payload.task.taskId === t.id);
    expect(m.client.find('task.offer')).toHaveLength(0);
    const mine = OfferListResponseSchema.parse(
      (await api(app, m.user)('GET', '/api/offers/mine')).json(),
    );
    const view = mine.find((o) => o.id === req.payload.assignmentId)!;
    expect(view).toMatchObject({
      kind: 'CONSENT_REQUEST',
      status: 'PENDING',
      acceptCommand: `orch accept ${view.id}`,
    });
    // nobody else can accept it
    expect((await api(app, owner)('POST', `/api/offers/${view.id}/accept`)).statusCode).toBe(404);
    const res = await api(app, m.user)('POST', `/api/offers/${view.id}/accept`);
    expect(res.statusCode, res.body).toBe(200);
    expect(OfferViewSchema.parse(res.json()).status).toBe('ACCEPTED');
    const handed = await m.client.next('task.offer', (o) => o.payload.assignmentId === view.id);
    expect(handed.payload).toMatchObject({
      kind: 'CONSENT_REQUEST',
      accepted: true,
      execMode: 'AUTO',
    });
    const ack = await m.client.call(
      agentMessage('offer.accept', { assignmentId: view.id, execMode: 'AUTO' }),
    );
    expect(ack.ok).toBe(true);
    expect((await prisma.task.findUniqueOrThrow({ where: { id: t.id } })).status).toBe(
      'IN_PROGRESS',
    );
  });

  it('`orch accept` (offer.accept from the agent) accepts a request; web reject moves on', async () => {
    const { owner, project: p } = await project();
    const a = await member(p.id, { mode: 'APPROVAL', used: 0 });
    const b = await member(p.id, { mode: 'APPROVAL', used: 100_000 });
    const t1 = await createTask(owner, p.id, { title: 'first' });
    const r1 = await a.client.next('offer.request', (o) => o.payload.task.taskId === t1.id);
    expect(
      (await api(app, a.user)('POST', `/api/offers/${r1.payload.assignmentId}/reject`)).statusCode,
    ).toBe(200);
    await settle();
    const r2 = await b.client.next('offer.request', (o) => o.payload.task.taskId === t1.id);
    const ack = await b.client.call(
      agentMessage('offer.accept', { assignmentId: r2.payload.assignmentId, execMode: 'AUTO' }),
    );
    expect(ack.ok).toBe(true);
    await b.client.next('task.offer', (o) => o.payload.assignmentId === r2.payload.assignmentId);
    expect((await prisma.task.findUniqueOrThrow({ where: { id: t1.id } })).assigneeId).toBe(
      b.user.userId,
    );
  });

  it('editing a task withdraws its pending offers: a new dependency cannot be skipped', async () => {
    const { owner, project: p } = await project();
    const m = await member(p.id, { mode: 'APPROVAL' });
    const dep = await createTask(owner, p.id, { title: 'dependency' });
    const t = await createTask(owner, p.id, { title: 'dependent' });
    const req = await m.client.next('offer.request', (o) => o.payload.task.taskId === t.id);
    const patched = await api(app, owner)('PATCH', `/api/tasks/${t.id}`, {
      size: 'M',
      dependsOn: [dep.id],
    });
    expect(patched.statusCode, patched.body).toBe(200);
    expect(TaskViewSchema.parse(patched.json()).status).toBe('BLOCKED');
    await settle();
    expect(
      (await prisma.assignment.findUniqueOrThrow({ where: { id: req.payload.assignmentId } }))
        .status,
    ).toBe('CANCELLED');
    await m.client.next(
      'offer.withdrawn',
      (x) => x.payload.assignmentId === req.payload.assignmentId,
    );
    const res = await api(app, m.user)('POST', `/api/offers/${req.payload.assignmentId}/accept`);
    expect(res.statusCode).not.toBe(200);
    expect((await prisma.task.findUniqueOrThrow({ where: { id: t.id } })).status).toBe('TODO');
  });
});

describe('consent is absolute', () => {
  it('never sends AUTO to approval-mode, non-participating, unapproved, inactive or paused members, even on owner broadcast', async () => {
    const { owner, project: p } = await project();
    await prisma.project.update({
      where: { id: p.id },
      data: { requireParticipantApproval: true },
    });
    const approval = await member(p.id, { mode: 'APPROVAL' });
    const unapproved = await member(p.id, { mode: 'AUTO', approvedAt: null });
    const inactive = await member(p.id, { mode: 'AUTO', active: false });
    const rejected = await member(p.id, { mode: 'AUTO', approvedAt: null });
    await prisma.participation.updateMany({
      where: { userId: rejected.user.userId },
      data: { rejectedAt: new Date() },
    });
    const outsider = await onlineAgent(await loginAs(app, gh));
    await report(outsider);
    const pausedUser = await member(p.id, { mode: 'AUTO' });
    await prisma.user.update({ where: { id: pausedUser.user.userId }, data: { paused: true } });
    // The owner participates in approval mode too: owning the project bypasses nothing.
    await participate(owner, p.id, { mode: 'APPROVAL' });
    const ownerAgent = await onlineAgent(owner);
    await report(ownerAgent, { projectId: p.id });

    const tasks: TaskView[] = [];
    for (let i = 0; i < 4; i++) {
      tasks.push(
        await createTask(owner, p.id, { title: `bc ${i}`, dispatch: { mode: 'broadcast' } }),
      );
      await tickAt(i * 1000);
    }
    // and targeting them explicitly does not help either
    tasks.push(
      await createTask(owner, p.id, {
        title: 'targeted',
        dispatch: { mode: 'members', memberIds: [approval.user.userId, unapproved.user.userId] },
      }),
    );
    await tickAt();

    const nonAuto = [approval, unapproved, inactive, rejected, outsider, pausedUser, ownerAgent];
    for (const m of nonAuto) expect(autoOffers(m)).toHaveLength(0);
    const auto = await prisma.assignment.count({
      where: { taskId: { in: tasks.map((t) => t.id) }, kind: 'AUTO_OFFER' },
    });
    expect(auto).toBe(0);
    // approval-mode members (including the owner) only get requests
    const kinds = await prisma.assignment.findMany({
      where: { taskId: { in: tasks.map((t) => t.id) } },
      select: { kind: true, userId: true },
    });
    expect(new Set(kinds.map((k) => k.kind))).toEqual(new Set(['CONSENT_REQUEST']));
    expect(new Set(kinds.map((k) => k.userId))).toEqual(
      new Set([approval.user.userId, owner.userId]),
    );
    expect(approval.client.find('offer.request').length).toBeGreaterThanOrEqual(tasks.length);

    // An auto offer cannot be forced through the gateway either (second guard).
    const t = await prisma.task.findUniqueOrThrow({
      where: { id: tasks[0]!.id },
      include: { project: true, createdBy: true, targets: true },
    });
    const fake = {
      id: 'forced',
      status: 'PENDING',
      expiresAt: new Date(Date.now() + 60_000),
    } as never;
    for (const m of [approval, unapproved, inactive, rejected, outsider]) {
      await expect(
        app.agentGateway.sendOffer(m.agentId, app.dispatcher.offerPayload(t, fake, 'AUTO_OFFER')),
      ).rejects.toBeInstanceOf(OfferRefusedError);
    }
    // and an un-accepted consent request is never handed over as a runnable offer
    await expect(
      app.agentGateway.sendOffer(
        approval.agentId,
        app.dispatcher.offerPayload(t, fake, 'CONSENT_REQUEST'),
      ),
    ).rejects.toBeInstanceOf(OfferRefusedError);
    for (const m of nonAuto) expect(autoOffers(m)).toHaveLength(0);
  });

  it('the owner cannot change a member mode or accept for them; leaving auto mode withdraws pending auto offers', async () => {
    const { owner, project: p, repo } = await project();
    const m = await member(p.id, { mode: 'AUTO' });
    gh.roles.set(`${repo.installationId}:${repo.fullName}:${m.user.login}`, 'READ');
    const t = await createTask(owner, p.id);
    const offer = await m.client.next('task.offer', (o) => o.payload.task.taskId === t.id);
    // owner tries to flip the member to auto / approve on their behalf: no route edits someone else's participation
    const ownerPut = await api(app, owner)('PUT', `/api/projects/${p.id}/participation`, {
      participating: true,
      budgetPercent: 100,
      mode: 'auto',
    });
    expect(ownerPut.statusCode).toBe(200);
    const mine = await prisma.participation.findUniqueOrThrow({
      where: { userId_projectId: { userId: m.user.userId, projectId: p.id } },
    });
    expect(mine).toMatchObject({ mode: 'AUTO', percent: 50 });
    // the web cannot accept an AUTO offer (only the machine can)
    expect(
      (await api(app, m.user)('POST', `/api/offers/${offer.payload.assignmentId}/accept`))
        .statusCode,
    ).toBe(404);
    expect(
      (await api(app, owner)('POST', `/api/offers/${offer.payload.assignmentId}/accept`))
        .statusCode,
    ).toBe(404);
    // the member switches to approval mode: the pending auto offer is withdrawn
    const put = await api(app, m.user)('PUT', `/api/projects/${p.id}/participation`, {
      participating: true,
      budgetPercent: 50,
      mode: 'approval',
    });
    expect(put.statusCode, put.body).toBe(200);
    await settle();
    await m.client.next(
      'task.cancel',
      (c) => c.payload.assignmentId === offer.payload.assignmentId,
    );
    const ack = await m.client.call(
      agentMessage('offer.accept', { assignmentId: offer.payload.assignmentId, execMode: 'AUTO' }),
    );
    expect(ack.ok).toBe(false);
    expect((await prisma.task.findUniqueOrThrow({ where: { id: t.id } })).status).toBe('TODO');
    // from now on only requests
    await tickAt();
    await m.client.next('offer.request', (o) => o.payload.task.taskId === t.id);
    expect(autoOffers(m, t.id)).toHaveLength(1); // still only the withdrawn one
  });

  it('a member who switched to approval between offer and accept cannot start it', async () => {
    const { owner, project: p } = await project();
    const m = await member(p.id, { mode: 'AUTO' });
    const t = await createTask(owner, p.id);
    const offer = await m.client.next('task.offer', (o) => o.payload.task.taskId === t.id);
    // flip directly in the DB (no hook): the accept-time guard still refuses
    await prisma.participation.updateMany({
      where: { userId: m.user.userId },
      data: { mode: 'APPROVAL' },
    });
    const ack = await m.client.call(
      agentMessage('offer.accept', { assignmentId: offer.payload.assignmentId, execMode: 'AUTO' }),
    );
    expect(ack).toMatchObject({ ok: false, error: { code: 'not_participating' } });
    expect(
      await prisma.assignment.count({
        where: { taskId: t.id, status: { in: ['ACCEPTED', 'RUNNING'] } },
      }),
    ).toBe(0);
  });
});

describe('targeting', () => {
  it('members: only the listed members get it; validation of members and broadcast', async () => {
    const { owner, project: p } = await project();
    const best = await member(p.id, { used: 0 });
    const target = await member(p.id, { used: 300_000 });
    const t = await createTask(owner, p.id, {
      dispatch: { mode: 'members', memberIds: [target.user.userId] },
    });
    expect(t.dispatch).toEqual({ mode: 'members', memberIds: [target.user.userId] });
    await target.client.next('task.offer', (o) => o.payload.task.taskId === t.id);
    expect(autoOffers(best, t.id)).toHaveLength(0);

    const stranger = await loginAs(app, gh);
    const bad = await api(app, owner)('POST', `/api/projects/${p.id}/tasks`, {
      title: 'x',
      dispatch: { mode: 'members', memberIds: [stranger.userId] },
    });
    expect(bad.json()).toMatchObject({ error: { code: 'invalid_member' } });
    // a write collaborator may submit but not broadcast
    const writer = await loginAs(app, gh);
    const repo = await prisma.project.findUniqueOrThrow({
      where: { id: p.id },
      include: { installation: true },
    });
    gh.roles.set(
      `${repo.installation.githubInstallationId}:${repo.fullName}:${writer.login}`,
      'WRITE',
    );
    const bc = await api(app, writer)('POST', `/api/projects/${p.id}/tasks`, {
      title: 'x',
      dispatch: { mode: 'broadcast' },
    });
    expect(bc.statusCode).toBe(403);
  });

  it('broadcast: one auto offer plus requests; N simultaneous accepts, exactly one wins', async () => {
    const { owner, project: p } = await project();
    const autoA = await member(p.id, { mode: 'AUTO', used: 0 });
    const autoB = await member(p.id, { mode: 'AUTO', used: 100_000 });
    const appr = [
      await member(p.id, { mode: 'APPROVAL' }),
      await member(p.id, { mode: 'APPROVAL' }),
      await member(p.id, { mode: 'APPROVAL' }),
    ];
    const t = await createTask(owner, p.id, { dispatch: { mode: 'broadcast' } });
    await tickAt();
    const offer = await autoA.client.next('task.offer', (o) => o.payload.task.taskId === t.id);
    expect(autoOffers(autoB, t.id)).toHaveLength(0); // one execution: one auto offer at a time
    const reqs = await Promise.all(
      appr.map((m) => m.client.next('offer.request', (o) => o.payload.task.taskId === t.id)),
    );
    const pending = await prisma.assignment.findMany({
      where: { taskId: t.id, status: 'PENDING' },
    });
    expect(pending.filter((a) => a.kind === 'AUTO_OFFER')).toHaveLength(1);
    expect(pending.filter((a) => a.kind === 'CONSENT_REQUEST')).toHaveLength(3);

    const results = await Promise.all([
      autoA.client
        .call(
          agentMessage('offer.accept', {
            assignmentId: offer.payload.assignmentId,
            execMode: 'AUTO',
          }),
        )
        .then((a) => a.ok),
      ...appr.map((m, i) =>
        api(app, m.user)('POST', `/api/offers/${reqs[i]!.payload.assignmentId}/accept`).then(
          (r) => r.statusCode === 200,
        ),
      ),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    const live = await prisma.assignment.findMany({
      where: { taskId: t.id, status: { in: ['ACCEPTED', 'RUNNING', 'PUSHED'] } },
    });
    expect(live).toHaveLength(1);
    expect(await prisma.assignment.count({ where: { taskId: t.id, status: 'PENDING' } })).toBe(0);
    await settle();
    // the losers were told
    const winner = live[0]!;
    if (winner.kind !== 'AUTO_OFFER') {
      await autoA.client.next(
        'task.cancel',
        (c) => c.payload.assignmentId === offer.payload.assignmentId,
      );
    }
    for (let i = 0; i < appr.length; i++) {
      if (reqs[i]!.payload.assignmentId === winner.id) continue;
      await appr[i]!.client.next(
        'offer.withdrawn',
        (w) => w.payload.assignmentId === reqs[i]!.payload.assignmentId,
      );
    }
    expect((await prisma.task.findUniqueOrThrow({ where: { id: t.id } })).status).toBe(
      'IN_PROGRESS',
    );
  });
});

describe('leases', () => {
  it('an accepted auto run past its S/M/L timeout is LOST and the task returns to the pool', async () => {
    const { owner, project: p } = await project();
    const m = await member(p.id);
    const t = await createTask(owner, p.id, { size: 'S' });
    const offer = await m.client.next('task.offer', (o) => o.payload.task.taskId === t.id);
    await m.client.call(
      agentMessage('offer.accept', { assignmentId: offer.payload.assignmentId, execMode: 'AUTO' }),
    );
    await tickAt(29 * 60_000);
    expect(
      (await prisma.assignment.findUniqueOrThrow({ where: { id: offer.payload.assignmentId } }))
        .status,
    ).toBe('ACCEPTED');
    await tickAt(46 * 60_000); // 30 min + 15 min grace
    expect(
      (await prisma.assignment.findUniqueOrThrow({ where: { id: offer.payload.assignmentId } }))
        .status,
    ).toBe('LOST');
    expect((await prisma.task.findUniqueOrThrow({ where: { id: t.id } })).status).toBe('TODO');
    await m.client.next(
      'task.cancel',
      (c) => c.payload.assignmentId === offer.payload.assignmentId,
    );
  });
});

describe('github webhooks', () => {
  const repoPayload = (repo: { githubRepoId: number; fullName: string }) => ({
    id: repo.githubRepoId,
    full_name: repo.fullName,
  });

  it('rejects bad or missing signatures and dedupes deliveries', async () => {
    const { repo } = await project();
    const payload = { action: 'ping', repository: repoPayload(repo) };
    expect((await hook('ping', payload, { sig: null })).statusCode).toBe(401);
    expect((await hook('ping', payload, { sig: 'sha256=00' })).statusCode).toBe(401);
    expect(
      (await hook('ping', payload, { sig: signBody('wrong-secret', JSON.stringify(payload)) }))
        .statusCode,
    ).toBe(401);
    const delivery = uid();
    const first = await hook('ping', payload, { delivery });
    expect(first.json()).toEqual({ ok: true, result: 'pong' });
    const again = await hook('ping', payload, { delivery });
    expect(again.json()).toEqual({ ok: true, duplicate: true });
  });

  it('issues: labeled pool by a writer imports, by a reader is refused; closed cancels if not started', async () => {
    const { owner, repo, project: p } = await project();
    const reader = await loginAs(app, gh);
    gh.roles.set(`${repo.installationId}:${repo.fullName}:${reader.login}`, 'READ');
    const issue = (n: number) => ({
      number: n,
      node_id: `I_${n}`,
      html_url: `https://github.com/${repo.fullName}/issues/${n}`,
      title: `Webhook ${n}`,
      body: 'From a webhook',
      labels: [{ name: 'pool' }],
    });
    const labeled = (n: number, sender: TestUser) => ({
      action: 'labeled',
      label: { name: 'pool' },
      issue: issue(n),
      repository: repoPayload(repo),
      sender: { id: sender.id, login: sender.login },
    });
    expect((await hook('issues', labeled(501, reader))).json()).toMatchObject({
      result: 'refused_not_writer',
    });
    expect((await hook('issues', labeled(502, owner))).json()).toMatchObject({
      result: 'imported',
    });
    // A distinct body: byte-identical bodies are dropped as replays, whatever the delivery id.
    expect(
      (await hook('issues', { ...labeled(502, owner), redelivered: true })).json(),
    ).toMatchObject({
      result: 'already_imported',
    });
    const t = await prisma.task.findUniqueOrThrow({
      where: { projectId_githubIssueNumber: { projectId: p.id, githubIssueNumber: 502 } },
    });
    expect(t).toMatchObject({ status: 'TODO', origin: 'LABEL_IMPORT', createdById: owner.userId });

    // a pending offer on it is withdrawn when the issue is closed
    const m = await member(p.id);
    await tickAt();
    const offer = await m.client.next('task.offer', (o) => o.payload.task.taskId === t.id);
    const closed = await hook('issues', {
      action: 'closed',
      issue: issue(502),
      repository: repoPayload(repo),
    });
    expect(closed.json()).toMatchObject({ result: 'cancelled' });
    expect((await prisma.task.findUniqueOrThrow({ where: { id: t.id } })).status).toBe('CANCELLED');
    await m.client.next(
      'task.cancel',
      (c) => c.payload.assignmentId === offer.payload.assignmentId,
    );
    // hidden from the Backlog
    const board = (await api(app, owner)('GET', `/api/projects/${p.id}/tasks`)).json() as Record<
      string,
      TaskView[]
    >;
    expect(
      Object.values(board)
        .flat()
        .some((x) => x?.id === t.id),
    ).toBe(false);

    // a started task is not cancelled by closing the issue
    const started = await createTask(owner, p.id, { title: 'started' });
    await prisma.task.update({ where: { id: started.id }, data: { status: 'IN_PROGRESS' } });
    const r = await hook('issues', {
      action: 'closed',
      issue: issue(started.issueNumber),
      repository: repoPayload(repo),
    });
    expect(r.json()).toMatchObject({ result: 'not_cancelled_started' });
  });

  it('issues: editing the body of a not-started task requires a new approval', async () => {
    const { owner, repo, project: p } = await project();
    const t = await createTask(owner, p.id);
    const r = await hook('issues', {
      action: 'edited',
      changes: { body: { from: 'old' } },
      issue: {
        number: t.issueNumber,
        node_id: 'x',
        html_url: 'u',
        title: t.title,
        body: 'Now do something else',
      },
      repository: repoPayload(repo),
    });
    expect(r.json()).toMatchObject({ result: 'reapproval_required' });
    const row = await prisma.task.findUniqueOrThrow({ where: { id: t.id } });
    expect(row).toMatchObject({ status: 'PROPOSED', bodySnapshot: 'Now do something else' });
  });

  it('PR lifecycle: opened -> IN_REVIEW, closed unmerged -> TODO + cleanup, merged -> DONE + cleanup + dependents unblocked', async () => {
    const { owner, repo, project: p } = await project();
    const a = await member(p.id);
    const base = await createTask(owner, p.id, { title: 'Base' });
    const dep = await createTask(owner, p.id, { title: 'Dependent', dependsOn: [base.id] });
    const offer = await a.client.next('task.offer', (o) => o.payload.task.taskId === base.id);
    expect(await assignmentsOf(dep.id)).toHaveLength(0); // blocked
    await a.client.call(
      agentMessage('offer.accept', { assignmentId: offer.payload.assignmentId, execMode: 'AUTO' }),
    );
    const branch = offer.payload.task.branchName;
    const pr = (n: number, merged = false) => ({
      number: n,
      html_url: `https://github.com/${repo.fullName}/pull/${n}`,
      merged,
      head: { ref: branch, sha: `sha${n}` },
      base: { ref: 'main' },
    });
    // the agent pushed; someone opened the PR by hand on the task branch
    const opened = await hook('pull_request', {
      action: 'opened',
      pull_request: pr(900),
      repository: repoPayload(repo),
    });
    expect(opened.json()).toMatchObject({ result: 'in_review' });
    expect(await prisma.task.findUniqueOrThrow({ where: { id: base.id } })).toMatchObject({
      status: 'IN_REVIEW',
      prNumber: 900,
    });
    // a PR on an unrelated branch is ignored
    const other = await hook('pull_request', {
      action: 'opened',
      pull_request: { ...pr(901), head: { ref: 'feature/x', sha: 's' } },
      repository: repoPayload(repo),
    });
    expect(other.json()).toMatchObject({ result: 'ignored' });

    // closed without merge: back to the pool, the agent cleans up
    const closed = await hook('pull_request', {
      action: 'closed',
      pull_request: pr(900),
      repository: repoPayload(repo),
    });
    expect(closed.json()).toMatchObject({ result: 'returned_to_pool' });
    expect(await prisma.task.findUniqueOrThrow({ where: { id: base.id } })).toMatchObject({
      status: 'TODO',
      prNumber: null,
    });
    const cleanup1 = await a.client.next(
      'cleanup',
      (c) => c.payload.assignmentId === offer.payload.assignmentId,
    );
    a.client.send({ ...agentMessage('ack', { ok: true }), replyTo: cleanup1.id });
    await until(
      async () =>
        !(await prisma.assignment.findUniqueOrThrow({ where: { id: offer.payload.assignmentId } }))
          .cleanupPending,
    );

    // second round: offered again, accepted, PR merged
    await tickAt();
    const offer2 = await a.client.next(
      'task.offer',
      (o) =>
        o.payload.task.taskId === base.id && o.payload.assignmentId !== offer.payload.assignmentId,
    );
    await a.client.call(
      agentMessage('offer.accept', { assignmentId: offer2.payload.assignmentId, execMode: 'AUTO' }),
    );
    await hook('pull_request', {
      action: 'opened',
      pull_request: pr(902),
      repository: repoPayload(repo),
    });
    await prisma.assignment.update({
      where: { id: offer2.payload.assignmentId },
      data: { status: 'PUSHED' },
    });
    const merged = await hook('pull_request', {
      action: 'closed',
      pull_request: pr(902, true),
      repository: repoPayload(repo),
    });
    expect(merged.json()).toMatchObject({ result: 'done' });
    expect((await prisma.task.findUniqueOrThrow({ where: { id: base.id } })).status).toBe('DONE');
    expect(
      (await prisma.assignment.findUniqueOrThrow({ where: { id: offer2.payload.assignmentId } }))
        .status,
    ).toBe('SUCCEEDED');
    await a.client.next('cleanup', (c) => c.payload.assignmentId === offer2.payload.assignmentId);
    // the dependent is unblocked and offered
    await settle();
    await a.client.next('task.offer', (o) => o.payload.task.taskId === dep.id);
    expect(await auditActions(base.id)).toEqual(
      expect.arrayContaining(['task.in_review', 'task.pr_closed', 'task.merged']),
    );
  });

  it('a run that finishes after its PR was merged by hand leaves the task DONE', async () => {
    const { owner, repo, project: p } = await project();
    const a = await member(p.id);
    const t = await createTask(owner, p.id, { title: 'Merged early' });
    const offer = await a.client.next('task.offer', (o) => o.payload.task.taskId === t.id);
    const id = offer.payload.assignmentId;
    await a.client.call(agentMessage('offer.accept', { assignmentId: id, execMode: 'AUTO' }));
    await a.client.call(
      agentMessage('task.status', { assignmentId: id, seq: 1, state: 'running' }),
    );
    // the member opened and merged a PR on the task branch by hand while the run was going
    const pr = (merged: boolean) => ({
      number: 950,
      html_url: `https://github.com/${repo.fullName}/pull/950`,
      merged,
      head: { ref: offer.payload.task.branchName, sha: 'sha950' },
      base: { ref: 'main' },
    });
    await hook('pull_request', {
      action: 'opened',
      pull_request: pr(false),
      repository: repoPayload(repo),
    });
    const merged = await hook('pull_request', {
      action: 'closed',
      pull_request: pr(true),
      repository: repoPayload(repo),
    });
    expect(merged.json()).toMatchObject({ result: 'done' });
    const ack = await a.client.call(
      agentMessage('task.finished', {
        assignmentId: id,
        seq: 2,
        outcome: 'succeeded',
        usage: { weighted: 10, input: 1, output: 1 },
      }),
    );
    expect(ack.ok).toBe(true);
    expect(await prisma.task.findUniqueOrThrow({ where: { id: t.id } })).toMatchObject({
      status: 'DONE',
      prNumber: 950,
    });
  });

  it('installation events update installations and archive removed repositories', async () => {
    const { repo, project: p } = await project();
    const instId = 700_000 + Math.floor(Math.random() * 100_000);
    const created = await hook('installation', {
      action: 'created',
      installation: { id: instId, account: { login: 'neworg', type: 'Organization' } },
    });
    expect(created.json()).toMatchObject({ result: 'installation.upserted' });
    expect(
      await prisma.installation.findUnique({ where: { githubInstallationId: BigInt(instId) } }),
    ).toMatchObject({ accountLogin: 'neworg' });
    await hook('installation', { action: 'suspend', installation: { id: instId } });
    expect(
      (
        await prisma.installation.findUniqueOrThrow({
          where: { githubInstallationId: BigInt(instId) },
        })
      ).suspendedAt,
    ).not.toBeNull();
    await hook('installation', { action: 'unsuspend', installation: { id: instId } });
    expect(
      (
        await prisma.installation.findUniqueOrThrow({
          where: { githubInstallationId: BigInt(instId) },
        })
      ).suspendedAt,
    ).toBeNull();

    const removed = await hook('installation_repositories', {
      action: 'removed',
      installation: { id: repo.installationId },
      repositories_removed: [{ id: repo.githubRepoId, full_name: repo.fullName }],
    });
    expect(removed.statusCode).toBe(200);
    expect(
      (await prisma.project.findUniqueOrThrow({ where: { id: p.id } })).archivedAt,
    ).not.toBeNull();
  });
});

describe('pool endpoint', () => {
  it('lists members with mode per project, estimated margin, reset time and running tasks', async () => {
    const { owner, project: p } = await project();
    const m = await member(p.id, { mode: 'AUTO', used: 100_000, percent: 50 });
    const appr = await member(p.id, { mode: 'APPROVAL', used: 300_000 }); // ranked after m
    const t = await createTask(owner, p.id);
    const offer = await m.client.next('task.offer', (o) => o.payload.task.taskId === t.id);
    await m.client.call(
      agentMessage('offer.accept', { assignmentId: offer.payload.assignmentId, execMode: 'AUTO' }),
    );
    // a stranger sees nothing of this project
    const stranger = await loginAs(app, gh);
    expect((await api(app, stranger)('GET', `/api/pool?projectId=${p.id}`)).statusCode).toBe(404);

    const res = await api(app, owner)('GET', `/api/pool?projectId=${p.id}`);
    expect(res.statusCode, res.body).toBe(200);
    const pool = PoolResponseSchema.parse(res.json());
    expect(pool.estimate).toBe(true);
    const row = pool.members.find((x) => x.userId === m.user.userId)!;
    expect(row).toMatchObject({
      login: m.user.login,
      online: true,
      paused: false,
      usageStale: false,
    });
    expect(row.resetAt).not.toBeNull();
    expect(row.projects[0]).toMatchObject({
      projectId: p.id,
      mode: 'AUTO',
      budgetPercent: 50,
      estimatedBudget: 500_000, // reserve applied once (by the agent), not again here
    });
    // 500k budget - 100k used - the running task's estimate
    expect(row.projects[0]!.estimatedMargin).toBeLessThan(400_000);
    expect(row.projects[0]!.isOwner).toBe(true); // the caller (owner) owns it
    expect(row.runningTasks[0]).toMatchObject({
      projectFullName: p.fullName,
      issueUrl: `https://github.com/${p.fullName}/issues/${t.issueNumber}`,
    });
    expect(pool.projects).toEqual([{ projectId: p.id, fullName: p.fullName, isOwner: true }]);
    expect(row.runningTasks.map((r) => r.taskId)).toEqual([t.id]);
    const a = pool.members.find((x) => x.userId === appr.user.userId)!;
    expect(a.projects[0]!.mode).toBe('APPROVAL');
    // pause is reflected
    await api(app, appr.user)('POST', `/api/agents/${appr.agentId}/pause`);
    const again = PoolResponseSchema.parse(
      (await api(app, owner)('GET', `/api/pool?projectId=${p.id}`)).json(),
    );
    expect(again.members.find((x) => x.userId === appr.user.userId)!.paused).toBe(true);
  });

  it("does not show a member's running tasks of projects the caller cannot see", async () => {
    const { owner, project: p } = await project();
    const m = await member(p.id);
    // m also works on a private project the owner of p has nothing to do with
    const other = await project();
    await participate(m.user, other.project.id);
    await report(m, { projectId: other.project.id });
    const secret = await createTask(other.owner, other.project.id, { title: 'Secret thing' });
    const offer = await m.client.next('task.offer', (o) => o.payload.task.taskId === secret.id);
    await m.client.call(
      agentMessage('offer.accept', { assignmentId: offer.payload.assignmentId, execMode: 'AUTO' }),
    );
    for (const url of ['/api/pool', `/api/pool?projectId=${p.id}`]) {
      const pool = PoolResponseSchema.parse((await api(app, owner)('GET', url)).json());
      const row = pool.members.find((x) => x.userId === m.user.userId)!;
      expect(row.runningTasks).toEqual([]);
    }
    // the other project's owner still sees it
    const theirs = PoolResponseSchema.parse(
      (await api(app, other.owner)('GET', `/api/pool?projectId=${other.project.id}`)).json(),
    );
    expect(
      theirs.members.find((x) => x.userId === m.user.userId)!.runningTasks.map((r) => r.taskId),
    ).toEqual([secret.id]);
  });
});

describe('participation sync (config.update) and not_participating backoff', () => {
  const hasAuto = (projectId: string) => (c: Extract<ServerMessage, { type: 'config.update' }>) =>
    c.payload.participations.some((x) => x.projectId === projectId && x.mode === 'AUTO');

  it('joined (and approved) after the agent connected: config.update, then the AUTO offer is accepted', async () => {
    const { owner, project: p, repo } = await project();
    const u = await loginAs(app, gh);
    gh.roles.set(`${repo.installationId}:${repo.fullName}:${u.login}`, 'READ');
    const m = await onlineAgent(u);
    await report(m, { projectId: p.id });
    expect(m.client.find('welcome')[0]?.payload.participations).toEqual([]);

    const put = await api(app, u)('PUT', `/api/projects/${p.id}/participation`, {
      participating: true,
      budgetPercent: 50,
      mode: 'auto',
    });
    expect(put.statusCode, put.body).toBe(200);
    expect(put.json()).toMatchObject({ status: 'pending' });
    // pending: pushed, but not in the list yet
    await m.client.next('config.update', (c) => c.payload.participations.length === 0);
    const ok = await api(app, owner)(
      'POST',
      `/api/projects/${p.id}/participants/${u.userId}/approve`,
    );
    expect(ok.statusCode, ok.body).toBe(200);
    const upd = await m.client.next('config.update', hasAuto(p.id));
    expect(upd.payload.participations[0]).toMatchObject({ fullName: p.fullName, mode: 'AUTO' });

    const t = await createTask(owner, p.id);
    const o = await m.client.next('task.offer', (x) => x.payload.task.taskId === t.id);
    expect(m.client.msgs.indexOf(upd)).toBeLessThan(m.client.msgs.indexOf(o));
    const ack = await m.client.call(
      agentMessage('offer.accept', { assignmentId: o.payload.assignmentId, execMode: 'AUTO' }),
    );
    expect(ack.ok).toBe(true);
    expect((await prisma.task.findUniqueOrThrow({ where: { id: t.id } })).status).toBe(
      'IN_PROGRESS',
    );
  });

  it('participation removed or no longer approved: config.update drops it; config.request answers', async () => {
    const { owner, project: p, repo } = await project();
    await prisma.project.update({
      where: { id: p.id },
      data: { requireParticipantApproval: false },
    });
    const m = await member(p.id, { approvedAt: null });
    gh.roles.set(`${repo.installationId}:${repo.fullName}:${m.user.login}`, 'READ');
    expect(m.client.find('welcome')[0]?.payload.participations.map((x) => x.projectId)).toEqual([
      p.id,
    ]);

    // the owner turns approval on: the unapproved member drops out
    const patch = await api(app, owner)('PATCH', `/api/projects/${p.id}`, {
      requireParticipantApproval: true,
    });
    expect(patch.statusCode, patch.body).toBe(200);
    await m.client.next('config.update', (c) => c.payload.participations.length === 0);

    // config.request -> config.update with replyTo
    const req = agentMessage('config.request', {});
    m.client.send(req);
    const answer = await m.client.next('config.update', (c) => c.replyTo === req.id);
    expect(answer.payload.participations).toEqual([]);

    // back on, then the member leaves: dropped again
    await api(app, owner)('PATCH', `/api/projects/${p.id}`, { requireParticipantApproval: false });
    const back = await m.client.next('config.update', hasAuto(p.id));
    const leave = await api(app, m.user)('PUT', `/api/projects/${p.id}/participation`, {
      participating: false,
      budgetPercent: 50,
      mode: 'auto',
    });
    expect(leave.statusCode, leave.body).toBe(200);
    await until(() =>
      m.client.msgs
        .slice(m.client.msgs.indexOf(back) + 1)
        .some((x) => x.type === 'config.update' && x.payload.participations.length === 0),
    );
  });

  it('a not_participating rejection is re-offered after an exponential backoff, never at once', async () => {
    const { owner, project: p, repo } = await project();
    const m = await member(p.id);
    gh.roles.set(`${repo.installationId}:${repo.fullName}:${m.user.login}`, 'READ');
    const t = await createTask(owner, p.id);
    const rejectLast = async (n: number) => {
      await until(() => autoOffers(m, t.id).length === n);
      const o = autoOffers(m, t.id)[n - 1]!;
      const before = m.client.find('config.update').length;
      const r = await m.client.call(
        agentMessage('offer.reject', {
          assignmentId: o.payload.assignmentId,
          reason: 'not_participating',
          detail: `No participation in ${p.fullName}`,
        }),
      );
      expect(r.ok).toBe(true);
      // the server resyncs the agent that disagreed
      await until(() => m.client.find('config.update').length > before);
      await settle();
    };
    await rejectLast(1);
    await tickAt();
    await tickAt(30_000);
    expect(autoOffers(m, t.id)).toHaveLength(1); // no immediate re-offer
    await tickAt(61_000);
    await rejectLast(2); // re-offered after 1 min
    await tickAt(61_000);
    expect(autoOffers(m, t.id)).toHaveLength(2); // second backoff is 2 min
    await tickAt(121_000);
    await until(() => autoOffers(m, t.id).length === 3);
    await rejectLast(3);

    // a participation change after the rejection lifts the backoff at once
    const put = await api(app, m.user)('PUT', `/api/projects/${p.id}/participation`, {
      participating: true,
      budgetPercent: 40,
      mode: 'auto',
    });
    expect(put.statusCode, put.body).toBe(200);
    await settle();
    await until(() => autoOffers(m, t.id).length === 4);

    // other rejections still shut the member out for the day
    const last = autoOffers(m, t.id)[3]!;
    await m.client.call(
      agentMessage('offer.reject', { assignmentId: last.payload.assignmentId, reason: 'budget' }),
    );
    await settle();
    await tickAt(10 * 60_000); // past every backoff, usage still fresh
    expect(autoOffers(m, t.id)).toHaveLength(4);
  });

  it('a failed run sends the task back to TODO and it is re-offered after a short backoff', async () => {
    const { owner, project: p, repo } = await project();
    const m = await member(p.id);
    gh.roles.set(`${repo.installationId}:${repo.fullName}:${m.user.login}`, 'READ');
    const t = await createTask(owner, p.id);
    const failOffer = async (n: number) => {
      await until(() => autoOffers(m, t.id).length === n);
      const o = autoOffers(m, t.id)[n - 1]!;
      expect(
        (
          await m.client.call(
            agentMessage('offer.accept', {
              assignmentId: o.payload.assignmentId,
              execMode: 'AUTO',
            }),
          )
        ).ok,
      ).toBe(true);
      const fin = await m.client.call(
        agentMessage('task.finished', {
          assignmentId: o.payload.assignmentId,
          seq: 1,
          outcome: 'failed',
          usage: { weighted: 0, input: 0, output: 0 },
          error: 'docker compose failed (exit 1): env file .env not found',
        }),
      );
      expect(fin.ok).toBe(true);
      expect((await prisma.task.findUniqueOrThrow({ where: { id: t.id } })).status).toBe('TODO');
      await settle();
    };
    await failOffer(1);
    await tickAt(30_000);
    expect(autoOffers(m, t.id)).toHaveLength(1); // no immediate re-offer
    await tickAt(61_000);
    await until(() => autoOffers(m, t.id).length === 2); // re-offered after 1 min, not 24 h
    await failOffer(2);
    await tickAt(61_000);
    expect(autoOffers(m, t.id)).toHaveLength(2); // second backoff is 2 min
    await tickAt(121_000);
    await until(() => autoOffers(m, t.id).length === 3);
  });
});
