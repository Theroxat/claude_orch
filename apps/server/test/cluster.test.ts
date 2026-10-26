/**
 * Two server instances in one process, one database, one cluster: leader election, agent
 * messages relayed to the instance holding the socket, live logs across instances, the durable
 * notification queue, and failover.
 */
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import {
  EnrollResponseSchema,
  ProjectViewSchema,
  TaskViewSchema,
  agentMessage,
  serverMessage,
  type ServerMessage,
  type TaskView,
} from '@orch/shared';
import pg from 'pg';
import { encrypt } from '../src/auth/crypto';
import { channelOf, lockClassOf } from '../src/cluster';
import { SharedCounter, SharedRateLimiter } from '../src/http/shared-limit';
import { LiveLogStore } from '../src/logs/store';
import type { PostResult } from '../src/notifications/ssrf';
import { FakeGithub, api, loginAs, makeApp, prisma, repoFor, uid, type TestUser } from './harness';

const KEY = randomBytes(32).toString('base64');
const CLUSTER = `c${uid()}`.slice(0, 40);
const gh = new FakeGithub();
const posted: Array<{ via: string; body: { id?: string } }> = [];
const poster = (via: string) =>
  vi.fn(async (_url: string, body: unknown): Promise<PostResult> => {
    posted.push({ via, body: body as { id?: string } });
    return { ok: true, status: 200 };
  });

function instance(
  id: string,
  cluster = CLUSTER,
  env: Record<string, string> = {},
): FastifyInstance {
  return makeApp(gh, {
    env: {
      ORCH_ENCRYPTION_KEY: KEY,
      ORCH_CLUSTER_NAME: cluster,
      ORCH_INSTANCE_ID: `${cluster}-${id}`,
      ORCH_LEADER_RETRY_MS: '100',
      ORCH_INSTANCE_HEARTBEAT_MS: '300',
      DISPATCHER_ENABLED: 'true',
      DISPATCHER_INTERVAL_MS: '3600000',
      NOTIFY_QUEUE_POLL_MS: '50',
      ...env,
    },
    notify: { post: poster(id) },
  });
}

let a: FastifyInstance;
let b: FastifyInstance;
const hostOf = (app: FastifyInstance) => `127.0.0.1:${(app.server.address() as AddressInfo).port}`;

async function until(cond: () => Promise<boolean> | boolean, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('condition not met in time');
}

beforeAll(async () => {
  a = instance('a');
  await a.listen({ port: 0, host: '127.0.0.1' });
  b = instance('b');
  await b.listen({ port: 0, host: '127.0.0.1' });
  await until(() => a.cluster.hasPeers() && b.cluster.hasPeers());
});

const sockets: WebSocket[] = [];
afterAll(async () => {
  for (const s of sockets) s.close();
  await a?.close();
  await b?.close();
  await prisma.$disconnect();
});

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
  async call(m: { id: string } & Record<string, unknown>) {
    this.send(m);
    return (await this.next('ack', (x) => x.replyTo === m.id)).payload;
  }
}

/** Enrolls a machine through `via`, connects its socket to `on`, says hello. */
async function onlineAgent(user: TestUser, via: FastifyInstance, on: FastifyInstance) {
  const tok = (await api(via, user)('POST', '/api/agents/enrollment-tokens')).json() as {
    token: string;
  };
  const enr = EnrollResponseSchema.parse(
    (
      await via.inject({
        method: 'POST',
        url: '/api/agents/enroll',
        payload: { token: tok.token, machineName: 'box', agentVersion: '0.9.0' },
      })
    ).json(),
  );
  const ws = new WebSocket(`ws://${hostOf(on)}/agent/ws`, {
    headers: { authorization: `Bearer ${enr.credential}` },
  });
  sockets.push(ws);
  const client = new Client(ws);
  await new Promise((r) => ws.once('open', r));
  client.send(
    agentMessage('hello', {
      agentVersion: '0.9.0',
      capabilities: ['auto', 'manual'],
      localPaused: false,
      maxConcurrent: 1,
      running: [],
    }),
  );
  await client.next('welcome');
  return { agentId: enr.agentId, credential: enr.credential, client, ws };
}

/** Opens a second socket for an already enrolled agent on `on` and says hello. */
async function reconnect(credential: string, on: FastifyInstance) {
  const ws = new WebSocket(`ws://${hostOf(on)}/agent/ws`, {
    headers: { authorization: `Bearer ${credential}` },
  });
  sockets.push(ws);
  const client = new Client(ws);
  await new Promise((r) => ws.once('open', r));
  client.send(
    agentMessage('hello', {
      agentVersion: '0.9.0',
      capabilities: ['auto', 'manual'],
      localPaused: false,
      maxConcurrent: 1,
      running: [],
    }),
  );
  await client.next('welcome');
  return { client, ws };
}

/** Opens the SSE stream of a task on one instance and collects the line texts. */
async function openStream(app: FastifyInstance, user: TestUser, taskId: string) {
  const ctl = new AbortController();
  const res = await fetch(`http://${hostOf(app)}/api/tasks/${taskId}/logs/stream`, {
    headers: { cookie: user.cookie },
    signal: ctl.signal,
  });
  const texts: string[] = [];
  const events: string[] = [];
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = '';
  void (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buf += dec.decode(value, { stream: true });
        let i: number;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const name = /^event: (.+)$/m.exec(block)?.[1];
          const data = /^data: (.+)$/m.exec(block)?.[1];
          if (!name || !data) continue;
          events.push(name);
          if (name === 'lines') {
            for (const l of (JSON.parse(data) as { lines: Array<{ text: string }> }).lines) {
              texts.push(l.text);
            }
          }
        }
      }
    } catch {
      // aborted
    }
  })();
  return { res, texts, events, close: () => ctl.abort() };
}

describe('two instances, one database', () => {
  it('runs the dispatcher and the maintenance jobs on exactly one instance', async () => {
    expect(a.dispatcher.isLeader).toBe(true);
    expect(b.dispatcher.isLeader).toBe(false);
    expect([a.cluster.leads('maintenance'), b.cluster.leads('maintenance')]).toEqual([true, false]);

    // A kick on the follower runs a tick on the leader, never on the follower.
    const ticksA = vi.spyOn(a.dispatcher as unknown as { runTick: () => Promise<void> }, 'runTick');
    const ticksB = vi.spyOn(b.dispatcher as unknown as { runTick: () => Promise<void> }, 'runTick');
    b.dispatcher.kick();
    await until(() => ticksA.mock.calls.length > 0);
    await b.dispatcher.settle();
    expect(ticksB).not.toHaveBeenCalled();
    ticksA.mockRestore();
    ticksB.mockRestore();
  });

  let owner: TestUser;
  let member: TestUser;
  let task: TaskView;
  let agent: Awaited<ReturnType<typeof onlineAgent>>;
  let assignmentId: string;

  it('delivers an offer made on instance A to an agent connected to instance B', async () => {
    owner = await loginAs(a, gh);
    const repo = repoFor({ private: true });
    gh.repos.set(owner.token, [repo]);
    const p = ProjectViewSchema.parse(
      (await api(a, owner)('POST', '/api/projects', { githubRepoId: repo.githubRepoId })).json(),
    );
    member = await loginAs(a, gh);
    // A participant of a private repository needs a GitHub role on it to be offered its tasks.
    gh.roles.set(`${repo.installationId}:${repo.fullName}:${member.login}`, 'READ');
    await prisma.participation.create({
      data: {
        userId: member.userId,
        projectId: p.id,
        active: true,
        approvedAt: new Date(),
        percent: 50,
        mode: 'AUTO',
      },
    });
    agent = await onlineAgent(member, a, b);
    // A learns from B where the agent is.
    await until(() => a.agentGateway.isConnected(agent.agentId));
    const now = Date.now();
    await prisma.usageReport.create({
      data: {
        agentId: agent.agentId,
        userId: member.userId,
        reportedAt: new Date(now),
        windowStart: new Date(now - 3600_000),
        windowResetAt: new Date(now + 4 * 3600_000),
        inputTokens: 0n,
        outputTokens: 0n,
        cacheWriteTokens: 0n,
        cacheReadTokens: 0n,
        weightedTokens: 0n,
        byProject: {},
        byModel: {},
        capacityEstimate: 1_000_000n,
        source: 'jsonl',
      },
    });
    // Created through B: the kick goes to the leader (A), whose tick offers the task to the agent
    // whose socket is on B.
    const res = await api(b, owner)('POST', `/api/projects/${p.id}/tasks`, {
      title: 'Across instances',
      body: 'Run me from the other side.',
      size: 'S',
    });
    expect(res.statusCode, res.body).toBe(201);
    task = TaskViewSchema.parse(res.json());
    const offer = await agent.client.next('task.offer', (o) => o.payload.task.taskId === task.id);
    assignmentId = offer.payload.assignmentId;
    const row = await prisma.assignment.findUniqueOrThrow({ where: { id: assignmentId } });
    expect(row).toMatchObject({ status: 'PENDING', kind: 'AUTO_OFFER', agentId: agent.agentId });

    const ack = await agent.client.call(
      agentMessage('offer.accept', { assignmentId, execMode: 'AUTO' }),
    );
    expect(ack.ok).toBe(true);

    // Any message from A (a cancel, a config push) reaches the socket on B as well.
    expect(
      a.agentGateway.sendTo(
        agent.agentId,
        serverMessage('task.cancel', { assignmentId: 'asg_probe', reason: 'probe' }),
      ),
    ).toBe(true);
    await agent.client.next('task.cancel', (m) => m.payload.assignmentId === 'asg_probe');
    expect(await a.agentGateway.pushConfig(agent.agentId)).toBe(true);
    await agent.client.next('config.update', (m) => m.replyTo === undefined);
  });

  it('streams live output received on B to an SSE client on A', async () => {
    const entry = (text: string) => ({ ts: Date.now(), kind: 'text' as const, text });
    agent.client.send(
      agentMessage('task.log', { assignmentId, chunk: 1, entries: [entry('before the stream')] }),
    );
    await until(() => b.liveLogs.snapshot(task.id).lines.length === 1);

    const s = await openStream(a, owner, task.id);
    expect(s.res.status).toBe(200);
    // The backlog comes from B's buffer...
    await until(() => s.texts.length === 1);
    expect(s.texts).toEqual(['before the stream']);
    // ...then new output as B receives it.
    agent.client.send(
      agentMessage('task.log', {
        assignmentId,
        chunk: 2,
        entries: [entry('live 1'), entry('live 2')],
      }),
    );
    await until(() => s.texts.length === 3);
    expect(s.texts).toEqual(['before the stream', 'live 1', 'live 2']);
    s.close();
  });

  it('delivers each queued notification exactly once with two workers', async () => {
    const user = await loginAs(a, gh);
    await prisma.notificationSettings.create({
      data: {
        userId: user.userId,
        webhookUrlEnc: encrypt('https://hooks.example.com/orch', KEY),
        webhookHint: 'hooks.example.com',
      },
    });
    posted.length = 0;
    const N = 40;
    const old = new Date(Date.now() - 5 * 60_000); // due long ago: either instance may take it
    await prisma.notificationJob.createMany({
      data: Array.from({ length: N }, (_, i) => ({
        userId: user.userId,
        channel: 'webhook',
        payload: {
          id: `job-${i}`,
          event: 'task_done',
          title: `Job ${i}`,
          body: 'body',
          url: null,
          link: null,
          projectId: null,
          taskId: null,
          createdAt: new Date().toISOString(),
        },
        nextAttemptAt: old,
        instanceId: 'gone-instance',
      })),
    });
    // Both workers race for the same rows.
    const wake = (app: FastifyInstance) => (app.notifier as unknown as { wake(): void }).wake();
    wake(a);
    wake(b);
    await until(
      async () => (await prisma.notificationJob.count({ where: { userId: user.userId } })) === 0,
    );
    const ids = posted.map((p) => p.body.id);
    expect(ids).toHaveLength(N);
    expect(new Set(ids).size).toBe(N);
  });

  it('counts the abuse-sensitive rate limits once for the whole deployment', async () => {
    const limiterOf = (app: FastifyInstance) =>
      new SharedRateLimiter(new SharedCounter(prisma, CLUSTER, app.log), 'probe', 3, 60_000);
    const onA = limiterOf(a);
    const onB = limiterOf(b);
    const key = `k-${uid()}`;
    expect([await onA.allow(key), await onB.allow(key), await onA.allow(key)]).toEqual([
      true,
      true,
      true,
    ]);
    expect(await onB.allow(key)).toBe(false);
    expect(await onA.allow(key)).toBe(false);
    // Another key, or another cluster on the same database, has its own budget.
    expect(await onA.allow(`${key}-other`)).toBe(true);
    const elsewhere = new SharedRateLimiter(
      new SharedCounter(prisma, 'x', a.log),
      'probe',
      3,
      60_000,
    );
    expect(await elsewhere.allow(key)).toBe(true);

    // The HTTP `auth` tier goes through the same table (one bucket per client IP), the `api`
    // tier stays in memory.
    await a.inject({ method: 'GET', url: '/api/auth/github/login' });
    await b.inject({ method: 'GET', url: '/api/auth/github/login' });
    await b.inject({ method: 'GET', url: '/api/me' });
    const buckets = await prisma.rateLimitBucket.findMany({
      where: { key: { startsWith: `${CLUSTER}:` } },
    });
    const auth = buckets.filter((r) => r.key.startsWith(`${CLUSTER}:auth:`));
    expect(auth).toHaveLength(1);
    expect(auth[0]!.count).toBeGreaterThanOrEqual(2);
    expect(buckets.some((r) => r.key.startsWith(`${CLUSTER}:api:`))).toBe(false);
  });

  it('fails the dispatcher over when the leader loses its database connection', async () => {
    const [row] = await a.cluster.link.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
    const pid = row!.pid;
    await prisma.$queryRaw`SELECT pg_terminate_backend(${pid}::int)`;
    await until(() => b.dispatcher.isLeader && !a.dispatcher.isLeader);
    expect(b.cluster.leads('maintenance')).toBe(true);
    // A reconnects and stays a follower: its kicks now run on B.
    await until(() => a.cluster.link.up);
    expect(a.dispatcher.isLeader).toBe(false);
    const ticksB = vi.spyOn(b.dispatcher as unknown as { runTick: () => Promise<void> }, 'runTick');
    a.dispatcher.kick();
    await until(() => ticksB.mock.calls.length > 0);
    ticksB.mockRestore();
  });

  it('takes over when the leader shuts down, and forgets its agents', async () => {
    expect(a.agentGateway.isConnected(agent.agentId)).toBe(true);
    await b.close();
    await until(() => a.dispatcher.isLeader && a.cluster.leads('maintenance'));
    await until(() => !a.agentGateway.isConnected(agent.agentId));
    expect(await prisma.agentConnection.count({ where: { agentId: agent.agentId } })).toBe(0);
  });
});

describe('two instances: hardening', () => {
  // Their own cluster: the suite above shut its instances down. The periodic leader check is slow
  // here, so only the fencing check can notice a lost lock in time.
  const C2 = `h${uid()}`.slice(0, 40);
  let c: FastifyInstance;
  let d: FastifyInstance;
  let user: TestUser;
  let agent: Awaited<ReturnType<typeof onlineAgent>>;

  beforeAll(async () => {
    c = instance('c', C2, { ORCH_LEADER_RETRY_MS: '60000' });
    await c.listen({ port: 0, host: '127.0.0.1' });
    d = instance('d', C2, { ORCH_LEADER_RETRY_MS: '60000' });
    await d.listen({ port: 0, host: '127.0.0.1' });
    await until(() => c.cluster.hasPeers() && d.cluster.hasPeers());
    user = await loginAs(c, gh);
    agent = await onlineAgent(user, c, d);
    await until(() => c.agentGateway.isConnected(agent.agentId));
  });
  afterAll(async () => {
    await c?.close();
    await d?.close();
  });

  it('drops forged, malformed and replayed messages on the cluster channel', async () => {
    const url = process.env.DATABASE_URL_TEST!;
    const spy = new pg.Client({ connectionString: url });
    await spy.connect();
    const seen: string[] = [];
    spy.on('notification', (n) => seen.push(n.payload ?? ''));
    await spy.query(`LISTEN ${channelOf(C2)}`);
    try {
      const channel = channelOf(C2);
      const forged = JSON.stringify({
        f: `${C2}-c`,
        t: `${C2}-d`,
        k: 'agent.disconnect',
        d: { agentId: agent.agentId, code: 4000, reason: 'forged' },
        ts: Date.now(),
      });
      // Any database role may NOTIFY: none of this may crash an instance or reach the agent.
      for (const payload of ['null', '1', '"x"', '{}', forged, '1AAAA', `1${'A'.repeat(80)}`]) {
        await prisma.$executeRaw`SELECT pg_notify(${channel}, ${payload})`;
      }
      // A genuine relayed message, captured by the spy...
      const probe = serverMessage('task.cancel', { assignmentId: 'asg_secret_probe', reason: 'p' });
      expect(c.agentGateway.sendTo(agent.agentId, probe)).toBe(true);
      await agent.client.next('task.cancel', (m) => m.payload.assignmentId === 'asg_secret_probe');
      await until(() => seen.some((p) => p.startsWith('1') && p.length > 100));
      // ...is unreadable without the cluster key...
      expect(seen.join('\n')).not.toContain('asg_secret_probe');
      // ...and replaying it does nothing.
      for (const payload of [...seen]) {
        await prisma.$executeRaw`SELECT pg_notify(${channel}, ${payload})`;
      }
      await new Promise((r) => setTimeout(r, 400));
      const probes = agent.client.msgs.filter(
        (m) => m.type === 'task.cancel' && m.payload.assignmentId === 'asg_secret_probe',
      );
      expect(probes).toHaveLength(1);
      expect(agent.ws.readyState).toBe(WebSocket.OPEN);
      expect(d.agentGateway.isConnected(agent.agentId)).toBe(true);
    } finally {
      await spy.end();
    }
  });

  it('closes an older local socket when the directory shows a newer one elsewhere', async () => {
    // D misses C's `presence.up` (messages are at most once): only its reload can repair.
    const handlers = (d.cluster.bus as unknown as { handlers: Map<string, unknown> }).handlers;
    const original = handlers.get('presence.up');
    handlers.set('presence.up', () => undefined);
    try {
      const closed = new Promise<number>((r) => agent.ws.once('close', (code) => r(code)));
      const second = await reconnect(agent.credential, c);
      await until(
        async () =>
          (
            await prisma.agentConnection.findUnique({
              where: { agentId: agent.agentId },
            })
          )?.instanceId === `${C2}-c`,
      );
      await d.cluster.directory.refresh();
      expect(await closed).toBe(4001); // SUPERSEDED
      await until(() => d.agentGateway.isConnected(agent.agentId)); // now known as remote, on C
      agent = { ...agent, client: second.client, ws: second.ws };
    } finally {
      handlers.set('presence.up', original);
    }
  });

  it('fences dispatcher ticks on a lock lost since the last periodic check', async () => {
    const leader = c.dispatcher.isLeader ? c : d;
    expect(leader.dispatcher.isLeader).toBe(true);
    // The lock is gone server-side (as when Postgres killed a half-open backend) while the
    // instance still believes it leads.
    await leader.cluster.link.query('SELECT pg_advisory_unlock($1::int, 1)', [lockClassOf(C2)]);
    expect(leader.dispatcher.isLeader).toBe(true);
    const work = vi.spyOn(
      leader.dispatcher as unknown as { expireOffers: () => Promise<void> },
      'expireOffers',
    );
    await leader.dispatcher.tick();
    expect(work).not.toHaveBeenCalled();
    expect(leader.dispatcher.isLeader).toBe(false);
    work.mockRestore();
  });

  it('never lets a stale delivery attempt delete or reschedule a job claimed again', async () => {
    await prisma.notificationSettings.create({
      data: {
        userId: user.userId,
        webhookUrlEnc: encrypt('https://hooks.example.com/stale', KEY),
        webhookHint: 'hooks.example.com',
      },
    });
    const payload = {
      id: 'stale-job',
      event: 'task_done',
      title: 'Stale',
      body: 'body',
      url: null,
      link: null,
      projectId: null,
      taskId: null,
      createdAt: new Date().toISOString(),
    };
    // Another worker re-claimed it (attempt 2) after this one's lock expired (attempt 1).
    const row = await prisma.notificationJob.create({
      data: {
        userId: user.userId,
        channel: 'webhook',
        payload,
        status: 'SENDING',
        attempts: 2,
        lockedUntil: new Date(Date.now() + 120_000),
        instanceId: 'the-other-worker',
      },
    });
    const deliver = (c.notifier as unknown as { deliver(j: unknown): Promise<void> }).deliver.bind(
      c.notifier,
    );
    await deliver({
      id: row.id,
      userId: user.userId,
      channel: 'webhook',
      endpoint: null,
      payload,
      attempts: 1,
    });
    const after = await prisma.notificationJob.findUnique({ where: { id: row.id } });
    expect(after).toMatchObject({ status: 'SENDING', attempts: 2, instanceId: 'the-other-worker' });
    await prisma.notificationJob.delete({ where: { id: row.id } });
  });
});

describe('LiveLogStore mirrors', () => {
  const line = (id: number, text: string) => ({ id, ts: 0, kind: 'text' as const, text });
  const info = (over: Partial<Parameters<LiveLogStore['ingest']>[0]> = {}) => ({
    assignmentId: 'a1',
    taskId: 't1',
    agentId: 'agent',
    startedAt: 1000,
    truncated: 0,
    finished: false,
    ...over,
  });

  it('adds only newer lines, follows the latest run, and never overwrites an owned run', () => {
    const store = new LiveLogStore({ now: () => 5000 });
    const seen: string[] = [];
    store.subscribe('t1', (e) => seen.push(e.type));
    store.ingest(info(), [line(10, 'a'), line(11, 'b')]);
    store.ingest(info(), [line(11, 'b'), line(12, 'c')]); // overlap from a renewal
    expect(store.snapshot('t1').lines.map((l) => l.text)).toEqual(['a', 'b', 'c']);
    // An older run arriving late is ignored; a newer one takes over.
    store.ingest(info({ assignmentId: 'a0', startedAt: 500 }), [line(1, 'old')]);
    expect(store.snapshot('t1').meta.assignmentId).toBe('a1');
    store.ingest(info({ finished: true }), []);
    expect(store.snapshot('t1').meta.state).toBe('finished');
    expect(seen).toEqual(['meta', 'lines', 'lines', 'end']);

    // A run owned here is never replaced by a mirror, and gets ids above everything mirrored.
    store.start('a2', 't1', 'agent');
    store.ingest(info({ assignmentId: 'a2', startedAt: 9999 }), [line(99_999_999, 'foreign')]);
    store.append('a2', [{ ts: 0, kind: 'text', text: 'mine' }]);
    const snap = store.snapshot('t1');
    expect(snap.lines.map((l) => l.text)).toEqual(['mine']);
    expect(snap.lines[0]!.id).toBeGreaterThan(12);
    expect(store.ownedRun('t1')?.run.assignmentId).toBe('a2');
  });
});
