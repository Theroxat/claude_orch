/**
 * Seeded dispatcher scenarios (projects, members, agents, usage, tasks and their history) written
 * straight into the test database, plus a fake gateway and a query counter. Shared by the
 * characterization test (old vs new dispatcher) and the tick benchmark.
 */
import { randomBytes } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import { Prisma, PrismaClient as RawPrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import type { TaskOfferPayload } from '@orch/shared';
import { OfferRefusedError, type AgentGateway } from '../../src/agents/gateway';
import { loadConfig, type Config } from '../../src/config';
import type { PrismaClient } from '../../src/db';

/** mulberry32: small, fast, deterministic. */
export function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    chance: (p: number) => next() < p,
    int: (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1)),
    pick: <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)]!,
  };
}
export type Rng = ReturnType<typeof rng>;

/** A Prisma client that counts the SQL statements it sends (Prisma `query` log events). */
export function countingPrisma(url: string) {
  const client = new RawPrismaClient({
    adapter: new PrismaPg({ connectionString: url }),
    log: [{ emit: 'event', level: 'query' }],
  });
  const counter = { n: 0, log: [] as string[] };
  client.$on('query', (e) => {
    counter.n++;
    if (process.env.DISPATCH_LOG_QUERIES) counter.log.push(e.query.slice(0, 160));
  });
  return { prisma: client as unknown as PrismaClient, counter };
}

export function dispatcherConfig(over: Record<string, string> = {}): Config {
  return loadConfig({ DATABASE_URL: 'postgresql://unused', LOG_LEVEL: 'silent', ...over });
}

/** Logger that keeps errors (a failed dispatch must fail the test). */
export function captureLog() {
  const errors: unknown[] = [];
  const noop = () => {};
  const log = {
    error: (o: unknown) => errors.push(o),
    warn: noop,
    info: noop,
    debug: noop,
    trace: noop,
    fatal: noop,
    child() {
      return log;
    },
  };
  return { log: log as unknown as FastifyBaseLogger, errors };
}

const hash = (s: string) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
};

/** The part of AgentGateway the dispatcher's tick uses, with deterministic behaviour. */
export class FakeGateway {
  /** agentId -> owner and announced concurrency. */
  readonly connected = new Map<string, { userId: string; max: number }>();
  /** Members whose access is refused (`ownerAllowed` false). */
  readonly denied = new Set<string>();
  /** Every n-th (agent, task) pair refuses the offer (0 = never). */
  refuseEvery = 0;
  readonly sent: string[] = [];

  isConnected(agentId: string) {
    return this.connected.has(agentId);
  }
  connectedUserIds() {
    return [...new Set([...this.connected.values()].map((c) => c.userId))];
  }
  maxConcurrentOf(agentId: string) {
    return this.connected.get(agentId)?.max ?? 1;
  }
  async ownerAllowed(user: { id: string }) {
    return !this.denied.has(user.id);
  }
  async sendOffer(agentId: string, payload: TaskOfferPayload) {
    if (this.refuseEvery > 0 && hash(`${agentId}:${payload.task.taskId}`) % this.refuseEvery === 0)
      throw new OfferRefusedError('offline');
    this.sent.push(`offer ${agentId} ${payload.task.taskId}`);
  }
  sendTo() {
    return true;
  }
  sendToUser(userId: string, msg: { type: string; payload?: unknown }) {
    const p = msg.payload as { task?: { taskId?: string } } | undefined;
    this.sent.push(`${msg.type} ${userId} ${p?.task?.taskId ?? ''}`);
    return 1;
  }
  asGateway() {
    return this as unknown as AgentGateway;
  }
}

export interface ScenarioShape {
  projects: number;
  members: number;
  /** TODO tasks per project. */
  tasksPerProject: number;
  /** Probability that a member participates in a project. */
  participation: number;
}

export interface Scenario {
  tag: string;
  now: Date;
  gateway: FakeGateway;
  userIds: string[];
  projectIds: string[];
  taskIds: string[];
}

const SIZES = ['S', 'M', 'L'] as const;
const MODELS = ['SONNET', 'OPUS'] as const;
const H = 3600_000;

/**
 * Seeds one scenario. `wild` turns on every edge case (pauses, revoked agents, stale or missing
 * usage, rate limits, pending approvals, targets, broadcast, dependencies, history...); without
 * it the scenario is a plain busy pool (used by the benchmark).
 */
export async function seedScenario(
  prisma: PrismaClient,
  r: Rng,
  shape: ScenarioShape,
  opts: { wild: boolean; now?: Date },
): Promise<Scenario> {
  const now = opts.now ?? new Date();
  const tag = randomBytes(5).toString('hex');
  const wild = opts.wild;
  const ago = (ms: number) => new Date(now.getTime() - ms);
  const gateway = new FakeGateway();
  if (wild) gateway.refuseEvery = 7;

  // ---- members, agents ----
  const userIds: string[] = [];
  const users: Prisma.UserCreateManyInput[] = [];
  const agents: Prisma.AgentCreateManyInput[] = [];
  for (let i = 0; i < shape.members; i++) {
    const id = `u_${tag}_${i}`;
    userIds.push(id);
    users.push({
      id,
      githubId: BigInt(hash(id)) * 1000n + BigInt(r.int(0, 999)),
      login: `m-${tag}-${i}`,
      paused: wild && r.chance(0.08),
      maxConcurrent: wild ? r.int(1, 3) : 2,
    });
    const nAgents = wild ? (r.chance(0.1) ? 0 : r.int(1, 2)) : 1;
    for (let k = 0; k < nAgents; k++) {
      const agentId = `agt_${tag}_${i}_${k}`;
      agents.push({
        id: agentId,
        userId: id,
        name: `box-${k}`,
        secretHash: agentId,
        secretPrefix: 'abcdef',
        lastSeenAt: now,
        paused: wild && r.chance(0.12),
        revokedAt: wild && r.chance(0.08) ? ago(H) : null,
        claudeAuthValid: !wild || r.chance(0.88),
      });
      if (!wild || r.chance(0.9)) {
        gateway.connected.set(agentId, { userId: id, max: wild ? r.int(1, 2) : 2 });
      }
    }
    if (wild && r.chance(0.05)) gateway.denied.add(id);
  }
  await prisma.user.createMany({ data: users });
  await prisma.agent.createMany({ data: agents });

  // ---- projects, participations ----
  const installs = [`ins_${tag}_ok`, `ins_${tag}_suspended`];
  await prisma.installation.createMany({
    data: installs.map((id, k) => ({
      id,
      githubInstallationId: BigInt(hash(id)) * 10n + BigInt(k),
      accountLogin: 'acme',
      accountType: 'Organization',
      suspendedAt: k === 1 ? ago(H) : null,
    })),
  });
  const projectIds: string[] = [];
  const projects: Prisma.ProjectCreateManyInput[] = [];
  for (let j = 0; j < shape.projects; j++) {
    const id = `p_${tag}_${j}`;
    projectIds.push(id);
    projects.push({
      id,
      githubRepoId: BigInt(hash(id)) * 1000n + BigInt(j),
      fullName: `acme/${tag}-${j}`,
      installationId: wild && r.chance(0.06) ? installs[1]! : installs[0]!,
      defaultBranch: 'main',
      isPrivate: wild && r.chance(0.5),
      requireParticipantApproval: wild && r.chance(0.5),
      sizeBudgets: wild && r.chance(0.3) ? { S: 3000, M: 9000, L: 20000 } : Prisma.DbNull,
      addedById: r.pick(userIds),
      archivedAt: wild && r.chance(0.05) ? ago(H) : null,
    });
  }
  await prisma.project.createMany({ data: projects });
  const parts: Prisma.ParticipationCreateManyInput[] = [];
  const partsByProject = new Map<string, string[]>();
  for (const projectId of projectIds) {
    for (const userId of userIds) {
      if (!r.chance(shape.participation)) continue;
      const approved = !wild || r.chance(0.8);
      parts.push({
        userId,
        projectId,
        active: !wild || r.chance(0.9),
        approvedAt: approved ? ago(r.int(1, 48) * H) : null,
        rejectedAt: wild && !approved && r.chance(0.3) ? ago(H) : null,
        percent: wild ? r.pick([5, 25, 50, 100, 100]) : 30,
        mode: wild ? (r.chance(0.7) ? 'AUTO' : 'APPROVAL') : 'AUTO',
        allowedModels: wild
          ? r
              .pick([
                ['SONNET', 'OPUS'],
                ['SONNET', 'OPUS'],
                ['SONNET', 'OPUS'],
                ['SONNET'],
                ['OPUS'],
              ] as const)
              .slice()
          : ['SONNET', 'OPUS'],
        createdAt: ago(r.int(1, 1000) * 60_000),
        updatedAt: ago(r.int(0, 120) * 60_000),
      });
      partsByProject.set(projectId, [...(partsByProject.get(projectId) ?? []), userId]);
    }
  }
  await prisma.participation.createMany({ data: parts });

  // ---- usage reports (a stale one first, then the latest) ----
  const reports: Prisma.UsageReportCreateManyInput[] = [];
  for (const userId of userIds) {
    const agent = agents.find((a) => a.userId === userId);
    if (!agent) continue;
    if (wild && r.chance(0.12)) continue; // never reported
    const report = (reportedAt: Date, latest: boolean): Prisma.UsageReportCreateManyInput => {
      const capacity =
        wild && latest && r.chance(0.08) ? null : r.pick([300_000, 1_000_000, 2_000_000]);
      const byProject: Record<string, number> = {};
      for (const p of projectIds)
        if (r.chance(0.5)) byProject[p] = r.int(0, wild ? 30_000 : 10_000);
      if (r.chance(0.5)) byProject.personal = r.int(0, 50_000);
      const windowOver = wild && r.chance(0.1);
      return {
        agentId: agent.id,
        userId,
        reportedAt,
        windowStart: r.chance(0.9) ? ago(r.int(1, 4) * H) : null,
        windowResetAt: windowOver ? ago(60_000) : new Date(now.getTime() + r.int(1, 4) * H),
        inputTokens: 0n,
        outputTokens: 0n,
        cacheWriteTokens: 0n,
        cacheReadTokens: 0n,
        weightedTokens: BigInt(r.int(0, wild ? 150_000 : 50_000)),
        byProject,
        byModel: {},
        capacityEstimate: capacity === null ? null : BigInt(capacity),
        rateLimitedUntil: wild && latest && r.chance(0.08) ? new Date(now.getTime() + H) : null,
        source: 'jsonl',
      };
    };
    reports.push(report(ago(40 * 60_000), false));
    const stale = wild && r.chance(0.1);
    reports.push(report(ago(stale ? 20 * 60_000 : r.int(0, 5) * 60_000), true));
  }
  await prisma.usageReport.createMany({ data: reports });

  // ---- tasks ----
  const tasks: Prisma.TaskCreateManyInput[] = [];
  const targets: Prisma.TaskTargetCreateManyInput[] = [];
  const todo: Array<{ id: string; projectId: string }> = [];
  const others: Array<{ id: string; projectId: string; status: string }> = [];
  let issue = 0;
  let created = 0;
  const task = (projectId: string, status: Prisma.TaskCreateManyInput['status'], extra = {}) => {
    const id = `t_${tag}_${issue}`;
    const createdAt = new Date(now.getTime() - 10 * H + created++ * 1000);
    tasks.push({
      id,
      projectId,
      githubIssueNumber: ++issue,
      githubIssueNodeId: `I_${id}`,
      title: `Task ${issue}`,
      bodySnapshot: 'Do it.',
      bodyHash: 'h',
      baseBranch: 'main',
      size: r.pick(SIZES),
      model: wild ? r.pick(MODELS) : 'SONNET',
      status,
      createdById: r.pick(userIds),
      createdAt,
      ...extra,
    });
    return id;
  };
  for (const projectId of projectIds) {
    // Finished work: medians and in-window usage; running work: slots and reservations.
    for (let k = 0; k < (wild ? r.int(0, 3) : 1); k++) {
      others.push({ id: task(projectId, 'DONE'), projectId, status: 'DONE' });
    }
    for (let k = 0; k < (wild ? r.int(0, 3) : 1); k++) {
      const status = r.pick(['IN_PROGRESS', 'IN_REVIEW'] as const);
      others.push({ id: task(projectId, status), projectId, status });
    }
    for (let k = 0; k < shape.tasksPerProject; k++) {
      const members = partsByProject.get(projectId) ?? [];
      const mode = wild
        ? r.pick(['POOL', 'POOL', 'POOL', 'MEMBERS', 'BROADCAST'] as const)
        : 'POOL';
      const id = task(projectId, wild && r.chance(0.05) ? 'IN_REVIEW' : 'TODO', {
        dispatchMode: mode,
        needsAttention: wild && r.chance(0.05),
        retryResetAt: wild && r.chance(0.2) ? ago(r.int(1, 20) * H) : null,
      });
      todo.push({ id, projectId });
      if (mode === 'MEMBERS') {
        for (const userId of members) if (r.chance(0.5)) targets.push({ taskId: id, userId });
      }
    }
  }
  await prisma.task.createMany({ data: tasks });
  await prisma.taskTarget.createMany({ data: targets });
  const projectTasks = (p: string) => tasks.filter((t) => t.projectId === p);
  if (wild) {
    const deps: Prisma.TaskDependencyCreateManyInput[] = [];
    for (const t of todo) {
      if (!r.chance(0.2)) continue;
      const other = r.pick(projectTasks(t.projectId));
      if (other.id !== t.id) deps.push({ taskId: t.id, dependsOnId: other.id! });
    }
    await prisma.taskDependency.createMany({ data: deps, skipDuplicates: true });
  }

  // ---- assignments ----
  const assignments: Prisma.AssignmentCreateManyInput[] = [];
  const agentOf = (userId: string) => {
    const list = agents.filter((a) => a.userId === userId && !a.revokedAt);
    return list.length ? r.pick(list).id : null;
  };
  for (const t of others) {
    const members = partsByProject.get(t.projectId) ?? [];
    if (members.length === 0) continue;
    if (t.status === 'DONE') {
      // Several successful runs (medians need 5) plus a failed one, some in the 5 h window.
      for (let k = 0; k < r.int(0, wild ? 7 : 3); k++) {
        const userId = r.pick(members);
        const finishedAt = ago(r.int(10, 30 * 60) * 60_000 + k);
        assignments.push({
          taskId: t.id,
          userId,
          agentId: agentOf(userId),
          kind: 'AUTO_OFFER',
          status: k === 0 && wild ? 'FAILED' : 'SUCCEEDED',
          failureClass: k === 0 && wild ? 'task' : null,
          respondedAt: ago(r.int(1, 48) * H),
          finishedAt,
          usageWeighted: BigInt(r.int(1, 30_000)),
        });
      }
    } else {
      const userId = r.pick(members);
      const agentId = agentOf(userId);
      if (!agentId) continue;
      assignments.push({
        taskId: t.id,
        userId,
        agentId,
        kind: 'AUTO_OFFER',
        status: t.status === 'IN_REVIEW' ? 'PUSHED' : r.pick(['ACCEPTED', 'RUNNING'] as const),
        respondedAt: ago(r.int(1, 60) * 60_000),
        leaseExpiresAt: new Date(now.getTime() + 2 * H),
      });
    }
  }
  if (wild) {
    for (const t of todo) {
      const members = partsByProject.get(t.projectId) ?? [];
      if (members.length === 0) continue;
      let autoPending = false;
      for (let k = 0; k < r.int(0, 3); k++) {
        const userId = r.pick(members);
        const status = r.pick([
          'PENDING',
          'REJECTED',
          'REJECTED',
          'EXPIRED',
          'CANCELLED',
          'FAILED',
          'FAILED',
          'LOST',
        ] as const);
        const kind = r.pick(['AUTO_OFFER', 'CONSENT_REQUEST'] as const);
        if (status === 'PENDING' && kind === 'AUTO_OFFER') {
          if (autoPending) continue;
          autoPending = true;
        }
        const at = ago(r.chance(0.8) ? r.int(1, 23 * 60) * 60_000 : 30 * H);
        assignments.push({
          taskId: t.id,
          userId,
          agentId: kind === 'AUTO_OFFER' ? agentOf(userId) : null,
          kind,
          status,
          reason:
            status === 'REJECTED'
              ? r.pick(['declined', 'not_participating: stale list', 'error: claude_auth expired'])
              : status === 'FAILED'
                ? r.pick(['boom', 'env file .env not found', '401 unauthorized'])
                : null,
          failureClass:
            status === 'FAILED'
              ? r.pick(['env', 'claude_auth', 'rate_limited', 'timeout', 'task', null])
              : null,
          offeredAt: at,
          expiresAt: status === 'PENDING' ? new Date(now.getTime() + 30 * 60_000) : at,
          respondedAt: status === 'PENDING' ? null : at,
          finishedAt: status === 'FAILED' || status === 'LOST' ? at : null,
          usageWeighted: status === 'FAILED' ? BigInt(r.int(0, 5000)) : null,
          updatedAt: at,
        });
      }
    }
  }
  await prisma.assignment.createMany({ data: assignments });
  return { tag, now, gateway, userIds, projectIds, taskIds: tasks.map((t) => t.id!) };
}

/** Removes everything a scenario created (audit rows are append-only and stay). */
export async function dropScenario(prisma: PrismaClient, s: Scenario): Promise<void> {
  await prisma.task.deleteMany({ where: { projectId: { in: s.projectIds } } });
  await prisma.project.deleteMany({ where: { id: { in: s.projectIds } } });
  await prisma.installation.deleteMany({ where: { id: { startsWith: `ins_${s.tag}_` } } });
  await prisma.user.deleteMany({ where: { id: { in: s.userIds } } });
}

/** The assignments of the scenario, as comparable strings. */
export async function assignmentKeys(prisma: PrismaClient, s: Scenario) {
  const rows = await prisma.assignment.findMany({
    where: { taskId: { in: s.taskIds } },
    select: {
      id: true,
      taskId: true,
      userId: true,
      agentId: true,
      kind: true,
      status: true,
      reason: true,
    },
  });
  return rows.map((a) => ({
    id: a.id,
    key: `${a.taskId} ${a.userId} ${a.agentId ?? '-'} ${a.kind} ${a.status} ${a.reason ?? ''}`,
  }));
}
