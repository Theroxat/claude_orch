import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import WebSocket from 'ws';
import {
  AgentViewSchema,
  CreateEnrollmentTokenResponseSchema,
  EnrollResponseSchema,
  agentMessage,
  type AgentView,
  type ServerMessage,
} from '@orch/shared';
import { FakeGithub, api, loginAs, makeApp, prisma, type TestUser } from './harness';

const FAST = { AGENT_HEARTBEAT_TIMEOUT_MS: '60000', AGENT_SWEEP_INTERVAL_MS: '1000' };

let gh: FakeGithub;
let app: FastifyInstance;
let wsUrl: string;
let devApp: FastifyInstance;
let devWsUrl: string;

async function listen(a: FastifyInstance): Promise<string> {
  await a.listen({ port: 0, host: '127.0.0.1' });
  const addr = a.server.address();
  if (!addr || typeof addr === 'string') throw new Error('no address');
  return `ws://127.0.0.1:${addr.port}/agent/ws`;
}

beforeAll(async () => {
  gh = new FakeGithub();
  app = makeApp(gh, { env: { ORCH_VERSION: 'v0.4.3', ...FAST } });
  wsUrl = await listen(app);
  // Server without a release version: ORCH_VERSION explicitly empty -> 'dev'.
  devApp = makeApp(gh, { env: { ORCH_VERSION: '', ...FAST } });
  devWsUrl = await listen(devApp);
});
afterAll(async () => {
  await app.close();
  await devApp.close();
  await prisma.$disconnect();
});

async function until(cond: () => Promise<boolean> | boolean, ms = 2000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 20));
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
  async hello(agentVersion: string, selfUpdate?: boolean) {
    const m = agentMessage('hello', {
      agentVersion,
      capabilities: ['manual'],
      localPaused: false,
      maxConcurrent: 1,
      running: [],
      ...(selfUpdate !== undefined && { selfUpdate }),
    });
    this.send(m);
    return this.next('welcome', (w) => w.replyTo === m.id);
  }
  close() {
    this.ws.close();
  }
}

function connect(credential: string, url = wsUrl): Promise<Client> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers: { authorization: `Bearer ${credential}` } });
    const c = new Client(ws);
    ws.once('open', () => resolve(c));
    ws.once('error', reject);
  });
}

async function enrollAgent(a: FastifyInstance, user: TestUser) {
  const t = await api(a, user)('POST', '/api/agents/enrollment-tokens');
  const { token } = CreateEnrollmentTokenResponseSchema.parse(t.json());
  const res = await a.inject({
    method: 'POST',
    url: '/api/agents/enroll',
    payload: { token, machineName: 'box', agentVersion: '0.1.0' },
  });
  return EnrollResponseSchema.parse(res.json());
}

/** An agent connected with the given version. */
async function online(
  version: string,
  opts: { user?: TestUser; selfUpdate?: boolean; server?: FastifyInstance; url?: string } = {},
) {
  const a = opts.server ?? app;
  const user = opts.user ?? (await loginAs(a, gh));
  const enrolled = await enrollAgent(a, user);
  const client = await connect(enrolled.credential, opts.url);
  const welcome = await client.hello(version, opts.selfUpdate ?? true);
  return { user, ...enrolled, client, welcome };
}

async function view(a: FastifyInstance, user: TestUser, id: string): Promise<AgentView> {
  const res = await api(a, user)('GET', '/api/agents/mine');
  const v = (res.json() as unknown[]).map((x) => AgentViewSchema.parse(x)).find((x) => x.id === id);
  if (!v) throw new Error('agent not listed');
  return v;
}

const post = (user: TestUser | null, id: string, body?: unknown, a = app) =>
  api(a, user)('POST', `/api/agents/${id}/update`, body);

describe('auth', () => {
  it('rejects anonymous callers and foreign agents', async () => {
    const ag = await online('0.4.1');
    expect((await post(null, ag.agentId)).statusCode).toBe(401);
    expect((await api(app, null)('GET', '/api/agents/outdated-count')).statusCode).toBe(401);
    const other = await loginAs(app, gh);
    expect((await post(other, ag.agentId)).statusCode).toBe(404);
    expect(ag.client.msgs.some((m) => m.type === 'agent.update')).toBe(false);
    ag.client.close();
  });
});

describe('outdated computation', () => {
  it('flags only releases older than the server version', async () => {
    const user = await loginAs(app, gh);
    const old = await online('0.4.1', { user });
    const dev = await online('dev', { user });
    const same = await online('0.4.3', { user });
    const prefixed = await online('v0.3.9', { user });
    expect(old.welcome.payload.latestAgentVersion).toBe('0.4.3');
    const o = await view(app, user, old.agentId);
    expect(o).toMatchObject({
      latestAgentVersion: '0.4.3',
      updateAvailable: true,
      canSelfUpdate: true,
      update: null,
    });
    expect((await view(app, user, dev.agentId)).updateAvailable).toBe(false);
    expect((await view(app, user, same.agentId)).updateAvailable).toBe(false);
    expect((await view(app, user, prefixed.agentId)).updateAvailable).toBe(true);
    const count = await api(app, user)('GET', '/api/agents/outdated-count');
    expect(count.json()).toEqual({ count: 2 });
    // A revoked agent no longer counts.
    await api(app, user)('DELETE', `/api/agents/${prefixed.agentId}`);
    expect((await api(app, user)('GET', '/api/agents/outdated-count')).json()).toEqual({
      count: 1,
    });
    // Another user's agents are not counted.
    const other = await loginAs(app, gh);
    expect((await api(app, other)('GET', '/api/agents/outdated-count')).json()).toEqual({
      count: 0,
    });
    for (const x of [old, dev, same, prefixed]) x.client.close();
  });

  it('has no latest version and no welcome field on a dev server', async () => {
    const ag = await online('0.1.0', { server: devApp, url: devWsUrl });
    expect(ag.welcome.payload.latestAgentVersion).toBeUndefined();
    const v = await view(devApp, ag.user, ag.agentId);
    expect(v).toMatchObject({ latestAgentVersion: null, updateAvailable: false });
    ag.client.close();
  });
});

describe('POST /api/agents/:id/update', () => {
  it('sends agent.update with a server-decided image and audits it', async () => {
    const ag = await online('0.4.1');
    const res = await post(ag.user, ag.agentId, { whenIdle: true });
    expect(res.statusCode).toBe(202);
    const v = AgentViewSchema.parse(res.json());
    expect(v.update).toMatchObject({ status: 'pending', targetVersion: '0.4.3' });
    const msg = await ag.client.next('agent.update');
    expect(msg.payload).toMatchObject({
      targetVersion: '0.4.3',
      image: 'ghcr.io/theroxat/orch-agent:0.4.3',
      whenIdle: true,
    });
    expect(msg.payload.updateId).toMatch(/^upd_/);
    const row = await prisma.auditLog.findFirstOrThrow({
      where: { agentId: ag.agentId, action: 'agent.update_requested' },
    });
    expect(row.actorUserId).toBe(ag.user.userId);
    expect(row.data).toEqual({
      fromVersion: '0.4.1',
      targetVersion: '0.4.3',
      image: 'ghcr.io/theroxat/orch-agent:0.4.3',
      whenIdle: true,
    });
    ag.client.close();
  });

  it('defaults whenIdle to false and refuses unknown keys without sending', async () => {
    const ag = await online('0.4.1');
    for (const body of [{ image: 'evil/x:1' }, { targetVersion: '9.9.9' }, { whenIdle: 'yes' }]) {
      expect((await post(ag.user, ag.agentId, body)).statusCode).toBe(400);
    }
    await new Promise((r) => setTimeout(r, 100));
    expect(ag.client.msgs.some((m) => m.type === 'agent.update')).toBe(false);
    expect((await post(ag.user, ag.agentId)).statusCode).toBe(202);
    expect((await ag.client.next('agent.update')).payload.whenIdle).toBe(false);
    ag.client.close();
  });

  it('answers 409 up_to_date, agent_offline, update_unsupported', async () => {
    const same = await online('0.4.3');
    const r1 = await post(same.user, same.agentId);
    expect([r1.statusCode, r1.json().error.code]).toEqual([409, 'up_to_date']);
    same.client.close();

    const legacy = await online('0.4.1', { selfUpdate: false });
    const r2 = await post(legacy.user, legacy.agentId);
    expect([r2.statusCode, r2.json().error.code]).toEqual([409, 'update_unsupported']);
    expect((await view(app, legacy.user, legacy.agentId)).canSelfUpdate).toBe(false);
    legacy.client.close();

    const off = await online('0.4.1');
    off.client.close();
    await until(async () => !(await view(app, off.user, off.agentId)).connected);
    const r3 = await post(off.user, off.agentId);
    expect([r3.statusCode, r3.json().error.code]).toEqual([409, 'agent_offline']);
  });

  it('answers 409 server_version_unknown on a dev server', async () => {
    const ag = await online('0.1.0', { server: devApp, url: devWsUrl });
    const r = await post(ag.user, ag.agentId, undefined, devApp);
    expect([r.statusCode, r.json().error.code]).toEqual([409, 'server_version_unknown']);
    ag.client.close();
  });
});

describe('update.status', () => {
  it('stores progress, ignores stale ids, adopts local ones and completes on reconnect', async () => {
    const ag = await online('0.4.1');
    await post(ag.user, ag.agentId);
    const { payload } = await ag.client.next('agent.update');
    const status = async (updateId: string, s: string, extra: object = {}) => {
      const m = agentMessage('update.status', {
        updateId,
        targetVersion: '0.4.3',
        status: s,
        ...extra,
      } as never);
      ag.client.send(m);
      return (await ag.client.next('ack', (a) => a.replyTo === m.id)).payload;
    };

    expect(await status(payload.updateId, 'pulling')).toMatchObject({ ok: true });
    expect((await view(app, ag.user, ag.agentId)).update?.status).toBe('pulling');

    // A stale id is acked but changes nothing.
    expect(await status('upd_stale', 'failed', { code: 'x' })).toMatchObject({ ok: true });
    expect((await view(app, ag.user, ag.agentId)).update?.status).toBe('pulling');

    await status(payload.updateId, 'failed', { code: 'pull_failed', detail: 'boom' });
    const failed = (await view(app, ag.user, ag.agentId)).update;
    expect(failed).toMatchObject({ status: 'failed', code: 'pull_failed', detail: 'boom' });
    expect(
      await prisma.auditLog.count({
        where: { agentId: ag.agentId, action: 'agent.update_failed' },
      }),
    ).toBe(1);

    // A local `orch update` is adopted.
    await status('local-1', 'pulling');
    const row = await prisma.agent.findUniqueOrThrow({ where: { id: ag.agentId } });
    expect(row).toMatchObject({ updateId: 'local-1', updateStatus: 'pulling' });
    expect(row.updateTargetVersion).toBe('0.4.3');

    // Reconnect on the target version completes the update.
    ag.client.close();
    const back = await connect(ag.credential);
    await back.hello('0.4.3', true);
    const v = await view(app, ag.user, ag.agentId);
    expect(v).toMatchObject({ updateAvailable: false, version: '0.4.3' });
    expect(v.update).toMatchObject({ status: 'done', code: null, detail: null });
    expect(
      await prisma.auditLog.count({ where: { agentId: ag.agentId, action: 'agent.update_done' } }),
    ).toBe(1);
    back.close();
  });

  it('a queued update.status done after the reconnect is not audited twice (#31)', async () => {
    const ag = await online('0.4.1');
    await post(ag.user, ag.agentId);
    const { payload } = await ag.client.next('agent.update');
    ag.client.close();
    // The agent restarts on the target version (hello sets done), then flushes its outbox.
    const back = await connect(ag.credential);
    await back.hello('0.4.3', true);
    const done = agentMessage('update.status', {
      updateId: payload.updateId,
      targetVersion: '0.4.3',
      status: 'done',
    });
    back.send(done);
    expect((await back.next('ack', (a) => a.replyTo === done.id)).payload).toMatchObject({
      ok: true,
    });
    expect(
      await prisma.auditLog.count({ where: { agentId: ag.agentId, action: 'agent.update_done' } }),
    ).toBe(1);
    expect((await view(app, ag.user, ag.agentId)).update?.status).toBe('done');
    back.close();
  });
});
