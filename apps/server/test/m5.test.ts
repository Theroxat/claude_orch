import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import WebSocket from 'ws';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  CreatePersonalTokenResponseSchema,
  EnrollResponseSchema,
  MCP_TOOL_NAMES,
  OfferListResponseSchema,
  PersonalTokenListResponseSchema,
  ProjectViewSchema,
  agentMessage,
  type ServerMessage,
} from '@orch/shared';
import { sha256Hex } from '../src/auth/crypto';
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
  base = `http://127.0.0.1:${addr.port}`;
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

// ---------- agents ----------

class WsClient {
  readonly msgs: ServerMessage[] = [];
  constructor(readonly ws: WebSocket) {
    ws.on('message', (d) => this.msgs.push(JSON.parse(d.toString()) as ServerMessage));
  }
  send(m: unknown) {
    this.ws.send(JSON.stringify(m));
  }
  find<T extends ServerMessage['type']>(type: T): Array<Extract<ServerMessage, { type: T }>> {
    return this.msgs.filter((m): m is Extract<ServerMessage, { type: T }> => m.type === type);
  }
  async next<T extends ServerMessage['type']>(type: T) {
    await until(() => this.find(type).length > 0);
    return this.find(type)[0]!;
  }
}

interface Member {
  user: TestUser;
  agentId: string;
  client: WsClient;
}
let sockets: WsClient[] = [];
afterEach(() => {
  for (const c of sockets) c.ws.close();
  sockets = [];
});

async function onlineAgent(user: TestUser): Promise<Member> {
  const tok = (await api(app, user)('POST', '/api/agents/enrollment-tokens')).json() as {
    token: string;
  };
  const enr = EnrollResponseSchema.parse(
    (
      await app.inject({
        method: 'POST',
        url: '/api/agents/enroll',
        payload: { token: tok.token, machineName: 'laptop', agentVersion: '0.5.0' },
      })
    ).json(),
  );
  const ws = new WebSocket(`${base.replace('http', 'ws')}/agent/ws`, {
    headers: { authorization: `Bearer ${enr.credential}` },
  });
  const client = new WsClient(ws);
  sockets.push(client);
  await new Promise((r) => ws.once('open', r));
  client.send(
    agentMessage('hello', {
      agentVersion: '0.5.0',
      capabilities: ['auto', 'manual'],
      localPaused: false,
      maxConcurrent: 1,
      running: [],
    }),
  );
  await client.next('welcome');
  await settle();
  return { user, agentId: enr.agentId, client };
}

async function report(m: Member, projectId: string) {
  const now = Date.now();
  await prisma.usageReport.create({
    data: {
      agentId: m.agentId,
      userId: m.user.userId,
      reportedAt: new Date(now),
      windowStart: new Date(now - 3600_000),
      windowResetAt: new Date(now + 4 * 3600_000),
      inputTokens: 0n,
      outputTokens: 0n,
      cacheWriteTokens: 0n,
      cacheReadTokens: 0n,
      weightedTokens: 0n,
      byProject: { [projectId]: 0 },
      byModel: {},
      capacityEstimate: 1_000_000n,
      source: 'jsonl',
    },
  });
}

async function participate(u: TestUser, projectId: string, mode: 'AUTO' | 'APPROVAL' = 'AUTO') {
  await prisma.participation.create({
    data: { userId: u.userId, projectId, active: true, approvedAt: new Date(), percent: 50, mode },
  });
}

async function project() {
  const owner = await loginAs(app, gh);
  const repo = repoFor();
  gh.repos.set(owner.token, [repo]);
  const p = ProjectViewSchema.parse(
    (await api(app, owner)('POST', '/api/projects', { githubRepoId: repo.githubRepoId })).json(),
  );
  return { owner, repo, project: p };
}

/** A user with this GitHub role on the project's repo. */
async function withRole(fullName: string, role: 'WRITE' | 'READ') {
  const u = await loginAs(app, gh);
  gh.roles.set(`4242:${fullName}:${u.login}`, role);
  return u;
}

// ---------- tokens and MCP client ----------

async function createToken(u: TestUser, name = 'laptop') {
  const res = await api(app, u)('POST', '/api/tokens', { name });
  expect(res.statusCode, res.body).toBe(201);
  return CreatePersonalTokenResponseSchema.parse(res.json());
}

const mcps: McpClient[] = [];
afterEach(async () => {
  for (const c of mcps.splice(0)) await c.close();
});

async function mcpAs(u: TestUser): Promise<McpClient> {
  const { token } = await createToken(u);
  const client = new McpClient({ name: 'orch-test', version: '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  );
  mcps.push(client);
  return client;
}

interface ToolOut {
  isError: boolean;
  data: Record<string, unknown> & { error?: { code: string; message: string } };
}

async function call(c: McpClient, name: string, args: Record<string, unknown>): Promise<ToolOut> {
  const res = await c.callTool({ name, arguments: args });
  const content = res.content as Array<{ type: string; text: string }>;
  const text = content[0]!.text;
  let data: ToolOut['data'];
  try {
    data = JSON.parse(text) as ToolOut['data'];
  } catch {
    data = { error: { code: 'invalid_params', message: text } };
  }
  return { isError: res.isError === true, data };
}

const three = (over: Record<string, unknown> = {}) => [
  {
    ref: 'a',
    title: 'Add the parser',
    description: 'Write src/parser.ts.',
    acceptanceCriteria: ['parser tests pass'],
    size: 'S',
    model: 'sonnet',
    ...over,
  },
  {
    ref: 'b',
    title: 'Use the parser in the CLI',
    description: 'Wire the parser into the CLI.',
    acceptanceCriteria: ['cli test passes'],
    size: 'M',
    model: 'opus',
    dependsOn: ['a'],
  },
  {
    ref: 'c',
    title: 'Document the parser',
    description: 'Write docs/parser.md.',
    acceptanceCriteria: ['docs exist'],
    size: 'S',
    model: 'sonnet',
    dependsOn: ['a'],
  },
];

// ---------------------------------------------------------------------------

describe('personal access tokens', () => {
  it('creates a token shown once, stores only its hash, lists, revokes and audits', async () => {
    const u = await loginAs(app, gh);
    const created = await createToken(u, 'my laptop');
    expect(created.token).toMatch(/^orch_pat_[A-Za-z0-9_-]{40,}$/);
    expect(created.prefix).toBe(created.token.slice(0, 13));
    expect(created.scopes).toEqual(['mcp']);
    expect(created.mcpAddCommand).toBe(
      `claude mcp add --transport http --scope user orch http://localhost:8470/mcp --header "Authorization: Bearer ${created.token}"`,
    );
    const row = await prisma.personalToken.findUniqueOrThrow({ where: { id: created.id } });
    expect(row.tokenHash).toBe(sha256Hex(created.token));
    expect(JSON.stringify(row)).not.toContain(created.token);

    const list = PersonalTokenListResponseSchema.parse(
      (await api(app, u)('GET', '/api/tokens')).json(),
    );
    expect(list).toHaveLength(1);
    expect(JSON.stringify(list)).not.toContain(created.token);
    expect(list[0]).toMatchObject({ id: created.id, name: 'my laptop', lastUsedAt: null });

    // other users cannot see or revoke it
    const other = await loginAs(app, gh);
    expect((await api(app, other)('GET', '/api/tokens')).json()).toEqual([]);
    expect((await api(app, other)('DELETE', `/api/tokens/${created.id}`)).statusCode).toBe(404);

    expect((await api(app, u)('DELETE', `/api/tokens/${created.id}`)).statusCode).toBe(204);
    expect((await api(app, u)('DELETE', `/api/tokens/${created.id}`)).statusCode).toBe(204);
    const audits = await prisma.auditLog.findMany({
      where: { actorUserId: u.userId, action: { startsWith: 'token.' } },
      orderBy: { id: 'asc' },
    });
    expect(audits.map((a) => a.action)).toEqual(['token.created', 'token.revoked']);
    expect(JSON.stringify(audits.map((a) => a.data))).not.toContain(created.token);
    expect((await api(app, null)('POST', '/api/tokens', { name: 'x' })).statusCode).toBe(401);
  });

  it('records lastUsedAt on MCP use; revoked and expired tokens get 401', async () => {
    const u = await loginAs(app, gh);
    const created = await createToken(u);
    const init = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 't', version: '1' },
      },
    };
    const post = (token: string) =>
      app.inject({
        method: 'POST',
        url: '/mcp',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        payload: init,
      });
    const ok = await post(created.token);
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toMatchObject({ result: { serverInfo: { name: 'orch' } } });
    const row = await prisma.personalToken.findUniqueOrThrow({ where: { id: created.id } });
    expect(row.lastUsedAt).not.toBeNull();

    await api(app, u)('DELETE', `/api/tokens/${created.id}`);
    expect((await post(created.token)).statusCode).toBe(401);

    const expiring = await createToken(u, 'short');
    await prisma.personalToken.update({
      where: { id: expiring.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expect((await post(expiring.token)).statusCode).toBe(401);
  });
});

describe('MCP endpoint', () => {
  it('answers 401 without a valid bearer token, even with a session cookie', async () => {
    const u = await loginAs(app, gh);
    const body = { jsonrpc: '2.0', id: 1, method: 'tools/list' };
    for (const headers of [
      {},
      { authorization: 'Bearer orch_pat_nope' },
      { authorization: 'Basic abc' },
      { cookie: u.cookie },
    ]) {
      const res = await app.inject({ method: 'POST', url: '/mcp', headers, payload: body });
      expect(res.statusCode).toBe(401);
      expect(res.headers['www-authenticate']).toMatch(/^Bearer/);
    }
    expect((await app.inject({ method: 'GET', url: '/mcp' })).statusCode).toBe(401);
  });

  it('tools/list returns the five tools with input schemas', async () => {
    const c = await mcpAs(await loginAs(app, gh));
    const { tools } = await c.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...MCP_TOOL_NAMES].sort());
    const submit = tools.find((t) => t.name === 'submit_task')!;
    expect(submit.description).toMatch(/SMALL, INDEPENDENT subtasks/);
    expect(submit.description).toMatch(/acceptance criteria/);
    expect(submit.inputSchema.required).toEqual(
      expect.arrayContaining(['projectFullName', 'tasks']),
    );
  });

  it('rejects invalid tool input (schema validation)', async () => {
    const { owner, project: p } = await project();
    const c = await mcpAs(owner);
    const r = await call(c, 'submit_task', {
      projectFullName: p.fullName,
      tasks: [{ ref: 'a', title: 'x', size: 'XL' }],
    });
    expect(r.isError).toBe(true);
    expect(gh.createdIssues.filter((i) => i.fullName === p.fullName)).toHaveLength(0);
  });
});

describe('submit_task', () => {
  it('creates 3 subtasks with their dependencies, issue metadata and the integration branch', async () => {
    const { owner, project: p } = await project();
    const c = await mcpAs(owner);
    const r = await call(c, 'submit_task', {
      projectFullName: p.fullName,
      integrationBranch: 'feat/parser',
      tasks: three(),
    });
    expect(r.isError, JSON.stringify(r.data)).toBe(false);
    const out = r.data as {
      created: number;
      branchCreated: boolean;
      tasks: Array<{
        ref: string;
        issueNumber: number;
        issueUrl: string;
        status: string;
        dependsOn: number[];
      }>;
    };
    expect(out.created).toBe(3);
    expect(out.branchCreated).toBe(true);
    expect(gh.createdBranches).toContainEqual({
      fullName: p.fullName,
      branch: 'feat/parser',
      sha: `sha-main-${p.fullName}`,
    });
    const [a, b, cc] = out.tasks;
    expect(a).toMatchObject({ ref: 'a', status: 'TODO', dependsOn: [] });
    expect(b).toMatchObject({ ref: 'b', status: 'BLOCKED', dependsOn: [a!.issueNumber] });
    expect(cc).toMatchObject({ ref: 'c', status: 'BLOCKED', dependsOn: [a!.issueNumber] });
    expect(a!.issueUrl).toBe(`https://github.com/${p.fullName}/issues/${a!.issueNumber}`);

    const rows = await prisma.task.findMany({
      where: { projectId: p.id },
      include: { dependsOn: { include: { dependsOn: true } } },
      orderBy: { githubIssueNumber: 'asc' },
    });
    expect(rows).toHaveLength(3);
    for (const t of rows) {
      expect(t).toMatchObject({
        origin: 'MCP',
        status: 'TODO',
        integrationBranch: 'feat/parser',
        createdById: owner.userId,
      });
    }
    const byNumber = new Map(rows.map((t) => [t.githubIssueNumber, t]));
    expect(byNumber.get(b!.issueNumber)!.model).toBe('OPUS');
    expect(
      byNumber.get(b!.issueNumber)!.dependsOn.map((d) => d.dependsOn.githubIssueNumber),
    ).toEqual([a!.issueNumber]);
    // a's issue was created first; dependents carry its number in the hidden metadata block
    const issueB = gh.createdIssues.find(
      (i) => i.fullName === p.fullName && i.number === b!.issueNumber,
    )!;
    expect(issueB.body).toContain('Wire the parser into the CLI.');
    expect(issueB.body).toContain(`"dependsOn":[${a!.issueNumber}]`);
    expect(issueB.labels).toEqual(['pool']);
    const audits = await prisma.auditLog.findMany({ where: { projectId: p.id } });
    expect(audits.filter((x) => x.action === 'task.created')).toHaveLength(3);
    expect(audits.some((x) => x.action === 'task.batch_submitted')).toBe(true);

    // an existing issue number as a dependency, and an existing integration branch
    const again = await call(c, 'submit_task', {
      projectFullName: p.fullName,
      integrationBranch: 'feat/parser',
      tasks: [{ ...three()[0], ref: 'd', dependsOn: [`#${cc!.issueNumber}`] }],
    });
    expect(again.isError, JSON.stringify(again.data)).toBe(false);
    expect(again.data).toMatchObject({ branchCreated: false });
    expect((again.data.tasks as Array<{ dependsOn: number[] }>)[0]!.dependsOn).toEqual([
      cc!.issueNumber,
    ]);
  });

  it('rejects cycles and unknown dependencies before creating anything', async () => {
    const { owner, project: p } = await project();
    const c = await mcpAs(owner);
    const cyc = three();
    cyc[0] = { ...cyc[0]!, dependsOn: ['c'] } as (typeof cyc)[0];
    const r = await call(c, 'submit_task', { projectFullName: p.fullName, tasks: cyc });
    expect(r).toMatchObject({ isError: true, data: { error: { code: 'dependency_cycle' } } });
    expect(r.data.error!.message).toMatch(/cycle: a, b, c/);
    const self = await call(c, 'submit_task', {
      projectFullName: p.fullName,
      tasks: [{ ...three()[0], dependsOn: ['a'] }],
    });
    expect(self.data.error?.code).toBe('dependency_cycle');
    const unknown = await call(c, 'submit_task', {
      projectFullName: p.fullName,
      tasks: [{ ...three()[0], dependsOn: ['zz'] }],
    });
    expect(unknown.data.error?.code).toBe('unknown_dependency');
    const missingIssue = await call(c, 'submit_task', {
      projectFullName: p.fullName,
      tasks: [{ ...three()[0], dependsOn: [9999] }],
    });
    expect(missingIssue.data.error?.code).toBe('invalid_dependency');
    expect(gh.createdIssues.filter((i) => i.fullName === p.fullName)).toHaveLength(0);
    expect(await prisma.task.count({ where: { projectId: p.id } })).toBe(0);
  });

  it('read-only collaborators create PROPOSED tasks', async () => {
    const { project: p } = await project();
    const reader = await withRole(p.fullName, 'READ');
    const c = await mcpAs(reader);
    const r = await call(c, 'submit_task', { projectFullName: p.fullName, tasks: three() });
    expect(r.isError, JSON.stringify(r.data)).toBe(false);
    expect(r.data.note).toMatch(/PROPOSED/);
    const rows = await prisma.task.findMany({ where: { projectId: p.id } });
    expect(rows.map((t) => t.status)).toEqual(['PROPOSED', 'PROPOSED', 'PROPOSED']);
    // strangers see nothing
    const stranger = await mcpAs(await loginAs(app, gh));
    const s = await call(stranger, 'submit_task', { projectFullName: p.fullName, tasks: three() });
    expect(s.data.error?.code).toBe('not_found');
  });

  it('respects the pending-task limit for the whole batch', async () => {
    const { owner, project: p } = await project();
    await prisma.user.update({ where: { id: owner.userId }, data: { maxPendingTasks: 2 } });
    const c = await mcpAs(owner);
    const r = await call(c, 'submit_task', { projectFullName: p.fullName, tasks: three() });
    expect(r.data.error?.code).toBe('pending_limit');
    expect(gh.createdIssues.filter((i) => i.fullName === p.fullName)).toHaveLength(0);
    const two = await call(c, 'submit_task', {
      projectFullName: p.fullName,
      tasks: three().slice(0, 1),
    });
    expect(two.isError).toBe(false);
  });

  it('rolls back when GitHub fails midway: created issues are closed, no task is stored', async () => {
    const { owner, project: p } = await project();
    const c = await mcpAs(owner);
    gh.failCreateIssueAfter = gh.createdIssues.length + 2;
    try {
      const r = await call(c, 'submit_task', { projectFullName: p.fullName, tasks: three() });
      expect(r.data.error?.code).toBe('github_error');
    } finally {
      gh.failCreateIssueAfter = null;
    }
    const created = gh.createdIssues.filter((i) => i.fullName === p.fullName);
    expect(created).toHaveLength(2);
    expect(gh.closedIssues.filter((i) => i.fullName === p.fullName)).toEqual(
      created.map((i) => ({ fullName: p.fullName, number: i.number, labels: ['orch-aborted'] })),
    );
    expect(await prisma.task.count({ where: { projectId: p.id } })).toBe(0);
    expect(
      await prisma.auditLog.count({ where: { projectId: p.id, action: 'task.batch_aborted' } }),
    ).toBe(1);
  });

  it('broadcast is denied to a non-owner and allowed to the owner', async () => {
    const { owner, project: p } = await project();
    const writer = await withRole(p.fullName, 'WRITE');
    const w = await call(await mcpAs(writer), 'submit_task', {
      projectFullName: p.fullName,
      tasks: three().slice(0, 1),
      dispatch: { mode: 'broadcast' },
    });
    expect(w.data.error?.code).toBe('forbidden');
    expect(gh.createdIssues.filter((i) => i.fullName === p.fullName)).toHaveLength(0);
    const o = await call(await mcpAs(owner), 'submit_task', {
      projectFullName: p.fullName,
      tasks: three().slice(0, 1),
      dispatch: { mode: 'broadcast' },
    });
    expect(o.isError, JSON.stringify(o.data)).toBe(false);
    expect((await prisma.task.findFirstOrThrow({ where: { projectId: p.id } })).dispatchMode).toBe(
      'BROADCAST',
    );
  });

  it('keeps consent rules: an approval-mode target gets a request, never an auto offer', async () => {
    const { owner, project: p } = await project();
    const appr = await loginAs(app, gh);
    await participate(appr, p.id, 'APPROVAL');
    const m = await onlineAgent(appr);
    await report(m, p.id);
    const c = await mcpAs(owner);
    const bad = await call(c, 'submit_task', {
      projectFullName: p.fullName,
      tasks: three().slice(0, 1),
      dispatch: { mode: 'members', members: ['nobody-here'] },
    });
    expect(bad.data.error?.code).toBe('invalid_member');
    const r = await call(c, 'submit_task', {
      projectFullName: p.fullName,
      tasks: three().slice(0, 1),
      dispatch: { mode: 'members', members: [appr.login] },
    });
    expect(r.isError, JSON.stringify(r.data)).toBe(false);
    await settle();
    await until(() => m.client.find('offer.request').length > 0);
    expect(m.client.find('task.offer')).toHaveLength(0);
    const rows = await prisma.assignment.findMany({ where: { userId: appr.userId } });
    expect(rows.map((a) => a.kind)).toEqual(['CONSENT_REQUEST']);

    // /api/offers/mine lists only that request, with who asked for it
    const mine = OfferListResponseSchema.parse(
      (await api(app, appr)('GET', '/api/offers/mine')).json(),
    );
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({
      kind: 'CONSENT_REQUEST',
      requestedBy: { githubLogin: owner.login },
    });
  });

  it('/api/offers/mine never lists auto offers', async () => {
    const { owner, project: p } = await project();
    const auto = await loginAs(app, gh);
    await participate(auto, p.id, 'AUTO');
    const m = await onlineAgent(auto);
    await report(m, p.id);
    const r = await call(await mcpAs(owner), 'submit_task', {
      projectFullName: p.fullName,
      tasks: three().slice(0, 1),
    });
    expect(r.isError).toBe(false);
    await settle();
    await until(() => m.client.find('task.offer').length > 0);
    expect(m.client.find('task.offer')[0]!.payload.kind).toBe('AUTO_OFFER');
    expect((await api(app, auto)('GET', '/api/offers/mine')).json()).toEqual([]);
  });
});

describe('take_task, task_status, view_pool, list_tasks', () => {
  async function setup() {
    const { owner, project: p } = await project();
    const r = await call(await mcpAs(owner), 'submit_task', {
      projectFullName: p.fullName,
      tasks: three(),
      dispatch: { mode: 'members', members: [] },
    });
    // members:[] is invalid; fall back to a plain submission the dispatcher will not place
    expect(r.data.error?.code).toBe('invalid_member');
    const ok = await call(await mcpAs(owner), 'submit_task', {
      projectFullName: p.fullName,
      tasks: three(),
    });
    expect(ok.isError, JSON.stringify(ok.data)).toBe(false);
    const numbers = (ok.data.tasks as Array<{ issueNumber: number }>).map((t) => t.issueNumber);
    return { owner, p, numbers };
  }

  it('take_task fails offline, paused or not participating, then claims for the online agent', async () => {
    const { p, numbers } = await setup();
    const [a, b] = numbers as [number, number];
    const u = await loginAs(app, gh);
    const c = await mcpAs(u);
    const take = (n: number) =>
      call(c, 'take_task', { projectFullName: p.fullName, issueNumber: n });

    // not visible / not participating
    expect((await take(a)).data.error?.code).toBe('not_found');
    await participate(u, p.id, 'APPROVAL');
    // offline
    expect((await take(a)).data.error?.code).toBe('no_agent_online');
    const m = await onlineAgent(u);
    // paused
    await api(app, u)('POST', `/api/agents/${m.agentId}/pause`);
    expect((await take(a)).data.error?.code).toBe('paused');
    await api(app, u)('POST', `/api/agents/${m.agentId}/resume`);
    // blocked by its dependency
    expect((await take(b)).data.error?.code).toBe('dependencies_unmet');

    const r = await take(a);
    expect(r.isError, JSON.stringify(r.data)).toBe(false);
    expect(r.data).toMatchObject({
      issueNumber: a,
      machine: 'laptop',
      attachCommand: `docker compose -f ~/orch/compose.yaml exec agent screen -r issue-${a}`,
    });
    const offer = await m.client.next('task.offer');
    expect(offer.replyTo).toBeUndefined();
    expect(offer.payload).toMatchObject({
      assignmentId: r.data.assignmentId,
      kind: 'CLAIM',
      initiatedBy: 'server',
      execMode: 'MANUAL',
      accepted: true,
      expiresAt: null,
      task: { issueNumber: a, baseBranch: 'main' },
    });
    const task = await prisma.task.findFirstOrThrow({
      where: { projectId: p.id, githubIssueNumber: a },
    });
    expect(task).toMatchObject({
      status: 'IN_PROGRESS',
      assigneeId: u.userId,
      assigneeAgentId: m.agentId,
    });
    // the agent's answer keeps working through the existing path
    const ack = agentMessage('offer.accept', {
      assignmentId: offer.payload.assignmentId,
      execMode: 'MANUAL',
    });
    m.client.send(ack);
    await until(() => m.client.find('ack').some((x) => x.replyTo === ack.id));
    expect(m.client.find('ack').find((x) => x.replyTo === ack.id)!.payload.ok).toBe(true);
    // the machine is busy now (same claim rules as orch take)
    expect((await take(a)).data.error?.code).toBe('max_concurrency');

    // task_status
    const s = await call(c, 'task_status', { projectFullName: p.fullName, issueNumber: a });
    expect(s.isError, JSON.stringify(s.data)).toBe(false);
    expect(s.data).toMatchObject({
      issueNumber: a,
      status: 'IN_PROGRESS',
      assignee: u.login,
      machine: 'laptop',
      prUrl: null,
      dependsOn: [],
    });
    expect(s.data.attempts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'CLAIM',
          status: 'ACCEPTED',
          execMode: 'MANUAL',
          member: u.login,
        }),
      ]),
    );
    expect(typeof s.data.createdAt).toBe('string');
    const sb = await call(c, 'task_status', { projectFullName: p.fullName, issueNumber: b });
    expect(sb.data).toMatchObject({
      status: 'BLOCKED',
      dependsOn: [{ issueNumber: a, status: 'IN_PROGRESS' }],
    });
    const missing = await call(c, 'task_status', { projectFullName: p.fullName, issueNumber: 999 });
    expect(missing.data.error?.code).toBe('not_found');
  });

  it("view_pool and list_tasks show the caller's projects", async () => {
    const { owner, p, numbers } = await setup();
    const u = await loginAs(app, gh);
    await participate(u, p.id, 'AUTO');
    const m = await onlineAgent(u);
    await report(m, p.id);
    const c = await mcpAs(owner);
    const pool = await call(c, 'view_pool', { projectFullName: p.fullName });
    expect(pool.isError, JSON.stringify(pool.data)).toBe(false);
    expect(pool.data.note).toMatch(/ESTIMATES/);
    expect(pool.data.estimate).toBe(true);
    const members = pool.data.members as Array<{
      login: string;
      online: boolean;
      projects: Array<{ mode: string; estimatedMargin: number | null }>;
    }>;
    const row = members.find((x) => x.login === u.login)!;
    expect(row.online).toBe(true);
    expect(row.projects[0]!.mode).toBe('AUTO');
    expect(row.projects[0]!.estimatedMargin).not.toBeNull();

    const list = await call(c, 'list_tasks', { projectFullName: p.fullName, status: 'BLOCKED' });
    expect(list.isError, JSON.stringify(list.data)).toBe(false);
    expect(
      (list.data.tasks as Array<{ issueNumber: number }>).map((t) => t.issueNumber).sort(),
    ).toEqual(numbers.slice(1).sort());
    const all = await call(c, 'list_tasks', {});
    expect((all.data.tasks as unknown[]).length).toBeGreaterThanOrEqual(3);

    const stranger = await mcpAs(await loginAs(app, gh));
    expect(
      (await call(stranger, 'view_pool', { projectFullName: p.fullName })).data.error?.code,
    ).toBe('not_found');
    expect(
      (await call(stranger, 'list_tasks', { projectFullName: p.fullName })).data.error?.code,
    ).toBe('not_found');
    void owner;
  });
});
