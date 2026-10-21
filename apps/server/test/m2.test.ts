import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import WebSocket from 'ws';
import {
  AgentViewSchema,
  CloseCode,
  CreateEnrollmentTokenResponseSchema,
  EnrollResponseSchema,
  PROTOCOL_VERSION,
  agentMessage,
  parseAgentCredential,
  type AgentView,
  type ServerMessage,
  type UsageReportPayload,
} from '@orch/shared';
import { sha256Hex } from '../src/auth/crypto';
import { OfferRefusedError } from '../src/agents';
import { purgeRetention } from '../src/usage';
import { FakeGithub, api, loginAs, makeApp, prisma, type TestUser } from './harness';

const FAST = {
  AGENT_HEARTBEAT_TIMEOUT_MS: '400',
  AGENT_SWEEP_INTERVAL_MS: '50',
};

let gh: FakeGithub;
let app: FastifyInstance;
let wsUrl: string;

beforeAll(async () => {
  gh = new FakeGithub();
  app = makeApp(gh, { env: FAST });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  if (!addr || typeof addr === 'string') throw new Error('no address');
  wsUrl = `ws://127.0.0.1:${addr.port}/agent/ws`;
});
afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});
afterEach(() => {
  vi.useRealTimers();
});

// ---------- helpers ----------

async function createToken(user: TestUser) {
  const res = await api(app, user)('POST', '/api/agents/enrollment-tokens');
  expect(res.statusCode).toBe(201);
  return CreateEnrollmentTokenResponseSchema.parse(res.json());
}

function enroll(a: FastifyInstance, token: string, url = '/api/agents/enroll') {
  return a.inject({
    method: 'POST',
    url,
    payload: { token, machineName: 'box-1', agentVersion: '0.1.0' },
  });
}

async function newAgent(user: TestUser) {
  const { token } = await createToken(user);
  const res = await enroll(app, token);
  expect(res.statusCode).toBe(201);
  return EnrollResponseSchema.parse(res.json());
}

async function mine(user: TestUser): Promise<AgentView[]> {
  const res = await api(app, user)('GET', '/api/agents/mine');
  expect(res.statusCode).toBe(200);
  return (res.json() as unknown[]).map((x) => AgentViewSchema.parse(x));
}

async function viewOf(user: TestUser, agentId: string) {
  const v = (await mine(user)).find((a) => a.id === agentId);
  if (!v) throw new Error('agent not listed');
  return v;
}

async function until(cond: () => Promise<boolean> | boolean, ms = 2000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('condition not met in time');
}

/** A test agent client that buffers every server frame. */
class Client {
  readonly msgs: ServerMessage[] = [];
  closeCode: number | null = null;
  readonly closed: Promise<number>;

  constructor(readonly ws: WebSocket) {
    ws.on('message', (d) => this.msgs.push(JSON.parse(d.toString()) as ServerMessage));
    this.closed = new Promise((resolve) =>
      ws.on('close', (code) => {
        this.closeCode = code;
        resolve(code);
      }),
    );
  }

  send(m: unknown) {
    this.ws.send(typeof m === 'string' ? m : JSON.stringify(m));
  }

  async next<T extends ServerMessage['type']>(
    type: T,
    pred: (m: Extract<ServerMessage, { type: T }>) => boolean = () => true,
    ms = 2000,
  ): Promise<Extract<ServerMessage, { type: T }>> {
    let found: Extract<ServerMessage, { type: T }> | undefined;
    await until(() => {
      found = this.msgs.find(
        (m): m is Extract<ServerMessage, { type: T }> =>
          m.type === type && pred(m as Extract<ServerMessage, { type: T }>),
      );
      return !!found;
    }, ms);
    return found!;
  }

  ackFor(id: string) {
    return this.next('ack', (m) => m.replyTo === id);
  }

  async hello() {
    const m = agentMessage('hello', {
      agentVersion: '0.2.0',
      capabilities: ['manual'],
      localPaused: false,
      maxConcurrent: 1,
      running: [],
    });
    this.send(m);
    return this.next('welcome', (w) => w.replyTo === m.id);
  }

  close() {
    this.ws.close();
  }
}

/** Opens a socket. Rejects with the HTTP status when the upgrade is refused. */
function connect(credential?: string, url = wsUrl): Promise<Client> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, {
      headers: credential ? { authorization: `Bearer ${credential}` } : {},
    });
    const c = new Client(ws);
    ws.once('open', () => resolve(c));
    ws.once('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
    ws.once('error', (err) => reject(err));
  });
}

async function onlineAgent(user?: TestUser) {
  const u = user ?? (await loginAs(app, gh));
  const enrolled = await newAgent(u);
  const client = await connect(enrolled.credential);
  const welcome = await client.hello();
  return { user: u, ...enrolled, client, welcome };
}

const usage = (over: Partial<UsageReportPayload> = {}): UsageReportPayload => ({
  estimate: true,
  windowStart: '2026-10-21T10:00:00.000Z',
  windowResetAt: '2026-10-21T15:00:00.000Z',
  tokens: { input: 100, output: 50, cacheWrite: 10, cacheRead: 1000 },
  weighted: 400,
  byModel: { sonnet: 400 },
  byProject: { personal: 400 },
  capacityEstimate: 1000,
  source: 'jsonl',
  ...over,
});

// ---------- enrollment ----------

describe('enrollment tokens', () => {
  it('requires a session', async () => {
    const res = await api(app, null)('POST', '/api/agents/enrollment-tokens');
    expect(res.statusCode).toBe(401);
  });

  it('returns the token once with an install command and stores only its hash', async () => {
    const u = await loginAs(app, gh);
    const t = await createToken(u);
    expect(t.installCommand).toBe(
      `curl -fsSL http://localhost:8470/install.sh | ORCH_TOKEN=${t.token} sh`,
    );
    const expires = new Date(t.expiresAt).getTime() - Date.now();
    expect(expires).toBeGreaterThan(14 * 60_000);
    expect(expires).toBeLessThanOrEqual(15 * 60_000);
    const rows = await prisma.enrollmentToken.findMany({ where: { userId: u.userId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tokenHash).toBe(sha256Hex(t.token));
    expect(JSON.stringify(rows)).not.toContain(t.token);
    // No route shows it again.
    const list = await api(app, u)('GET', '/api/agents/mine');
    expect(list.body).not.toContain(t.token);
  });

  it('is single use (second enroll 401) and works on the /agent/enroll alias', async () => {
    const u = await loginAs(app, gh);
    const { token } = await createToken(u);
    const first = await app.inject({
      method: 'POST',
      url: '/agent/enroll',
      payload: {
        token,
        machine: {
          hostname: 'h1',
          os: 'linux',
          arch: 'x64',
          agentVersion: '0.1.0',
          dockerVersion: '27.1',
        },
      },
    });
    expect(first.statusCode).toBe(201);
    const body = EnrollResponseSchema.parse(first.json());
    expect(body.agentId).toMatch(/^agt_[A-Za-z0-9_-]+$/);
    expect(parseAgentCredential(body.credential)?.agentId).toBe(body.agentId);
    const agent = await prisma.agent.findUniqueOrThrow({ where: { id: body.agentId } });
    expect(agent).toMatchObject({ userId: u.userId, name: 'h1', os: 'linux', arch: 'x64' });
    const second = await enroll(app, token);
    expect(second.statusCode).toBe(401);
    expect(second.json().error.code).toBe('invalid_token');
  });

  it('rejects unknown tokens and bad bodies', async () => {
    expect((await enroll(app, 'nope')).statusCode).toBe(401);
    const bad = await app.inject({
      method: 'POST',
      url: '/api/agents/enroll',
      payload: { token: 'x' },
    });
    expect(bad.statusCode).toBe(400);
  });

  it('expires after 15 minutes (fake Date)', async () => {
    const u = await loginAs(app, gh);
    vi.useFakeTimers({ toFake: ['Date'] });
    const t0 = Date.now();
    vi.setSystemTime(t0);
    const a = await createToken(u);
    const b = await createToken(u);
    vi.setSystemTime(t0 + 14 * 60_000);
    expect((await enroll(app, a.token)).statusCode).toBe(201);
    vi.setSystemTime(t0 + 15 * 60_000 + 1000);
    expect((await enroll(app, b.token)).statusCode).toBe(401);
  });

  it('concurrent enrollments with one token: exactly one wins', async () => {
    const u = await loginAs(app, gh);
    const { token } = await createToken(u);
    const results = await Promise.all(Array.from({ length: 10 }, () => enroll(app, token)));
    const codes = results.map((r) => r.statusCode).sort();
    expect(codes.filter((c) => c === 201)).toHaveLength(1);
    expect(codes.filter((c) => c === 401)).toHaveLength(9);
    expect(await prisma.agent.count({ where: { userId: u.userId } })).toBe(1);
    const tok = await prisma.enrollmentToken.findUniqueOrThrow({
      where: { tokenHash: sha256Hex(token) },
    });
    expect(tok.usedAt).not.toBeNull();
    expect(tok.usedByAgentId).toBe(results.find((r) => r.statusCode === 201)!.json().agentId);
  });

  it('writes an agent.enrolled audit row without secrets', async () => {
    const u = await loginAs(app, gh);
    const { token } = await createToken(u);
    const res = EnrollResponseSchema.parse((await enroll(app, token)).json());
    const secret = parseAgentCredential(res.credential)!.secret;
    const rows = await prisma.auditLog.findMany({ where: { agentId: res.agentId } });
    const enrolled = rows.find((r) => r.action === 'agent.enrolled');
    expect(enrolled).toMatchObject({ actorType: 'USER', actorUserId: u.userId });
    expect(enrolled!.data).toEqual({ machineName: 'box-1', agentVersion: '0.1.0' });
    const all = JSON.stringify(rows, (_k, v) => (typeof v === 'bigint' ? String(v) : v));
    expect(all).not.toContain(secret);
    expect(all).not.toContain(sha256Hex(secret));
    expect(all).not.toContain(token);
  });
});

// ---------- secrets never leak ----------

describe('credential secrecy', () => {
  it('is stored hashed and never returned or logged', async () => {
    const lines: string[] = [];
    const logApp = makeApp(gh, {
      env: { ...FAST, LOG_LEVEL: 'trace' },
      logStream: { write: (s: string) => void lines.push(s) },
    });
    await logApp.listen({ port: 0, host: '127.0.0.1' });
    try {
      const addr = logApp.server.address() as { port: number };
      const u = await loginAs(logApp, gh);
      const t = CreateEnrollmentTokenResponseSchema.parse(
        (await api(logApp, u)('POST', '/api/agents/enrollment-tokens')).json(),
      );
      const res = EnrollResponseSchema.parse((await enroll(logApp, t.token)).json());
      const { secret } = parseAgentCredential(res.credential)!;
      const c = await connect(res.credential, `ws://127.0.0.1:${addr.port}/agent/ws`);
      await c.hello();
      await connect(`${res.credential}x`, `ws://127.0.0.1:${addr.port}/agent/ws`).catch(() => null);

      const row = await prisma.agent.findUniqueOrThrow({ where: { id: res.agentId } });
      expect(row.secretHash).toBe(sha256Hex(secret));
      expect(JSON.stringify(row)).not.toContain(secret);

      const list = await api(logApp, u)('GET', '/api/agents/mine');
      expect(list.body).not.toContain(secret);
      expect(list.body).not.toContain(row.secretHash);
      expect(list.body).not.toContain('secretHash');

      c.close();
      await c.closed;
      const log = lines.join('');
      expect(lines.length).toBeGreaterThan(0);
      expect(log).not.toContain(secret);
      expect(log).not.toContain(row.secretHash);
      expect(log).not.toContain(res.credential);
      expect(log).not.toContain(t.token);
    } finally {
      await logApp.close();
    }
  });
});

// ---------- WebSocket ----------

describe('agent websocket auth', () => {
  it('rejects a missing header, a wrong secret and a revoked agent with HTTP 401', async () => {
    const u = await loginAs(app, gh);
    const { agentId, credential } = await newAgent(u);
    await expect(connect()).rejects.toThrow('HTTP 401');
    await expect(connect('garbage')).rejects.toThrow('HTTP 401');
    await expect(connect(`orch_agent_${agentId}.${'A'.repeat(43)}`)).rejects.toThrow('HTTP 401');
    const ok = await connect(credential);
    ok.close();
    expect((await api(app, u)('DELETE', `/api/agents/${agentId}`)).statusCode).toBe(204);
    await expect(connect(credential)).rejects.toThrow('HTTP 401');
  });

  it('revocation closes the live socket with 4003 in < 2 s', async () => {
    const { user, agentId, client } = await onlineAgent();
    const t0 = Date.now();
    expect((await api(app, user)('DELETE', `/api/agents/${agentId}`)).statusCode).toBe(204);
    expect(await client.closed).toBe(CloseCode.REVOKED);
    expect(Date.now() - t0).toBeLessThan(2000);
    const v = await viewOf(user, agentId);
    expect(v.revokedAt).not.toBeNull();
    expect(v.connected).toBe(false);
    const audit = await prisma.auditLog.findFirst({ where: { agentId, action: 'agent.revoked' } });
    expect(audit?.actorUserId).toBe(user.userId);
  });

  it('a second connection supersedes the first (4001)', async () => {
    const { user, agentId, credential, client } = await onlineAgent();
    const second = await connect(credential);
    expect(await client.closed).toBe(CloseCode.SUPERSEDED);
    await second.hello();
    expect((await viewOf(user, agentId)).connected).toBe(true);
    second.close();
    await second.closed;
    await until(async () => !(await viewOf(user, agentId)).connected);
  });
});

describe('agent websocket protocol', () => {
  it('hello gets welcome with the DB config; lastSeenAt and version are updated', async () => {
    const { user, agentId, welcome, client } = await onlineAgent();
    expect(welcome.payload).toMatchObject({
      agentId,
      heartbeatSec: 30,
      usageSec: 300,
      paused: false,
      participations: [],
    });
    const v = await viewOf(user, agentId);
    expect(v).toMatchObject({ connected: true, version: '0.2.0' });
    expect(v.lastSeenAt).not.toBeNull();
    client.close();
  });

  it('heartbeats keep the agent connected; silence closes it with 4008', async () => {
    const { user, agentId, client } = await onlineAgent();
    const before = (await prisma.agent.findUniqueOrThrow({ where: { id: agentId } })).lastSeenAt!;
    for (let i = 0; i < 6; i++) {
      await new Promise((r) => setTimeout(r, 150));
      client.send(agentMessage('heartbeat', { running: 0, localPaused: false }));
    }
    expect(client.closeCode).toBeNull();
    expect((await viewOf(user, agentId)).connected).toBe(true);
    const after = (await prisma.agent.findUniqueOrThrow({ where: { id: agentId } })).lastSeenAt!;
    expect(after.getTime()).toBeGreaterThan(before.getTime());
    expect(await client.closed).toBe(CloseCode.HEARTBEAT_TIMEOUT);
    expect((await viewOf(user, agentId)).connected).toBe(false);
  });

  it('usage.report is stored and acked; a replay is a duplicate', async () => {
    const { user, agentId, client } = await onlineAgent();
    const m = agentMessage('usage.report', usage());
    client.send(m);
    expect((await client.ackFor(m.id)).payload).toEqual({ ok: true });
    client.send(m);
    await until(
      () => client.msgs.filter((x) => x.type === 'ack' && x.replyTo === m.id).length === 2,
    );
    const acks = client.msgs.filter((x) => x.type === 'ack' && x.replyTo === m.id);
    expect(acks[1]!.payload).toEqual({ ok: true, duplicate: true });
    expect(await prisma.usageReport.count({ where: { agentId } })).toBe(1);
    const row = await prisma.usageReport.findFirstOrThrow({ where: { agentId } });
    expect(row).toMatchObject({ userId: user.userId, inputTokens: 100n, weightedTokens: 400n });
    const v = await viewOf(user, agentId);
    expect(v.lastUsage).toMatchObject({
      estimate: true,
      weighted: 400,
      capacityEstimate: 1000,
      usedFraction: 0.4,
      windowResetAt: '2026-10-21T15:00:00.000Z',
      rateLimitedUntil: null,
    });
    const agentRow = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } });
    expect(agentRow.lastUsageAt).not.toBeNull();
    client.close();
  });

  it('purge removes old usage reports and dedupe entries only', async () => {
    const { agentId, user, client } = await onlineAgent();
    client.close();
    const now = new Date();
    const base = {
      agentId,
      userId: user.userId,
      inputTokens: 1n,
      outputTokens: 1n,
      cacheWriteTokens: 0n,
      cacheReadTokens: 0n,
      weightedTokens: 1n,
      byModel: {},
      byProject: {},
      source: 'jsonl',
    };
    await prisma.usageReport.createMany({
      data: [
        { ...base, reportedAt: new Date(now.getTime() - 31 * 86_400_000) },
        { ...base, reportedAt: new Date(now.getTime() - 29 * 86_400_000) },
      ],
    });
    await prisma.agentMessageSeen.createMany({
      data: [
        { agentId, messageId: 'old', seenAt: new Date(now.getTime() - 25 * 3600_000) },
        { agentId, messageId: 'new', seenAt: new Date(now.getTime() - 23 * 3600_000) },
      ],
    });
    const r = await purgeRetention(prisma, now);
    expect(r.usageReports).toBeGreaterThanOrEqual(1);
    expect(await prisma.usageReport.count({ where: { agentId } })).toBe(1);
    const seen = await prisma.agentMessageSeen.findMany({ where: { agentId } });
    expect(seen.map((s) => s.messageId)).toEqual(['new']);
  });

  it('version mismatch closes with 4010', async () => {
    const { client } = await onlineAgent();
    const m = agentMessage('heartbeat', { running: 0, localPaused: false });
    client.send({ ...m, v: PROTOCOL_VERSION + 1 });
    expect((await client.next('error')).payload.code).toBe('version_mismatch');
    expect(await client.closed).toBe(CloseCode.VERSION_MISMATCH);
  });

  it('invalid JSON closes with 4009; an invalid payload only gets an error', async () => {
    const a = await onlineAgent();
    const bad = agentMessage('heartbeat', { running: -1, localPaused: false });
    a.client.send(bad);
    const err = await a.client.next('error');
    expect(err.payload).toMatchObject({ code: 'invalid_message', replyTo: bad.id });
    a.client.send('{not json');
    expect(await a.client.closed).toBe(CloseCode.PROTOCOL_ERROR);
  });

  it('token.request for an unknown assignment is denied', async () => {
    const { client } = await onlineAgent();
    const m = agentMessage('token.request', {
      requestId: 'r1',
      assignmentId: 'a1',
      purpose: 'clone',
    });
    client.send(m);
    expect((await client.next('token.deny')).payload).toEqual({
      requestId: 'r1',
      reason: 'unknown_assignment',
    });
    client.close();
  });
});

// ---------- pause ----------

describe('pause', () => {
  it('web pause and resume reach the agent as config.update in < 2 s', async () => {
    const { user, agentId, client } = await onlineAgent();
    let t0 = Date.now();
    const res = await api(app, user)('POST', `/api/agents/${agentId}/pause`);
    expect(res.statusCode).toBe(200);
    expect(AgentViewSchema.parse(res.json())).toMatchObject({ paused: true, connected: true });
    await client.next('config.update', (m) => m.payload.paused === true);
    expect(Date.now() - t0).toBeLessThan(2000);

    t0 = Date.now();
    const res2 = await api(app, user)('POST', `/api/agents/${agentId}/resume`);
    expect(res2.json().paused).toBe(false);
    await client.next('config.update', (m) => m.payload.paused === false);
    expect(Date.now() - t0).toBeLessThan(2000);

    const db = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } });
    expect(db).toMatchObject({ paused: false, pauseSource: 'web' });
    const actions = (await prisma.auditLog.findMany({ where: { agentId } })).map((r) => r.action);
    expect(actions).toEqual(
      expect.arrayContaining(['agent.enrolled', 'agent.paused', 'agent.resumed']),
    );
    client.close();
  });

  it('a paused agent gets paused on welcome', async () => {
    const u = await loginAs(app, gh);
    const { agentId, credential } = await newAgent(u);
    await api(app, u)('POST', `/api/agents/${agentId}/pause`);
    const c = await connect(credential);
    expect((await c.hello()).payload.paused).toBe(true);
    c.close();
  });

  it('pause.set from the agent updates the DB and refuses offers and claims', async () => {
    const { user, agentId, client } = await onlineAgent();
    const p = agentMessage('pause.set', { paused: true });
    client.send(p);
    expect((await client.ackFor(p.id)).payload).toEqual({ ok: true });
    const db = await prisma.agent.findUniqueOrThrow({ where: { id: agentId } });
    expect(db).toMatchObject({ paused: true, pauseSource: 'agent' });
    expect((await viewOf(user, agentId)).paused).toBe(true);
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { agentId, action: 'agent.paused' },
    });
    expect(audit).toMatchObject({ actorType: 'AGENT', actorAgentId: agentId });

    const accept = agentMessage('offer.accept', { assignmentId: 'x', execMode: 'AUTO' });
    const claim = agentMessage('task.claim', { projectFullName: 'a/b', issueNumber: 1 });
    client.send(accept);
    client.send(claim);
    expect((await client.ackFor(accept.id)).payload).toMatchObject({
      ok: false,
      error: { code: 'paused' },
    });
    expect((await client.ackFor(claim.id)).payload).toMatchObject({
      ok: false,
      error: { code: 'paused' },
    });

    const offer = {
      assignmentId: 'as1',
      kind: 'AUTO_OFFER' as const,
      expiresAt: null,
      task: {
        taskId: 't1',
        project: { id: 'p', fullName: 'a/b', defaultBranch: 'main' },
        issueNumber: 1,
        title: 't',
        prompt: 'p',
        bodyHash: 'h',
        acceptanceCriteria: [],
        size: 'S' as const,
        model: 'SONNET' as const,
        baseBranch: 'main',
        branchName: 'orch/issue-1',
        createdBy: { login: 'x' },
      },
    };
    await expect(app.agentGateway.sendOffer(agentId, offer)).rejects.toMatchObject({
      reason: 'paused',
    });

    const r = agentMessage('pause.set', { paused: false });
    client.send(r);
    await client.ackFor(r.id);
    const accept2 = agentMessage('offer.accept', { assignmentId: 'x', execMode: 'AUTO' });
    client.send(accept2);
    // M4: offers are real now; an unknown assignment is not found.
    expect((await client.ackFor(accept2.id)).payload.error?.code).toBe('not_found');
    // M4 consent guard: no AUTO_OFFER without an active AUTO-mode participation.
    await expect(app.agentGateway.sendOffer(agentId, offer)).rejects.toMatchObject({
      reason: 'no_consent',
    });
    await app.agentGateway.sendOffer(agentId, { ...offer, kind: 'CLAIM' });
    await client.next('task.offer');
    client.close();
    await client.closed;
    await until(() => !app.agentGateway.isConnected(agentId));
    const err = await app.agentGateway.sendOffer(agentId, offer).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OfferRefusedError);
    expect((err as OfferRefusedError).reason).toBe('offline');
  });
});

// ---------- access control and files ----------

describe('access control', () => {
  it('pause/resume/delete of another user agent is 404; unauthenticated is 401', async () => {
    const owner = await loginAs(app, gh);
    const other = await loginAs(app, gh);
    const { agentId } = await newAgent(owner);
    for (const [m, url] of [
      ['POST', `/api/agents/${agentId}/pause`],
      ['POST', `/api/agents/${agentId}/resume`],
      ['DELETE', `/api/agents/${agentId}`],
    ] as const) {
      expect((await api(app, other)(m, url)).statusCode).toBe(404);
      expect((await api(app, null)(m, url)).statusCode).toBe(401);
    }
    expect((await api(app, null)('GET', '/api/agents/mine')).statusCode).toBe(401);
    expect(await mine(other)).toEqual([]);
    expect((await viewOf(owner, agentId)).paused).toBe(false);
  });

  it('revoked agents stay listed (newest first) and cannot be paused (404)', async () => {
    const u = await loginAs(app, gh);
    const a = await newAgent(u);
    const b = await newAgent(u);
    await api(app, u)('DELETE', `/api/agents/${a.agentId}`);
    const list = await mine(u);
    expect(list.map((x) => x.id)).toEqual([b.agentId, a.agentId]);
    expect(list[1]!.revokedAt).not.toBeNull();
    expect((await api(app, u)('POST', `/api/agents/${a.agentId}/pause`)).statusCode).toBe(404);
  });
});

describe('files for member machines', () => {
  it('serves install.sh with the server URL substituted', async () => {
    const res = await app.inject({ method: 'GET', url: '/install.sh' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/x-shellscript; charset=utf-8');
    expect(res.body).toContain('SERVED_FROM_URL="http://localhost:8470"\n');
    expect(res.body.startsWith('#!')).toBe(true);
  });

  it('install.sh from a configured path; missing file is 404', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orch-m2-'));
    const file = join(dir, 'install.sh');
    writeFileSync(file, '#!/bin/sh\nSERVED_FROM_URL="__ORCH_SERVER_URL__"\necho ok\n');
    const a = makeApp(gh, {
      env: { ORCH_INSTALL_SH_PATH: file, ORCH_BASE_URL: 'https://orch.example.com/' },
    });
    const b = makeApp(gh, { env: { ORCH_INSTALL_SH_PATH: join(dir, 'missing.sh') } });
    try {
      const res = await a.inject({ method: 'GET', url: '/install.sh' });
      expect(res.body).toBe('#!/bin/sh\nSERVED_FROM_URL="https://orch.example.com"\necho ok\n');
      expect((await b.inject({ method: 'GET', url: '/install.sh' })).statusCode).toBe(404);
    } finally {
      await a.close();
      await b.close();
    }
  });

  it('serves the agent compose file', async () => {
    const res = await app.inject({ method: 'GET', url: '/agent/compose.yaml' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/yaml');
    expect(res.body).toContain('services:');
  });
});
