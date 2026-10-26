/** Live task output: agent `task.log` -> bounded buffer -> SSE for users who can see the task. */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { connect } from 'node:net';
import WebSocket from 'ws';
import {
  EnrollResponseSchema,
  ProjectViewSchema,
  TaskViewSchema,
  agentMessage,
  type ServerMessage,
  type TaskLogEntry,
  type TaskView,
} from '@orch/shared';
import { LiveLogStore } from '../src/logs/store';
import { FakeGithub, api, loginAs, makeApp, prisma, repoFor, type TestUser } from './harness';

let gh: FakeGithub;
let app: FastifyInstance;
let base: string;

beforeAll(async () => {
  gh = new FakeGithub();
  app = makeApp(gh, { env: { DISPATCHER_ENABLED: 'true', DISPATCHER_INTERVAL_MS: '3600000' } });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  if (!addr || typeof addr === 'string') throw new Error('no address');
  base = `127.0.0.1:${addr.port}`;
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
  await new Promise((r) => setTimeout(r, 30));
  await app.dispatcher.settle();
};

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
    return (await this.next('ack', (a) => a.replyTo === m.id)).payload;
  }
}

const sockets: WebSocket[] = [];
afterEach(() => {
  for (const s of sockets.splice(0)) s.close();
});

async function onlineAgent(user: TestUser) {
  const tok = (await api(app, user)('POST', '/api/agents/enrollment-tokens')).json() as {
    token: string;
  };
  const enr = EnrollResponseSchema.parse(
    (
      await app.inject({
        method: 'POST',
        url: '/api/agents/enroll',
        payload: { token: tok.token, machineName: 'box', agentVersion: '0.8.0' },
      })
    ).json(),
  );
  const ws = new WebSocket(`ws://${base}/agent/ws`, {
    headers: { authorization: `Bearer ${enr.credential}` },
  });
  sockets.push(ws);
  const client = new Client(ws);
  await new Promise((r) => ws.once('open', r));
  client.send(
    agentMessage('hello', {
      agentVersion: '0.8.0',
      capabilities: ['auto', 'manual'],
      localPaused: false,
      maxConcurrent: 1,
      running: [],
    }),
  );
  const welcome = await client.next('welcome');
  await settle();
  return { agentId: enr.agentId, client, welcome };
}

/** Private project, an AUTO member running one task (accepted offer). */
async function runningTask() {
  const owner = await loginAs(app, gh);
  const repo = repoFor({ private: true });
  gh.repos.set(owner.token, [repo]);
  const p = ProjectViewSchema.parse(
    (await api(app, owner)('POST', '/api/projects', { githubRepoId: repo.githubRepoId })).json(),
  );
  const member = await loginAs(app, gh);
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
  const agent = await onlineAgent(member);
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
  const res = await api(app, owner)('POST', `/api/projects/${p.id}/tasks`, {
    title: 'Live thing',
    body: 'Do it live.',
    size: 'S',
  });
  expect(res.statusCode, res.body).toBe(201);
  const task: TaskView = TaskViewSchema.parse(res.json());
  await settle();
  const offer = await agent.client.next('task.offer', (o) => o.payload.task.taskId === task.id);
  const assignmentId = offer.payload.assignmentId;
  const ack = await agent.client.call(
    agentMessage('offer.accept', { assignmentId, execMode: 'AUTO' }),
  );
  expect(ack.ok).toBe(true);
  return { owner, member, project: p, task, agent, assignmentId };
}

const entry = (text: string, over: Partial<TaskLogEntry> = {}): TaskLogEntry => ({
  ts: Date.now(),
  kind: 'text',
  text,
  ...over,
});

interface SseEvent {
  event: string;
  id?: string;
  data: unknown;
}

/** Opens the SSE stream like a browser would (cookie session) and collects its events. */
async function openStream(
  user: TestUser | null,
  taskId: string,
  headers: Record<string, string> = {},
) {
  const ctl = new AbortController();
  const res = await fetch(`http://${base}/api/tasks/${taskId}/logs/stream`, {
    headers: { ...(user ? { cookie: user.cookie } : {}), ...headers },
    signal: ctl.signal,
  });
  const events: SseEvent[] = [];
  if (res.ok && res.body) {
    const reader = res.body.getReader();
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
            const ev: SseEvent = { event: 'message', data: undefined };
            let data = '';
            for (const line of block.split('\n')) {
              if (line.startsWith('event: ')) ev.event = line.slice(7);
              else if (line.startsWith('id: ')) ev.id = line.slice(4);
              else if (line.startsWith('data: ')) data += line.slice(6);
            }
            if (data) {
              ev.data = JSON.parse(data);
              events.push(ev);
            }
          }
        }
      } catch {
        // aborted
      }
    })();
  }
  const texts = () =>
    events
      .filter((e) => e.event === 'lines')
      .flatMap((e) => (e.data as { lines: Array<{ text: string }> }).lines.map((l) => l.text));
  return { res, events, texts, close: () => ctl.abort() };
}

describe('live task logs', () => {
  it('announces live logs in welcome, replays the backlog, then streams new lines', async () => {
    const t = await runningTask();
    expect(t.agent.welcome.payload.liveLogs).toBe(true);
    t.agent.client.send(
      agentMessage('task.log', {
        assignmentId: t.assignmentId,
        chunk: 1,
        entries: [entry('first'), entry('pnpm test', { kind: 'tool', tool: 'Bash' })],
      }),
    );
    await until(() => app.liveLogs.snapshot(t.task.id).lines.length === 2);

    const s = await openStream(t.owner, t.task.id);
    expect(s.res.status).toBe(200);
    expect(s.res.headers.get('content-type')).toContain('text/event-stream');
    await until(() => s.texts().length === 2);
    expect(s.events[0]).toMatchObject({
      event: 'meta',
      data: { assignmentId: t.assignmentId, state: 'live', truncated: 0 },
    });

    t.agent.client.send(
      agentMessage('task.log', {
        assignmentId: t.assignmentId,
        chunk: 2,
        entries: [entry('\u001b[31msecond\u001b[0m ghs_' + 'Q'.repeat(30))],
        dropped: 3,
      }),
    );
    await until(() => s.texts().length === 3);
    // The server strips ANSI and redacts again, whatever the agent sent.
    expect(s.texts()[2]).toBe('second [REDACTED]');
    const lastId = s.events.filter((e) => e.event === 'lines').at(-1)!.id!;

    // A reconnect with Last-Event-ID replays only what is newer.
    const again = await openStream(t.owner, t.task.id, { 'last-event-id': lastId });
    t.agent.client.send(
      agentMessage('task.log', {
        assignmentId: t.assignmentId,
        chunk: 3,
        entries: [entry('third')],
      }),
    );
    await until(() => again.texts().length === 1);
    expect(again.texts()).toEqual(['third']);
    expect(again.events[0]).toMatchObject({ event: 'meta', data: { truncated: 3 } });

    // task.finished ends the run; its buffer stays readable.
    const fin = await t.agent.client.call(
      agentMessage('task.finished', {
        assignmentId: t.assignmentId,
        seq: 1,
        outcome: 'failed',
        usage: { weighted: 0, input: 0, output: 0 },
        error: 'boom',
      }),
    );
    expect(fin.ok).toBe(true);
    await until(() => s.events.some((e) => e.event === 'end'));
    const after = await openStream(t.owner, t.task.id);
    await until(() => after.events.some((e) => e.event === 'end'));
    expect(after.texts()).toEqual(['first', 'pnpm test', 'second [REDACTED]', 'third']);
    for (const x of [s, again, after]) x.close();
  });

  it('only users who can see the task: 404 for outsiders, 401 signed out, 200 for participants', async () => {
    const t = await runningTask();
    const outsider = await loginAs(app, gh);
    const denied = await openStream(outsider, t.task.id);
    expect(denied.res.status).toBe(404);
    const anon = await openStream(null, t.task.id);
    expect(anon.res.status).toBe(401);
    const unknown = await openStream(t.owner, 'does-not-exist');
    expect(unknown.res.status).toBe(404);
    // The running member is an active participant of the private project: allowed.
    const member = await openStream(t.member, t.task.id);
    expect(member.res.status).toBe(200);
    await until(() => member.events.length > 0);
    member.close();
  });

  it('ignores task.log for an assignment of another agent, or one that is not running', async () => {
    const t = await runningTask();
    const other = await runningTask();
    // Another agent writing to t's assignment: dropped.
    other.agent.client.send(
      agentMessage('task.log', {
        assignmentId: t.assignmentId,
        chunk: 1,
        entries: [entry('forged')],
      }),
    );
    other.agent.client.send(
      agentMessage('task.log', { assignmentId: 'nope', chunk: 1, entries: [entry('x')] }),
    );
    // Its own run works (proves the frames above were processed, in order, before this one).
    other.agent.client.send(
      agentMessage('task.log', {
        assignmentId: other.assignmentId,
        chunk: 1,
        entries: [entry('own')],
      }),
    );
    await until(() => app.liveLogs.snapshot(other.task.id).lines.length === 1);
    expect(app.liveLogs.snapshot(t.task.id)).toEqual({
      meta: { assignmentId: null, state: 'waiting', truncated: 0 },
      lines: [],
    });
    // Once finished, late batches are ignored too.
    await prisma.assignment.update({
      where: { id: t.assignmentId },
      data: { status: 'FAILED', finishedAt: new Date() },
    });
    t.agent.client.send(
      agentMessage('task.log', {
        assignmentId: t.assignmentId,
        chunk: 9,
        entries: [entry('late')],
      }),
    );
    await new Promise((r) => setTimeout(r, 100));
    expect(app.liveLogs.snapshot(t.task.id).lines).toEqual([]);
  });

  it('closes a stream whose client stops reading instead of queueing output without bound', async () => {
    const t = await runningTask();
    app.liveLogs.start(t.assignmentId, t.task.id, t.agent.agentId);
    const [host, port] = base.split(':') as [string, string];
    const sock = connect(Number(port), host);
    await new Promise((r) => sock.once('connect', r));
    sock.write(
      `GET /api/tasks/${t.task.id}/logs/stream HTTP/1.1\r\nhost: ${base}\r\ncookie: ${t.owner.cookie}\r\n\r\n`,
    );
    let received = 0;
    let tail = '';
    let ended = false;
    sock.on('data', (d: Buffer) => {
      received += d.length;
      tail = (tail + d.toString('latin1')).slice(-16);
      // Last chunk of a chunked response: the server ended it (the socket itself may stay open).
      if (tail.endsWith('\r\n0\r\n\r\n')) ended = true;
    });
    sock.on('close', () => (ended = true));
    await until(() => received > 0); // subscribed (the first meta event arrived)
    sock.pause(); // from now on, a client that never reads
    // ~48 MB of live output while the client is stalled: far more than socket buffers absorb.
    const big = 'x'.repeat(4000);
    for (let i = 0; i < 24; i++) {
      app.liveLogs.append(
        t.assignmentId,
        Array.from({ length: 500 }, () => entry(big)),
      );
    }
    sock.resume();
    // The server gave up on it: what was queued drains, then the stream ends (the browser would
    // reconnect with Last-Event-ID), long before its 2 min lifetime.
    await until(() => ended, 10_000);
    expect(received).toBeLessThan(40 * 1024 * 1024);
    sock.destroy();
  }, 30_000);
});

describe('LiveLogStore', () => {
  it('bounds each run, keeps finished runs for a while, then forgets them', () => {
    let now = 0;
    const store = new LiveLogStore({ maxBytesPerRun: 1000, retainMs: 1000, now: () => now });
    store.start('a1', 't1', 'agent');
    store.append(
      'a1',
      Array.from({ length: 20 }, (_, i) => entry(`${i}`.padEnd(100, '.'))),
    );
    const snap = store.snapshot('t1');
    expect(snap.lines.length).toBeLessThan(20);
    expect(snap.meta.truncated).toBe(20 - snap.lines.length);
    expect(snap.lines.at(-1)!.text.startsWith('19')).toBe(true);

    const seen: string[] = [];
    const off = store.subscribe('t1', (e) => seen.push(e.type));
    store.finish('a1');
    expect(store.snapshot('t1').meta.state).toBe('finished');
    // A retry of the same task starts a new run with higher ids.
    store.start('a2', 't1', 'agent');
    store.append('a2', [entry('retry')]);
    const lines = store.snapshot('t1').lines;
    expect(lines.map((l) => l.text)).toEqual(['retry']);
    expect(lines[0]!.id).toBeGreaterThan(snap.lines.at(-1)!.id);
    expect(seen).toEqual(['end', 'meta', 'lines']);
    off();

    store.finish('a2');
    now = 5000;
    store.sweep();
    expect(store.size).toBe(0);
    expect(store.snapshot('t1').meta).toEqual({
      assignmentId: null,
      state: 'waiting',
      truncated: 0,
    });
  });

  it('keeps line ids growing across server restarts, so an old Last-Event-ID hides nothing', () => {
    let now = Date.UTC(2026, 9, 22);
    const before = new LiveLogStore({ now: () => now });
    before.start('a1', 't1', 'agent');
    before.append(
      'a1',
      Array.from({ length: 50 }, (_, i) => entry(`old ${i}`)),
    );
    const lastSeen = before.snapshot('t1').lines.at(-1)!.id;
    expect(Number.isSafeInteger(lastSeen)).toBe(true);

    now += 5_000; // the server restarts: a fresh store, same task resumed by the agent
    const after = new LiveLogStore({ now: () => now });
    after.start('a1', 't1', 'agent');
    after.append('a1', [entry('after restart')]);
    expect(after.snapshot('t1', lastSeen).lines.map((l) => l.text)).toEqual(['after restart']);
  });
});
