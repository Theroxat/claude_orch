/**
 * Notifications: audit events -> in-app rows, per-user preferences, external channels (Slack,
 * Discord, generic webhook, e-mail) with retries, the SSRF guard, and the REST API.
 * Agent helpers mirror failures.test.ts.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import WebSocket from 'ws';
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  EnrollResponseSchema,
  NotificationListResponseSchema,
  NotificationSettingsViewSchema,
  ProjectViewSchema,
  TaskViewSchema,
  agentMessage,
  type NotificationPreferences,
  type ServerMessage,
  type TaskView,
} from '@orch/shared';
import { audit } from '../src/audit';
import { signBody } from '../src/webhooks';
import { recipientCheck } from '../src/notifications/access';
import type { Mailer } from '../src/notifications/service';
import {
  guardedLookup,
  isPublicAddress,
  validateWebhookUrl,
  type PostResult,
} from '../src/notifications/ssrf';
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

interface Posted {
  url: string;
  body: Record<string, unknown>;
}
let posted: Posted[] = [];
/** Next responses of the fake webhook endpoint (default 200). */
let replies: Array<PostResult | Error> = [];
const post = vi.fn(async (url: string, body: unknown): Promise<PostResult> => {
  posted.push({ url, body: body as Record<string, unknown> });
  const r = replies.shift() ?? { ok: true, status: 200 };
  if (r instanceof Error) throw r;
  return r;
});
const mails: Array<{ to: string; subject: string; text: string; from: string }> = [];
const mailer: Mailer = {
  sendMail: async (m) => {
    mails.push(m);
    return {};
  },
};

const ADMIN = `admin-${uid()}`;

beforeAll(async () => {
  gh = new FakeGithub();
  app = makeApp(gh, {
    env: {
      DISPATCHER_ENABLED: 'true',
      DISPATCHER_INTERVAL_MS: '3600000',
      NOTIFY_RETRY_BASE_MS: '5',
      NOTIFY_MAX_ATTEMPTS: '3',
      ORCH_ADMIN_GITHUB_LOGINS: ADMIN,
      ORCH_ALLOW_ANY_GITHUB_USER: 'true',
    },
    notify: { post, mailer },
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  if (!addr || typeof addr === 'string') throw new Error('no address');
  wsUrl = `ws://127.0.0.1:${addr.port}/agent/ws`;
});
afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});
beforeEach(() => {
  posted = [];
  replies = [];
  mails.length = 0;
  post.mockClear();
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
  await app.notifier.idle();
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
  client.send(
    agentMessage('hello', {
      agentVersion: '0.4.0',
      capabilities: ['auto', 'manual'],
      localPaused: false,
      maxConcurrent: 1,
      running: [],
    }),
  );
  await client.next('welcome');
  await settle();
  const m = { user, agentId: enr.agentId, client };
  open.push(m);
  return m;
}

async function member(projectId: string, mode: 'AUTO' | 'APPROVAL' = 'AUTO'): Promise<Member> {
  const u = await loginAs(app, gh);
  await prisma.participation.create({
    data: { userId: u.userId, projectId, active: true, approvedAt: new Date(), percent: 50, mode },
  });
  const m = await onlineAgent(u);
  const now = Date.now();
  await prisma.usageReport.create({
    data: {
      agentId: m.agentId,
      userId: u.userId,
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
  return m;
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

async function createTask(u: TestUser, projectId: string, title = 'Notify me'): Promise<TaskView> {
  const res = await api(app, u)('POST', `/api/projects/${projectId}/tasks`, {
    title,
    body: 'Do it.',
    size: 'S',
  });
  expect(res.statusCode, res.body).toBe(201);
  const t = TaskViewSchema.parse(res.json());
  await settle();
  return t;
}

async function hook(event: string, payload: object) {
  const body = JSON.stringify(payload);
  return app.inject({
    method: 'POST',
    url: '/api/github/webhook',
    payload: body,
    headers: {
      'content-type': 'application/json',
      'x-github-event': event,
      'x-github-delivery': uid(),
      'x-hub-signature-256': signBody(TEST_WEBHOOK_SECRET, body),
    },
  });
}

const rows = (userId: string) =>
  prisma.notification.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } });
const events = async (userId: string) => (await rows(userId)).map((r) => r.event);

async function setPrefs(u: TestUser, over: Partial<NotificationPreferences>, extra: object = {}) {
  const res = await api(app, u)('PUT', '/api/notifications/settings', {
    preferences: { ...DEFAULT_NOTIFICATION_PREFERENCES, ...over },
    ...extra,
  });
  expect(res.statusCode, res.body).toBe(200);
  return NotificationSettingsViewSchema.parse(res.json());
}

/** Accepts the auto offer of `m` for `taskId` and marks it running. Returns the offer. */
async function startRun(m: Member, taskId: string) {
  const offer = await m.client.next(
    'task.offer',
    (o) => o.payload.kind === 'AUTO_OFFER' && o.payload.task.taskId === taskId,
  );
  const id = offer.payload.assignmentId;
  expect(
    (await m.client.call(agentMessage('offer.accept', { assignmentId: id, execMode: 'AUTO' }))).ok,
  ).toBe(true);
  await m.client.call(agentMessage('task.status', { assignmentId: id, seq: 1, state: 'running' }));
  return offer;
}

// ---------------------------------------------------------------------------

describe('task events become in-app notifications', { timeout: 20_000 }, () => {
  it('a failed run notifies the creator and the runner, not anyone else', async () => {
    const { owner, project: p } = await project();
    const m = await member(p.id);
    const bystander = await loginAs(app, gh);
    const t = await createTask(owner, p.id, 'Flaky thing');
    const offer = await startRun(m, t.id);
    await m.client.call(
      agentMessage('task.finished', {
        assignmentId: offer.payload.assignmentId,
        seq: 2,
        outcome: 'failed',
        usage: { weighted: 0, input: 0, output: 0 },
        error: 'tests failed',
      } as never),
    );
    await settle();
    for (const u of [owner, m.user]) {
      const [n] = await rows(u.userId);
      expect(n).toMatchObject({
        event: 'task_failed',
        title: 'Run failed: Flaky thing',
        taskId: t.id,
        projectId: p.id,
        url: `/backlog?task=${t.id}`,
      });
      expect(n!.body).toContain('tests failed');
      expect(n!.body).toContain(p.fullName);
    }
    expect(await rows(bystander.userId)).toHaveLength(0);
  });

  it('PR opened -> pr_review once (the webhook echo is ignored); merged -> task_done', async () => {
    const { owner, repo, project: p } = await project();
    const creator = await loginAs(app, gh);
    gh.roles.set(`4242:${repo.fullName}:${creator.login}`, 'WRITE');
    const m = await member(p.id);
    const t = await createTask(creator, p.id, 'Ship it');
    const offer = await startRun(m, t.id);
    const pushed = await m.client.call(
      agentMessage('task.pushed', {
        assignmentId: offer.payload.assignmentId,
        seq: 2,
        branch: offer.payload.task.branchName,
        headSha: 'abc123',
        changedFiles: 1,
        summary: 'done',
      }),
    );
    expect(pushed.ok).toBe(true);
    await settle();
    const prRow = await prisma.task.findUniqueOrThrow({ where: { id: t.id } });
    expect(await events(owner.userId)).toEqual(['pr_review']);
    expect(await events(creator.userId)).toEqual(['pr_review']);
    expect(await events(m.user.userId)).toEqual([]);
    expect((await rows(owner.userId))[0]!.url).toBe(prRow.prUrl);

    const pr = (merged: boolean) => ({
      number: prRow.prNumber,
      html_url: prRow.prUrl,
      merged,
      head: { ref: offer.payload.task.branchName, sha: 'abc123', repo: { id: repo.githubRepoId } },
      base: { ref: 'main' },
    });
    const repository = { id: repo.githubRepoId, full_name: repo.fullName };
    await hook('pull_request', { action: 'opened', pull_request: pr(false), repository });
    await settle();
    expect(await events(owner.userId)).toEqual(['pr_review']); // no duplicate
    const merged = await hook('pull_request', {
      action: 'closed',
      pull_request: pr(true),
      repository,
    });
    expect(merged.json()).toMatchObject({ result: 'done' });
    await settle();
    expect(await events(creator.userId)).toEqual(['pr_review', 'task_done']);
    expect(await events(m.user.userId)).toEqual(['task_done']); // the runner (assignee)
    expect(await events(owner.userId)).toEqual(['pr_review']); // owner is neither
  });

  it('a consent request notifies the APPROVAL-mode member it is offered to', async () => {
    const { owner, project: p } = await project();
    const m = await member(p.id, 'APPROVAL');
    const t = await createTask(owner, p.id, 'Please approve');
    await until(async () => (await events(m.user.userId)).includes('consent_request'));
    const [n] = await rows(m.user.userId);
    expect(n).toMatchObject({ taskId: t.id, url: '/requests' });
  });

  it('needs attention notifies the creator and the project owner', async () => {
    const { owner, project: p } = await project();
    const creator = await loginAs(app, gh);
    const t = await prisma.task.create({
      data: {
        projectId: p.id,
        githubIssueNumber: 7,
        githubIssueNodeId: `I_${uid()}`,
        title: 'Broken env',
        bodySnapshot: '',
        bodyHash: 'x',
        baseBranch: 'main',
        createdById: creator.userId,
      },
    });
    await audit(prisma, {
      actorType: 'SYSTEM',
      action: 'task.needs_attention',
      projectId: p.id,
      taskId: t.id,
      data: { envFailures: 3, reason: 'env file .env not found' },
    });
    await settle();
    for (const u of [owner, creator]) {
      expect((await rows(u.userId))[0]).toMatchObject({
        event: 'task_needs_attention',
        title: 'Needs attention: Broken env',
      });
    }
  });
});

describe('recipients who lost access', { timeout: 20_000 }, () => {
  it('a private repo: an ex-collaborator creator is not notified, the runner still is', async () => {
    const owner = await loginAs(app, gh);
    const repo = repoFor({ private: true });
    gh.repos.set(owner.token, [repo]);
    gh.roles.set(`4242:${repo.fullName}:${owner.login}`, 'ADMIN');
    const p = ProjectViewSchema.parse(
      (await api(app, owner)('POST', '/api/projects', { githubRepoId: repo.githubRepoId })).json(),
    );
    const creator = await loginAs(app, gh);
    gh.roles.set(`4242:${repo.fullName}:${creator.login}`, 'WRITE');
    const m = await member(p.id);
    // The runner can read the private repository (a participant without a GitHub role gets no
    // offer on a private repository with the default policy).
    gh.roles.set(`4242:${repo.fullName}:${m.user.login}`, 'READ');
    const t = await createTask(creator, p.id, 'Secret thing');
    // The creator is removed from the repository; the cached role expires.
    gh.roles.set(`4242:${repo.fullName}:${creator.login}`, 'NONE');
    await prisma.projectPermission.updateMany({
      where: { userId: creator.userId, projectId: p.id },
      data: { syncedAt: new Date(0) },
    });
    await setPrefs(creator, {}, { webhookUrl: 'https://hooks.example.com/creator' });
    const offer = await startRun(m, t.id);
    await m.client.call(
      agentMessage('task.finished', {
        assignmentId: offer.payload.assignmentId,
        seq: 2,
        outcome: 'failed',
        usage: { weighted: 0, input: 0, output: 0 },
        error: 'tests failed',
      } as never),
    );
    await settle();
    expect(await rows(creator.userId)).toHaveLength(0);
    expect(posted.filter((x) => x.url.includes('/creator'))).toHaveLength(0);
    // The runner still has its GitHub role and an active participation: its agent ran the code.
    expect(await events(m.user.userId)).toEqual(['task_failed']);
  });

  it('recipientCheck: refused by the allowlist, unknown user, public and private projects', async () => {
    const { owner, project: p } = await project();
    const outsider = await loginAs(app, gh);
    let allowed = true;
    const check = recipientCheck({ prisma, github: gh, isAllowed: async () => allowed });
    expect(await check(outsider.userId, null)).toBe(true);
    expect(await check(outsider.userId, p.id)).toBe(true); // public repo
    expect(await check('nobody', null)).toBe(false);
    allowed = false;
    expect(await check(owner.userId, p.id)).toBe(false);
    expect(await check(owner.userId, null)).toBe(false);
    allowed = true;
    await prisma.project.update({ where: { id: p.id }, data: { isPrivate: true } });
    expect(await check(outsider.userId, p.id)).toBe(false);
    await prisma.projectPermission.upsert({
      where: { projectId_userId: { projectId: p.id, userId: outsider.userId } },
      create: {
        projectId: p.id,
        userId: outsider.userId,
        githubRole: 'NONE',
        canSubmit: true,
        syncedAt: new Date(),
      },
      update: { canSubmit: true },
    });
    expect(await check(outsider.userId, p.id)).toBe(true); // owner override
  });
});

describe('owner and admin requests', () => {
  it('a participation request notifies the project owner once, not on every budget change', async () => {
    const { owner, repo, project: p } = await project();
    const joiner = await loginAs(app, gh);
    gh.roles.set(`4242:${repo.fullName}:${joiner.login}`, 'WRITE');
    const put = (budgetPercent: number) =>
      api(app, joiner)('PUT', `/api/projects/${p.id}/participation`, {
        participating: true,
        budgetPercent,
        mode: 'auto',
      });
    expect((await put(20)).json()).toMatchObject({ status: 'pending' });
    expect((await put(30)).statusCode).toBe(200);
    await settle();
    const list = await rows(owner.userId);
    expect(list.map((r) => r.event)).toEqual(['participation_request']);
    expect(list[0]!.title).toBe(`@${joiner.login} wants to join ${p.fullName}`);
    expect(await rows(joiner.userId)).toHaveLength(0);
  });

  it('an access request notifies the admins who have signed in', async () => {
    gh.users.set(`tok-${ADMIN}`, { id: 777_000_001, login: ADMIN, name: null, avatarUrl: null });
    const res = await app.inject({
      method: 'GET',
      url: `/api/auth/github/callback?code=${ADMIN}&state=s1`,
      headers: { cookie: 'orch_oauth_state=s1' },
    });
    expect(res.statusCode).toBe(302);
    const admin = await prisma.user.findUniqueOrThrow({ where: { login: ADMIN } });
    await audit(prisma, {
      actorType: 'SYSTEM',
      action: 'access.requested',
      data: { login: 'newcomer', grantId: 'g1' },
    });
    await settle();
    expect((await rows(admin.id)).at(-1)).toMatchObject({
      event: 'access_request',
      title: 'Access request from @newcomer',
      url: '/admin/access',
    });
  });
});

describe('preferences', () => {
  it('an event switched off creates nothing; other events still arrive', async () => {
    const { owner, project: p } = await project();
    await setPrefs(owner, { task_needs_attention: [] });
    const t = await createTask(owner, p.id, 'Quiet');
    await audit(prisma, {
      actorType: 'SYSTEM',
      action: 'task.needs_attention',
      projectId: p.id,
      taskId: t.id,
    });
    await audit(prisma, {
      actorType: 'GITHUB',
      action: 'task.in_review',
      projectId: p.id,
      taskId: t.id,
      data: { alreadyInReview: false },
    });
    await settle();
    expect(await events(owner.userId)).toEqual(['pr_review']);
  });

  it('external only: no in-app row, the webhook still gets it', async () => {
    const { owner, project: p } = await project();
    await setPrefs(
      owner,
      { task_needs_attention: ['webhook'] },
      { webhookUrl: 'https://hooks.example.com/orch' },
    );
    const t = await createTask(owner, p.id, 'Out of band');
    await audit(prisma, {
      actorType: 'SYSTEM',
      action: 'task.needs_attention',
      projectId: p.id,
      taskId: t.id,
    });
    await settle();
    expect(await rows(owner.userId)).toHaveLength(0);
    expect(posted).toHaveLength(1);
    expect(posted[0]!.url).toBe('https://hooks.example.com/orch');
  });

  it('settings round-trip: defaults, masked hints, clearing, unknown events rejected', async () => {
    const u = await loginAs(app, gh);
    const get = async () =>
      NotificationSettingsViewSchema.parse(
        (await api(app, u)('GET', '/api/notifications/settings')).json(),
      );
    const fresh = await get();
    expect(fresh.preferences).toEqual(DEFAULT_NOTIFICATION_PREFERENCES);
    expect(fresh.email).toEqual({ available: true, address: null, status: 'none' });
    expect(fresh.slack).toEqual({ configured: false, hint: null });

    const slack = 'https://hooks.slack.com/services/T000/B000/abcdefSECRETwxyz';
    const s = await setPrefs(u, {}, { slackWebhookUrl: slack, email: 'me@example.com' });
    expect(s.slack.configured).toBe(true);
    expect(s.slack.hint).toBe('https://hooks.slack.com/…wxyz');
    expect(JSON.stringify(s)).not.toContain('SECRET');
    const stored = await prisma.notificationSettings.findUniqueOrThrow({
      where: { userId: u.userId },
    });
    expect(Buffer.from(stored.slackUrlEnc!).toString('utf8')).not.toContain('SECRET');

    // Left out = kept; null = cleared.
    expect((await setPrefs(u, {}, {})).slack.configured).toBe(true);
    const cleared = await setPrefs(u, {}, { slackWebhookUrl: null, email: '' });
    expect(cleared.slack).toEqual({ configured: false, hint: null });
    expect(cleared.email.address).toBeNull();

    const bad = await api(app, u)('PUT', '/api/notifications/settings', {
      preferences: { ...DEFAULT_NOTIFICATION_PREFERENCES, nope: ['in_app'] },
    });
    expect(bad.statusCode).toBe(400);
  });
});

describe('SSRF guard', () => {
  it.each([
    'http://hooks.example.com/x',
    'https://127.0.0.1/x',
    'https://10.1.2.3/x',
    'https://172.16.0.1/x',
    'https://192.168.1.10/x',
    'https://169.254.169.254/latest/meta-data',
    'https://100.64.0.1/x',
    'https://0.0.0.0/x',
    'https://[::1]/x',
    'https://[fd00::1]/x',
    'https://[fe80::1]/x',
    'https://[::ffff:127.0.0.1]/x',
    'https://[::ffff:10.0.0.1]/x',
    'https://[::127.0.0.1]/x', // IPv4-compatible, normalised to ::7f00:1
    'https://[::a9fe:a9fe]/x',
    'https://[2002:7f00:1::]/x', // 6to4 of 127.0.0.1
    'https://[2001:0:4136:e378:8000:63bf:80ff:fffe]/x', // Teredo
    'https://2130706433/x', // decimal 127.0.0.1
    'https://0x7f.1/x',
    'https://017700000001/x', // octal
    'https://localhost/x',
    'https://foo.localhost/x',
    'https://printer.local/x',
    'https://metadata.google.internal/x',
    'https://intranet/x',
    'https://user:pass@hooks.example.com/x',
    'ftp://hooks.example.com/x',
    'not a url',
  ])('refuses %s', async (url) => {
    expect(() => validateWebhookUrl(url)).toThrow();
    const u = await loginAs(app, gh);
    const res = await api(app, u)('PUT', '/api/notifications/settings', { webhookUrl: url });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: 'invalid_webhook_url' } });
  });

  it('accepts public https URLs and public addresses', () => {
    expect(validateWebhookUrl('https://discord.com/api/webhooks/1/abc').hostname).toBe(
      'discord.com',
    );
    expect(validateWebhookUrl('https://93.184.216.34:8443/hook').port).toBe('8443');
    expect(isPublicAddress('8.8.8.8')).toBe(true);
    expect(isPublicAddress('2606:4700:4700::1111')).toBe(true);
    expect(isPublicAddress('127.0.0.1')).toBe(false);
    expect(isPublicAddress('::ffff:192.168.0.1')).toBe(false);
    expect(isPublicAddress('64:ff9b::a00:1')).toBe(false); // NAT64 of 10.0.0.1
  });

  it('refuses a public name that resolves to a private address at connection time', async () => {
    const lookup = (answers: Array<{ address: string; family: number }>) =>
      new Promise<{ err: NodeJS.ErrnoException | null; address: string }>((resolve) => {
        const fn = guardedLookup((_h, _o, cb) => cb(null, answers));
        fn('rebind.example.com', {}, (err, address) =>
          resolve({ err, address: address as string }),
        );
      });
    const bad = await lookup([
      { address: '93.184.216.34', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ]);
    expect(bad.err).toMatchObject({ code: 'ESSRF' });
    const ok = await lookup([{ address: '93.184.216.34', family: 4 }]);
    expect(ok).toEqual({ err: null, address: '93.184.216.34' });
  });
});

describe('external channels', () => {
  async function allChannels() {
    const { owner, project: p } = await project();
    await setPrefs(
      owner,
      { task_needs_attention: ['in_app', 'slack', 'discord', 'webhook', 'email'] },
      {
        slackWebhookUrl: 'https://hooks.slack.com/services/T/B/x',
        discordWebhookUrl: 'https://discord.com/api/webhooks/1/y',
        webhookUrl: 'https://hooks.example.com/z',
        email: 'owner@example.com',
      },
    );
    // The address must be confirmed before any mail goes to it.
    await prisma.notificationSettings.update({
      where: { userId: owner.userId },
      data: { emailVerifiedAt: new Date() },
    });
    mails.length = 0; // the confirmation e-mail is not under test here
    const t = await createTask(owner, p.id, 'Fix <setup> & go');
    return { owner, p, t };
  }
  const attention = (p: { id: string }, t: { id: string }) =>
    audit(prisma, {
      actorType: 'SYSTEM',
      action: 'task.needs_attention',
      projectId: p.id,
      taskId: t.id,
      data: { reason: 'env file .env not found' },
    });

  it('payload formats: Slack blocks, Discord embed, generic JSON, e-mail', async () => {
    const { owner, p, t } = await allChannels();
    await attention(p, t);
    await settle();
    const [row] = await rows(owner.userId);
    const link = `http://localhost:8470/backlog?task=${t.id}`;
    const by = (host: string) => posted.find((x) => x.url.includes(host))!.body;

    const slack = by('hooks.slack.com');
    expect(slack.text).toContain('Needs attention: Fix &lt;setup&gt; &amp; go');
    expect(slack.blocks).toEqual([
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: expect.stringMatching(
            /^\*<http:\/\/localhost:8470\/backlog\?task=\S+\|Needs attention: Fix &lt;setup&gt; &amp; go>\*\n/,
          ),
        },
      },
      { type: 'context', elements: [{ type: 'mrkdwn', text: 'orch · Needs attention' }] },
    ]);

    expect(by('discord.com')).toEqual({
      username: 'orch',
      allowed_mentions: { parse: [] },
      embeds: [
        {
          title: 'Needs attention: Fix <setup> & go',
          description: expect.stringContaining('env file .env not found'),
          url: link,
          color: expect.any(Number),
          timestamp: row!.createdAt.toISOString(),
          footer: { text: 'orch · Needs attention' },
        },
      ],
    });

    expect(by('hooks.example.com')).toEqual({
      version: 1,
      id: row!.id,
      event: 'task_needs_attention',
      title: 'Needs attention: Fix <setup> & go',
      body: row!.body,
      url: link,
      projectId: p.id,
      taskId: t.id,
      createdAt: row!.createdAt.toISOString(),
    });

    expect(mails).toHaveLength(1);
    expect(mails[0]).toMatchObject({
      to: 'owner@example.com',
      from: 'orch <orch@localhost>',
      subject: '[orch] Needs attention: Fix <setup> & go',
    });
    expect(mails[0]!.text).toContain(link);
    expect(mails[0]!.text).toContain('http://localhost:8470/my-server#notifications');
  });

  it('retries 5xx and network errors with backoff, gives up on 4xx, logs without the URL', async () => {
    const { owner, project: p } = await project();
    await setPrefs(
      owner,
      { task_needs_attention: ['webhook'] },
      { webhookUrl: 'https://hooks.example.com/retry-SECRET' },
    );
    const t = await createTask(owner, p.id, 'Retry me');

    replies = [
      { ok: false, status: 503 },
      Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }),
      { ok: true, status: 204 },
    ];
    await attention(p, t);
    await settle();
    expect(posted).toHaveLength(3); // 503, reset, then delivered

    posted = [];
    replies = [{ ok: false, status: 404 }];
    await attention(p, t);
    await settle();
    expect(posted).toHaveLength(1); // the hook is gone: no retry

    posted = [];
    replies = [
      { ok: false, status: 500 },
      { ok: false, status: 500 },
      { ok: false, status: 500 },
      { ok: false, status: 500 },
    ];
    await attention(p, t);
    await settle();
    expect(posted).toHaveLength(3); // NOTIFY_MAX_ATTEMPTS
  });

  it('a slow or failing channel never blocks the audited request', async () => {
    const { owner, repo, project: p } = await project();
    await setPrefs(
      owner,
      { participation_request: ['webhook'] },
      { webhookUrl: 'https://hooks.example.com/slow' },
    );
    let release!: () => void;
    post.mockImplementationOnce(async (url, body) => {
      posted.push({ url, body: body as Record<string, unknown> });
      await new Promise<void>((r) => (release = r));
      return { ok: true, status: 200 };
    });
    const joiner = await loginAs(app, gh);
    gh.roles.set(`4242:${repo.fullName}:${joiner.login}`, 'WRITE');
    const res = await api(app, joiner)('PUT', `/api/projects/${p.id}/participation`, {
      participating: true,
      budgetPercent: 10,
      mode: 'auto',
    });
    expect(res.statusCode).toBe(200); // answered while the webhook hangs
    await until(() => posted.length === 1);
    release();
    await settle();
  });
});

describe('REST API', () => {
  it('lists newest first with the unread count, marks read by id and all', async () => {
    const u = await loginAs(app, gh);
    const other = await loginAs(app, gh);
    for (const title of ['one', 'two', 'three']) {
      await prisma.notification.create({
        data: { userId: u.userId, event: 'task_done', title, body: 'b' },
      });
      await new Promise((r) => setTimeout(r, 5));
    }
    const theirs = await prisma.notification.create({
      data: { userId: other.userId, event: 'task_done', title: 'theirs', body: 'b' },
    });
    const list = NotificationListResponseSchema.parse(
      (await api(app, u)('GET', '/api/notifications?limit=2')).json(),
    );
    expect(list.items.map((i) => i.title)).toEqual(['three', 'two']);
    expect(list.unreadCount).toBe(3);

    const one = await api(app, u)('POST', '/api/notifications/read', {
      ids: [list.items[0]!.id, theirs.id],
    });
    expect(one.json()).toEqual({ unreadCount: 2 });
    // Someone else's notification is untouched.
    expect((await prisma.notification.findUniqueOrThrow({ where: { id: theirs.id } })).readAt).toBe(
      null,
    );
    expect((await api(app, u)('GET', '/api/notifications/unread-count')).json()).toEqual({
      unreadCount: 2,
    });
    expect((await api(app, u)('POST', '/api/notifications/read', { all: true })).json()).toEqual({
      unreadCount: 0,
    });
    expect((await api(app, u)('POST', '/api/notifications/read', {})).statusCode).toBe(400);
    expect((await api(app, null)('GET', '/api/notifications')).statusCode).toBe(401);
  });

  it('send test: in-app row, webhook result, not configured, rate limited', async () => {
    const u = await loginAs(app, gh);
    const test = (channel: string) =>
      api(app, u)('POST', '/api/notifications/test', { channel }).then((r) => ({
        status: r.statusCode,
        body: r.json() as unknown,
      }));
    expect(await test('in_app')).toEqual({ status: 200, body: { ok: true } });
    expect(await events(u.userId)).toEqual(['task_done']);
    expect(await test('discord')).toEqual({
      status: 200,
      body: { ok: false, error: 'not_configured' },
    });
    await setPrefs(u, {}, { discordWebhookUrl: 'https://discord.com/api/webhooks/9/z' });
    replies = [{ ok: false, status: 401 }];
    expect(await test('discord')).toEqual({ status: 200, body: { ok: false, error: 'HTTP 401' } });
    expect(await test('discord')).toEqual({ status: 200, body: { ok: true } });
    expect(posted.at(-1)!.body).toMatchObject({
      embeds: [{ title: 'Test notification from orch' }],
    });
    expect((await test('webhook')).body).toEqual({ ok: false, error: 'not_configured' });
    expect((await test('webhook')).status).toBe(429); // 5 per minute
  });
});
