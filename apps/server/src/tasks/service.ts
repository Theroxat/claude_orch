import { randomUUID } from 'node:crypto';
import { Prisma, type Agent, type Assignment, type Project, type User } from '@prisma/client';
import {
  TASK_STATUSES,
  classifyFailure,
  serverMessage,
  summarizeFailure,
  type FailureClass,
  type AckPayload,
  type GithubRole,
  type ServerMessage,
  type ProjectTaskAccess,
  type TaskBoard,
  type TaskOfferPayload,
  type TaskStatus,
  type TaskUser,
  type TaskView,
  type TasksListPayload,
} from '@orch/shared';
import { audit } from '../audit';
import type { Config } from '../config';
import type { PrismaClient } from '../db';
import type { GithubClient, GithubIssue } from '../github';
import { HttpError } from '../http/errors';
import { canSubmit as roleCanSubmit, toOrchRole } from '../projects/roles';
import { getRoleInfo, participationStatus } from '../projects/service';
import { bodyHash, branchNameFor, buildIssueBody, parseIssueBody } from './meta';
import {
  ENV_FAILURES_BEFORE_ATTENTION,
  RATE_LIMIT_FALLBACK_MS,
  attentionReason,
  beforeRetry,
  failureClassOf,
} from '../dispatch/failures';

export interface TaskDeps {
  prisma: PrismaClient;
  config: Config;
  github?: GithubClient;
}

export type ProjectWithInstallation = Prisma.ProjectGetPayload<{ include: { installation: true } }>;

export const taskInclude = {
  project: true,
  createdBy: true,
  assignee: true,
  assigneeAgent: true,
  dependsOn: { include: { dependsOn: true } },
  targets: true,
  // Failed runs, for "Failed N times: last error" on the card.
  assignments: {
    where: { status: 'FAILED' },
    orderBy: { finishedAt: 'desc' },
    select: { reason: true, failureClass: true, finishedAt: true, updatedAt: true },
  },
} satisfies Prisma.TaskInclude;
export type TaskRow = Prisma.TaskGetPayload<{ include: typeof taskInclude }>;

export interface Access {
  isOwner: boolean;
  role: GithubRole;
  /** May create TODO tasks, import and approve. */
  canSubmit: boolean;
  /** May create PROPOSED tasks (any collaborator). */
  canPropose: boolean;
}

/** Task statuses that count as "pending" for the per-creator limit. */
export const PENDING_STATUSES: TaskStatus[] = ['PROPOSED', 'TODO'];
const LIVE_ASSIGNMENT = ['ACCEPTED', 'RUNNING', 'PUSHED'] as const;
const EDITABLE: TaskStatus[] = ['PROPOSED', 'TODO'];

const toTaskUser = (u: User): TaskUser => ({
  id: u.id,
  githubLogin: u.login,
  avatarUrl: u.avatarUrl,
});

/** Stored status plus the derived BLOCKED. CANCELLED tasks are hidden from the Backlog. */
export function effectiveStatus(t: TaskRow): TaskStatus | 'CANCELLED' {
  if (t.status === 'TODO' && t.dependsOn.some((d) => d.dependsOn.status !== 'DONE')) {
    return 'BLOCKED';
  }
  return t.status;
}

const DISPATCH_VIEW = { POOL: 'pool', MEMBERS: 'members', BROADCAST: 'broadcast' } as const;

/** Web URL of a GitHub issue, on the configured GitHub web host. */
export function issueUrlFor(webUrl: string, fullName: string, issueNumber: number): string {
  return `${webUrl}/${fullName}/issues/${issueNumber}`;
}

export function toTaskView(
  t: TaskRow,
  access: Access,
  viewer: Pick<User, 'id'>,
  webUrl: string,
): TaskView {
  const status = effectiveStatus(t);
  if (status === 'CANCELLED') throw new HttpError(410, 'task_cancelled', 'The task was cancelled');
  const issueUrl = issueUrlFor(webUrl, t.project.fullName, t.githubIssueNumber);
  return {
    id: t.id,
    projectId: t.projectId,
    projectFullName: t.project.fullName,
    issueNumber: t.githubIssueNumber,
    issueUrl,
    title: t.title,
    body: t.bodySnapshot,
    acceptanceCriteria: t.acceptanceCriteria,
    size: t.size,
    model: t.model,
    status,
    dependsOn: t.dependsOn.map((d) => ({
      id: d.dependsOn.id,
      issueNumber: d.dependsOn.githubIssueNumber,
      title: d.dependsOn.title,
      // A cancelled dependency never completes: shown as TODO (the dependent stays blocked).
      status: d.dependsOn.status === 'CANCELLED' ? 'TODO' : d.dependsOn.status,
    })),
    integrationBranch: t.integrationBranch,
    baseBranch: t.baseBranch,
    branchName: t.branchName,
    prNumber: t.prNumber,
    prUrl: t.prUrl,
    origin: t.origin,
    createdBy: toTaskUser(t.createdBy),
    assignee: t.assignee ? toTaskUser(t.assignee) : null,
    assigneeAgentId: t.assigneeAgentId,
    assigneeMachineName: t.assigneeAgent?.name ?? null,
    canEdit:
      (EDITABLE as readonly string[]).includes(t.status) &&
      (access.isOwner || t.createdById === viewer.id),
    canApprove: t.status === 'PROPOSED' && (access.isOwner || access.canSubmit),
    dispatch: {
      mode: DISPATCH_VIEW[t.dispatchMode],
      memberIds: t.targets.map((x) => x.userId),
    },
    ...failureView(t),
    needsAttention: t.needsAttention,
    needsAttentionReason: t.needsAttentionReason,
    // Retry only makes sense for a task that failed since the last retry, or is flagged.
    canRetry:
      t.status === 'TODO' &&
      (access.isOwner || t.createdById === viewer.id) &&
      (t.needsAttention || t.assignments.some((a) => !beforeRetry(a, t.retryResetAt))),
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
  };
}

/** Failed runs since the last retry, and the last one's error (redacted, truncated). */
function failureView(t: TaskRow) {
  const failed = t.assignments.filter((a) => !beforeRetry(a, t.retryResetAt));
  const last = failed[0];
  return {
    failedAttempts: failed.length,
    lastError: last ? summarizeFailure(last.reason) || null : null,
    lastFailureClass: last ? failureClassOf(last) : null,
  };
}

export function toProjectAccess(a: Access): ProjectTaskAccess {
  return {
    myRole: a.isOwner ? 'owner' : toOrchRole(a.role),
    canSubmit: a.canSubmit,
    canPropose: a.canPropose,
    canApprove: a.isOwner || a.canSubmit,
  };
}

export function groupBoard(
  views: TaskView[],
  access: Record<string, ProjectTaskAccess> = {},
): TaskBoard {
  const board = Object.fromEntries(
    TASK_STATUSES.map((s) => [s, [] as TaskView[]]),
  ) as unknown as TaskBoard;
  board.access = access;
  for (const v of views) board[v.status].push(v);
  return board;
}

export interface CreateTaskInput {
  title: string;
  body: string;
  acceptanceCriteria: string[];
  size: 'S' | 'M' | 'L';
  model: 'SONNET' | 'OPUS';
  dependsOn: string[];
  integrationBranch: string | null;
  /** M4: who the dispatcher may offer the task to. */
  dispatch?: { mode: 'pool' | 'members' | 'broadcast'; memberIds?: string[] };
}

export interface BatchItem {
  ref: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  size: 'S' | 'M' | 'L';
  model: 'SONNET' | 'OPUS';
  /** Refs of this batch, or issue numbers (number, "12" or "#12") of existing tasks. */
  dependsOn: Array<string | number>;
}

export interface BatchInput {
  items: BatchItem[];
  integrationBranch: string | null;
  dispatch?: CreateTaskInput['dispatch'];
}

export interface BatchResult {
  batchId: string;
  status: TaskStatus;
  branchCreated: boolean;
  /** In request order. */
  tasks: Array<{ ref: string; row: TaskRow }>;
}

/**
 * Kahn's algorithm over local refs. Returns an order where dependencies come first; 400
 * `dependency_cycle` naming the refs left in a cycle.
 */
export function topoOrder(refs: string[], deps: Map<string, string[]>): string[] {
  const indegree = new Map(refs.map((r) => [r, deps.get(r)?.length ?? 0]));
  const dependents = new Map<string, string[]>();
  for (const r of refs) {
    for (const d of deps.get(r) ?? []) dependents.set(d, [...(dependents.get(d) ?? []), r]);
  }
  const queue = refs.filter((r) => indegree.get(r) === 0);
  const out: string[] = [];
  while (queue.length > 0) {
    const r = queue.shift()!;
    out.push(r);
    for (const n of dependents.get(r) ?? []) {
      const left = indegree.get(n)! - 1;
      indegree.set(n, left);
      if (left === 0) queue.push(n);
    }
  }
  if (out.length !== refs.length) {
    const stuck = refs.filter((r) => !out.includes(r));
    throw new HttpError(
      400,
      'dependency_cycle',
      `These subtasks depend on each other in a cycle: ${stuck.join(', ')}`,
    );
  }
  return out;
}

/** Result of a claim: the ack for the agent and, on success, the offer to send after it. */
export interface ClaimResult {
  ack: AckPayload;
  offer?: TaskOfferPayload;
  /** Pending offers/requests of the task, withdrawn because the claim won. */
  withdrawn?: Assignment[];
}

const refuse = (code: string, message: string): AckPayload => ({
  ok: false,
  error: { code, message },
});

type AgentWithUser = Agent & { user: User };

export class TaskService {
  constructor(private readonly deps: TaskDeps) {}

  private get prisma() {
    return this.deps.prisma;
  }

  private github(): GithubClient {
    if (!this.deps.github) {
      throw new HttpError(503, 'github_not_configured', 'GitHub App is not configured');
    }
    return this.deps.github;
  }

  // ---------- access ----------

  async accessFor(project: ProjectWithInstallation, user: User): Promise<Access> {
    const info = await getRoleInfo(this.prisma, this.deps.github, project, user);
    // The stored owner keeps owner powers only while GitHub still says ADMIN (cached role).
    if (project.addedById === user.id && (!this.deps.github || info.role === 'ADMIN')) {
      return { isOwner: true, role: 'ADMIN', canSubmit: true, canPropose: true };
    }
    const policy = project.submissionPolicy === 'ALLOWLIST' ? 'ALLOWLIST' : 'GITHUB';
    const canSubmit = roleCanSubmit(policy, info.role, info);
    return {
      isOwner: false,
      role: info.role,
      canSubmit,
      canPropose: canSubmit || info.role !== 'NONE',
    };
  }

  async projectFor(id: string): Promise<ProjectWithInstallation> {
    const p = await this.prisma.project.findUnique({
      where: { id },
      include: { installation: true },
    });
    if (!p || p.archivedAt) throw new HttpError(404, 'not_found', 'Project not found');
    return p;
  }

  /** A project the user may look at: owner, ACTIVE participant or GitHub collaborator. 404 otherwise. */
  async visibleProject(id: string, user: User): Promise<[ProjectWithInstallation, Access]> {
    const project = await this.projectFor(id);
    const access = await this.accessFor(project, user);
    if (!access.isOwner && access.role === 'NONE') {
      // A pending, rejected or inactive participation row grants no view of the board.
      const part = await this.prisma.participation.findUnique({
        where: { userId_projectId: { userId: user.id, projectId: id } },
      });
      if (!part || participationStatus(part, project.requireParticipantApproval) !== 'active') {
        throw new HttpError(404, 'not_found', 'Project not found');
      }
    }
    return [project, access];
  }

  // ---------- reads ----------

  async listForProject(project: ProjectWithInstallation, user: User, access: Access) {
    const rows = await this.prisma.task.findMany({
      where: { projectId: project.id, status: { not: 'CANCELLED' } },
      include: taskInclude,
      orderBy: { githubIssueNumber: 'asc' },
    });
    return groupBoard(
      rows.map((t) => toTaskView(t, access, user, this.deps.config.GITHUB_WEB_URL)),
      {
        [project.id]: toProjectAccess(access),
      },
    );
  }

  /** Tasks of every project the user owns or actively participates in. */
  async listMine(user: User): Promise<TaskBoard> {
    const projects = await this.prisma.project.findMany({
      where: {
        archivedAt: null,
        OR: [{ addedById: user.id }, { participations: { some: { userId: user.id } } }],
      },
      include: { installation: true },
    });
    const visible: { id: string; access: Access }[] = [];
    const accessMap: Record<string, ProjectTaskAccess> = {};
    for (const p of projects) {
      let access: Access;
      try {
        [, access] = await this.visibleProject(p.id, user);
      } catch {
        continue; // pending, rejected or inactive participation: not visible
      }
      accessMap[p.id] = toProjectAccess(access);
      visible.push({ id: p.id, access });
    }
    if (visible.length === 0) return groupBoard([], accessMap);
    // One query for every visible project, then project by project in `projects` order.
    const rows = await this.prisma.task.findMany({
      where: { projectId: { in: visible.map((v) => v.id) }, status: { not: 'CANCELLED' } },
      include: taskInclude,
      orderBy: { githubIssueNumber: 'asc' },
    });
    const byProject = new Map<string, typeof rows>();
    for (const t of rows) {
      const list = byProject.get(t.projectId);
      if (list) list.push(t);
      else byProject.set(t.projectId, [t]);
    }
    const views: TaskView[] = [];
    for (const { id, access } of visible) {
      for (const t of byProject.get(id) ?? []) {
        views.push(toTaskView(t, access, user, this.deps.config.GITHUB_WEB_URL));
      }
    }
    return groupBoard(views, accessMap);
  }

  async getRow(id: string): Promise<TaskRow> {
    const t = await this.prisma.task.findUnique({ where: { id }, include: taskInclude });
    if (!t) throw new HttpError(404, 'not_found', 'Task not found');
    return t;
  }

  /** Loads a task and the caller's access to its project (404 when invisible). */
  async getVisible(id: string, user: User): Promise<[TaskRow, Access]> {
    const t = await this.getRow(id);
    const [, access] = await this.visibleProject(t.projectId, user);
    return [t, access];
  }

  view(t: TaskRow, access: Access, user: User) {
    return toTaskView(t, access, user, this.deps.config.GITHUB_WEB_URL);
  }

  // ---------- dependencies ----------

  /** Validates that every id is a task of the project and that no cycle appears. */
  private async checkDependencies(
    tx: Prisma.TransactionClient,
    projectId: string,
    taskId: string | null,
    dependsOn: string[],
  ): Promise<string[]> {
    const ids = [...new Set(dependsOn)];
    if (ids.length === 0) return ids;
    const found = await tx.task.count({ where: { id: { in: ids }, projectId } });
    if (found !== ids.length || (taskId && ids.includes(taskId))) {
      throw new HttpError(
        taskId && ids.includes(taskId) ? 400 : 400,
        taskId && ids.includes(taskId) ? 'dependency_cycle' : 'invalid_dependency',
        taskId && ids.includes(taskId)
          ? 'A task cannot depend on itself'
          : 'Dependencies must be tasks of the same project',
      );
    }
    if (taskId) {
      // Cycle: taskId must not be reachable from any new dependency.
      const edges = await tx.taskDependency.findMany({
        where: { task: { projectId } },
        select: { taskId: true, dependsOnId: true },
      });
      const next = new Map<string, string[]>();
      for (const e of edges) {
        if (e.taskId === taskId) continue; // being replaced
        next.set(e.taskId, [...(next.get(e.taskId) ?? []), e.dependsOnId]);
      }
      const seen = new Set<string>();
      const stack = [...ids];
      while (stack.length > 0) {
        const cur = stack.pop()!;
        if (cur === taskId) {
          throw new HttpError(400, 'dependency_cycle', 'These dependencies would form a cycle');
        }
        if (seen.has(cur)) continue;
        seen.add(cur);
        stack.push(...(next.get(cur) ?? []));
      }
    }
    return ids;
  }

  // ---------- create / propose ----------

  async create(
    project: ProjectWithInstallation,
    user: User,
    access: Access,
    input: CreateTaskInput,
    ip?: string,
  ): Promise<TaskRow> {
    if (!access.canPropose) {
      throw new HttpError(403, 'forbidden', 'You may not create tasks in this project');
    }
    const status: TaskStatus = access.canSubmit ? 'TODO' : 'PROPOSED';
    await this.assertPendingRoom(user, 1);
    const dispatch = await this.checkDispatch(project, access, input.dispatch);
    // Validate the dependencies before touching GitHub.
    const depIds = await this.checkDependencies(this.prisma, project.id, null, input.dependsOn);
    const depTasks = await this.prisma.task.findMany({ where: { id: { in: depIds } } });

    const body = buildIssueBody(input.body, {
      v: 1,
      size: input.size,
      model: input.model,
      acceptanceCriteria: input.acceptanceCriteria,
      dependsOn: depTasks.map((d) => d.githubIssueNumber),
      integrationBranch: input.integrationBranch,
    });
    const issue = await this.github().createIssue(
      Number(project.installation.githubInstallationId),
      project.fullName,
      { title: input.title, body, labels: [project.poolLabel] },
    );
    const snapshot = input.body.trim();
    const task = await this.prisma.task.create({
      data: {
        projectId: project.id,
        githubIssueNumber: issue.number,
        githubIssueNodeId: issue.nodeId,
        title: input.title,
        bodySnapshot: snapshot,
        bodyHash: bodyHash(snapshot),
        acceptanceCriteria: input.acceptanceCriteria,
        size: input.size,
        model: input.model,
        baseBranch: project.defaultBranch,
        integrationBranch: input.integrationBranch,
        branchName: branchNameFor(issue.number, input.title),
        status,
        origin: 'PLATFORM',
        createdById: user.id,
        dispatchMode: dispatch.mode,
        dependsOn: { create: depIds.map((dependsOnId) => ({ dependsOnId })) },
        targets: { create: dispatch.memberIds.map((userId) => ({ userId })) },
      },
      include: taskInclude,
    });
    await audit(this.prisma, {
      actorUserId: user.id,
      action: status === 'PROPOSED' ? 'task.proposed' : 'task.created',
      projectId: project.id,
      taskId: task.id,
      ip,
      data: {
        issueNumber: issue.number,
        size: task.size,
        model: task.model,
        dispatch: dispatch.mode,
        ...(dispatch.memberIds.length ? { memberIds: dispatch.memberIds } : {}),
      },
    });
    return task;
  }

  /** 409 `pending_limit` when `adding` more pending tasks would exceed the creator's limit. */
  private async assertPendingRoom(user: User, adding: number): Promise<void> {
    const pending = await this.prisma.task.count({
      where: { createdById: user.id, status: { in: PENDING_STATUSES } },
    });
    if (pending + adding > user.maxPendingTasks) {
      throw new HttpError(
        409,
        'pending_limit',
        adding === 1
          ? `You already have ${pending} pending tasks (limit ${user.maxPendingTasks})`
          : `You have ${pending} pending tasks: ${adding} more would exceed the limit of ${user.maxPendingTasks}`,
      );
    }
  }

  // ---------- M5: batch submission (MCP submit_task) ----------

  /**
   * Creates several tasks at once, with dependencies between them given by local refs.
   * Everything is validated first (rights, pending limit, dispatch, refs, cycles with Kahn's
   * algorithm). Then the integration branch is created if missing, the issues are created in
   * dependency order, and the tasks and their dependencies are inserted in ONE transaction. If
   * GitHub or the database fails midway, the issues already created are closed with the label
   * `orch-aborted` (compensation) and nothing is stored.
   */
  async submitBatch(
    project: ProjectWithInstallation,
    user: User,
    access: Access,
    input: BatchInput,
    ip?: string,
  ): Promise<BatchResult> {
    if (!access.canPropose) {
      throw new HttpError(403, 'forbidden', 'You may not create tasks in this project');
    }
    const status: TaskStatus = access.canSubmit ? 'TODO' : 'PROPOSED';
    await this.assertPendingRoom(user, input.items.length);
    const dispatch = await this.checkDispatch(project, access, input.dispatch);

    // ---- resolve dependencies ----
    const refs = new Map<string, BatchItem>();
    for (const it of input.items) {
      if (refs.has(it.ref)) {
        throw new HttpError(400, 'duplicate_ref', `The ref "${it.ref}" is used twice`);
      }
      refs.set(it.ref, it);
    }
    const localDeps = new Map<string, string[]>();
    const existingDeps = new Map<string, number[]>();
    const wanted = new Set<number>();
    for (const it of input.items) {
      const local: string[] = [];
      const existing: number[] = [];
      for (const d of it.dependsOn) {
        if (typeof d === 'string' && refs.has(d)) {
          if (d === it.ref) {
            throw new HttpError(400, 'dependency_cycle', `"${it.ref}" depends on itself`);
          }
          local.push(d);
          continue;
        }
        const n = typeof d === 'number' ? d : /^#?\d+$/.test(d) ? Number(d.replace('#', '')) : NaN;
        if (!Number.isInteger(n) || n <= 0) {
          throw new HttpError(
            400,
            'unknown_dependency',
            `"${it.ref}" depends on "${d}", which is neither a ref of this request nor an issue number`,
          );
        }
        existing.push(n);
        wanted.add(n);
      }
      localDeps.set(it.ref, [...new Set(local)]);
      existingDeps.set(it.ref, [...new Set(existing)]);
    }
    const found = wanted.size
      ? await this.prisma.task.findMany({
          where: { projectId: project.id, githubIssueNumber: { in: [...wanted] } },
        })
      : [];
    const byNumber = new Map(found.map((t) => [t.githubIssueNumber, t]));
    for (const n of wanted) {
      const t = byNumber.get(n);
      if (!t || t.status === 'CANCELLED') {
        throw new HttpError(
          400,
          'invalid_dependency',
          `Issue #${n} is not an open task of ${project.fullName}`,
        );
      }
    }
    const order = topoOrder(
      input.items.map((i) => i.ref),
      localDeps,
    );

    // ---- GitHub: integration branch, then issues in dependency order ----
    const gh = this.github();
    const installationId = Number(project.installation.githubInstallationId);
    let branchCreated = false;
    if (input.integrationBranch && input.integrationBranch !== project.defaultBranch) {
      const exists = await gh.getBranchSha(
        installationId,
        project.fullName,
        input.integrationBranch,
      );
      if (!exists) {
        const base = await gh.getBranchSha(installationId, project.fullName, project.defaultBranch);
        if (!base) {
          throw new HttpError(
            409,
            'no_default_branch',
            `Branch ${project.defaultBranch} not found`,
          );
        }
        await gh.createBranch(installationId, project.fullName, input.integrationBranch, base);
        branchCreated = true;
      }
    }
    const integrationBranch = input.integrationBranch ?? null;
    const batchId = randomUUID();
    const issues = new Map<string, GithubIssue>();
    const compensate = async () => {
      for (const issue of issues.values()) {
        try {
          await gh.closeIssue(installationId, project.fullName, issue.number, ['orch-aborted']);
        } catch {
          // Best effort: the issue stays open without tasks; the audit records it.
        }
      }
      await audit(this.prisma, {
        actorUserId: user.id,
        action: 'task.batch_aborted',
        projectId: project.id,
        ip,
        data: { batchId, closedIssues: [...issues.values()].map((i) => i.number) },
      });
    };
    const issueNumberOf = (ref: string) => issues.get(ref)!.number;
    try {
      for (const ref of order) {
        const it = refs.get(ref)!;
        const deps = [...localDeps.get(ref)!.map(issueNumberOf), ...existingDeps.get(ref)!];
        const body = buildIssueBody(it.description, {
          v: 1,
          size: it.size,
          model: it.model,
          acceptanceCriteria: it.acceptanceCriteria,
          dependsOn: deps,
          integrationBranch,
        });
        issues.set(
          ref,
          await gh.createIssue(installationId, project.fullName, {
            title: it.title,
            body,
            labels: [project.poolLabel],
          }),
        );
      }
    } catch {
      await compensate();
      throw new HttpError(
        502,
        'github_error',
        `GitHub failed after ${issues.size} of ${order.length} issues: the batch was rolled back (created issues closed with label orch-aborted)`,
      );
    }

    // ---- database: one transaction ----
    let ids: Map<string, string>;
    try {
      ids = await this.prisma.$transaction(async (tx) => {
        const out = new Map<string, string>();
        for (const ref of order) {
          const it = refs.get(ref)!;
          const issue = issues.get(ref)!;
          const snapshot = it.description.trim();
          const row = await tx.task.create({
            data: {
              projectId: project.id,
              githubIssueNumber: issue.number,
              githubIssueNodeId: issue.nodeId,
              title: it.title,
              bodySnapshot: snapshot,
              bodyHash: bodyHash(snapshot),
              acceptanceCriteria: it.acceptanceCriteria,
              size: it.size,
              model: it.model,
              baseBranch: project.defaultBranch,
              integrationBranch,
              branchName: branchNameFor(issue.number, it.title),
              status,
              origin: 'MCP',
              createdById: user.id,
              dispatchMode: dispatch.mode,
              dependsOn: {
                create: [
                  ...localDeps.get(ref)!.map((r) => ({ dependsOnId: out.get(r)! })),
                  ...existingDeps.get(ref)!.map((n) => ({ dependsOnId: byNumber.get(n)!.id })),
                ],
              },
              targets: { create: dispatch.memberIds.map((userId) => ({ userId })) },
            },
          });
          out.set(ref, row.id);
        }
        return out;
      });
    } catch (err) {
      await compensate();
      throw err;
    }

    for (const ref of order) {
      const issue = issues.get(ref)!;
      await audit(this.prisma, {
        actorUserId: user.id,
        action: status === 'PROPOSED' ? 'task.proposed' : 'task.created',
        projectId: project.id,
        taskId: ids.get(ref)!,
        ip,
        data: {
          issueNumber: issue.number,
          batchId,
          ref,
          via: 'mcp',
          dispatch: dispatch.mode,
          ...(dispatch.memberIds.length ? { memberIds: dispatch.memberIds } : {}),
        },
      });
    }
    await audit(this.prisma, {
      actorUserId: user.id,
      action: 'task.batch_submitted',
      projectId: project.id,
      ip,
      data: {
        batchId,
        via: 'mcp',
        status,
        issueNumbers: order.map(issueNumberOf),
        ...(integrationBranch ? { integrationBranch, branchCreated } : {}),
      },
    });
    const rows = await this.prisma.task.findMany({
      where: { id: { in: [...ids.values()] } },
      include: taskInclude,
    });
    const byId = new Map(rows.map((r) => [r.id, r]));
    return {
      batchId,
      status,
      branchCreated,
      tasks: input.items.map((it) => ({ ref: it.ref, row: byId.get(ids.get(it.ref)!)! })),
    };
  }

  /** M4 targeting rules: broadcast is owner-only; members must participate in the project. */
  private async checkDispatch(
    project: ProjectWithInstallation,
    access: Access,
    d: CreateTaskInput['dispatch'],
  ): Promise<{ mode: 'POOL' | 'MEMBERS' | 'BROADCAST'; memberIds: string[] }> {
    if (!d || d.mode === 'pool') return { mode: 'POOL', memberIds: [] };
    if (d.mode === 'broadcast') {
      if (!access.isOwner) {
        throw new HttpError(403, 'forbidden', 'Only the project owner can broadcast a task');
      }
      return { mode: 'BROADCAST', memberIds: [] };
    }
    const ids = [...new Set(d.memberIds ?? [])];
    if (ids.length === 0) throw new HttpError(400, 'invalid_member', 'memberIds is required');
    const found = await this.prisma.participation.count({
      where: { projectId: project.id, userId: { in: ids } },
    });
    if (found !== ids.length) {
      throw new HttpError(400, 'invalid_member', 'Every member must participate in the project');
    }
    return { mode: 'MEMBERS', memberIds: ids };
  }

  // ---------- import ----------

  async importIssues(
    project: ProjectWithInstallation,
    user: User,
    access: Access,
    ip?: string,
  ): Promise<{ imported: TaskRow[]; alreadyImported: number }> {
    if (!access.canSubmit) {
      throw new HttpError(403, 'forbidden', 'Only submitters and the owner can import issues');
    }
    const issues = await this.github().listIssuesByLabel(
      Number(project.installation.githubInstallationId),
      project.fullName,
      project.poolLabel,
    );
    const known = new Set(
      (
        await this.prisma.task.findMany({
          where: { projectId: project.id },
          select: { githubIssueNumber: true },
        })
      ).map((t) => t.githubIssueNumber),
    );
    const fresh = issues.filter((i) => !known.has(i.number));
    const created: Array<{ id: string; deps: number[] }> = [];
    for (const issue of fresh) {
      const { description, meta } = parseIssueBody(issue.body);
      let row;
      try {
        row = await this.prisma.task.create({
          data: {
            projectId: project.id,
            githubIssueNumber: issue.number,
            githubIssueNodeId: issue.nodeId,
            title: issue.title,
            bodySnapshot: description,
            bodyHash: bodyHash(description),
            acceptanceCriteria: meta?.acceptanceCriteria ?? [],
            size: meta?.size ?? 'M',
            model: meta?.model ?? 'SONNET',
            baseBranch: project.defaultBranch,
            integrationBranch: meta?.integrationBranch ?? null,
            branchName: branchNameFor(issue.number, issue.title),
            status: 'TODO',
            origin: 'LABEL_IMPORT',
            createdById: user.id,
          },
        });
      } catch (err) {
        // A concurrent import got there first.
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') continue;
        throw err;
      }
      created.push({ id: row.id, deps: meta?.dependsOn ?? [] });
      await audit(this.prisma, {
        actorUserId: user.id,
        action: 'task.imported',
        projectId: project.id,
        taskId: row.id,
        ip,
        data: { issueNumber: issue.number },
      });
    }
    // Second pass: resolve dependency issue numbers once all new tasks exist.
    const all = await this.prisma.task.findMany({
      where: { projectId: project.id },
      select: { id: true, githubIssueNumber: true },
    });
    const byNumber = new Map(all.map((t) => [t.githubIssueNumber, t.id]));
    for (const c of created) {
      const ids = [...new Set(c.deps.map((n) => byNumber.get(n)).filter((x): x is string => !!x))];
      try {
        const ok = await this.prisma.$transaction((tx) =>
          this.checkDependencies(tx, project.id, c.id, ids),
        );
        if (ok.length > 0) {
          await this.prisma.taskDependency.createMany({
            data: ok.map((dependsOnId) => ({ taskId: c.id, dependsOnId })),
            skipDuplicates: true,
          });
        }
      } catch (err) {
        if (!(err instanceof HttpError)) throw err; // invalid metadata from an issue: ignore deps
      }
    }
    const rows = await this.prisma.task.findMany({
      where: { id: { in: created.map((c) => c.id) } },
      include: taskInclude,
      orderBy: { githubIssueNumber: 'asc' },
    });
    return { imported: rows, alreadyImported: issues.length - fresh.length };
  }

  /**
   * Imports one issue (the `issues.labeled` webhook). Null when it is already a task.
   * Dependencies are resolved against the tasks that exist now.
   */
  async importIssue(
    project: ProjectWithInstallation,
    issue: GithubIssue,
    createdById: string,
    audited: { actorType: 'GITHUB' | 'USER'; actorUserId?: string },
  ): Promise<TaskRow | null> {
    const { description, meta } = parseIssueBody(issue.body);
    let row;
    try {
      row = await this.prisma.task.create({
        data: {
          projectId: project.id,
          githubIssueNumber: issue.number,
          githubIssueNodeId: issue.nodeId,
          title: issue.title,
          bodySnapshot: description,
          bodyHash: bodyHash(description),
          acceptanceCriteria: meta?.acceptanceCriteria ?? [],
          size: meta?.size ?? 'M',
          model: meta?.model ?? 'SONNET',
          baseBranch: project.defaultBranch,
          integrationBranch: meta?.integrationBranch ?? null,
          branchName: branchNameFor(issue.number, issue.title),
          status: 'TODO',
          origin: 'LABEL_IMPORT',
          createdById,
        },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return null;
      throw err;
    }
    const numbers = meta?.dependsOn ?? [];
    if (numbers.length > 0) {
      const deps = await this.prisma.task.findMany({
        where: { projectId: project.id, githubIssueNumber: { in: numbers } },
        select: { id: true },
      });
      try {
        const ok = await this.prisma.$transaction((tx) =>
          this.checkDependencies(
            tx,
            project.id,
            row.id,
            deps.map((d) => d.id),
          ),
        );
        if (ok.length > 0) {
          await this.prisma.taskDependency.createMany({
            data: ok.map((dependsOnId) => ({ taskId: row.id, dependsOnId })),
            skipDuplicates: true,
          });
        }
      } catch (err) {
        if (!(err instanceof HttpError)) throw err;
      }
    }
    await audit(this.prisma, {
      actorType: audited.actorType,
      actorUserId: audited.actorUserId,
      action: 'task.imported',
      projectId: project.id,
      taskId: row.id,
      data: { issueNumber: issue.number, via: 'webhook' },
    });
    return this.getRow(row.id);
  }

  // ---------- approve / update ----------

  async approve(t: TaskRow, user: User, access: Access, ip?: string): Promise<TaskRow> {
    if (!(access.isOwner || access.canSubmit)) {
      throw new HttpError(403, 'forbidden', 'Only submitters and the owner can approve');
    }
    const res = await this.prisma.task.updateMany({
      where: { id: t.id, status: 'PROPOSED' },
      data: { status: 'TODO' },
    });
    if (res.count !== 1) throw new HttpError(409, 'not_proposed', 'The task is not proposed');
    await audit(this.prisma, {
      actorUserId: user.id,
      action: 'task.approved',
      projectId: t.projectId,
      taskId: t.id,
      targetUserId: t.createdById,
      ip,
    });
    return this.getRow(t.id);
  }

  async update(
    t: TaskRow,
    user: User,
    access: Access,
    patch: { size?: 'S' | 'M' | 'L'; model?: 'SONNET' | 'OPUS'; dependsOn?: string[] },
    ip?: string,
  ): Promise<TaskRow> {
    if (!(access.isOwner || t.createdById === user.id)) {
      throw new HttpError(403, 'forbidden', 'Only the creator or the project owner can edit');
    }
    if (!(EDITABLE as readonly string[]).includes(t.status)) {
      throw new HttpError(409, 'task_locked', 'The task already started');
    }
    await this.prisma.$transaction(async (tx) => {
      const ids =
        patch.dependsOn === undefined
          ? null
          : await this.checkDependencies(tx, t.projectId, t.id, patch.dependsOn);
      const res = await tx.task.updateMany({
        where: { id: t.id, status: { in: EDITABLE } },
        // updatedAt is always set: with no other field Prisma skips the UPDATE and returns count 0.
        data: { size: patch.size, model: patch.model, updatedAt: new Date() },
      });
      if (res.count !== 1) throw new HttpError(409, 'task_locked', 'The task already started');
      if (ids) {
        await tx.taskDependency.deleteMany({ where: { taskId: t.id } });
        await tx.taskDependency.createMany({
          data: ids.map((dependsOnId) => ({ taskId: t.id, dependsOnId })),
        });
      }
    });
    await audit(this.prisma, {
      actorUserId: user.id,
      action: 'task.updated',
      projectId: t.projectId,
      taskId: t.id,
      ip,
      data: {
        ...(patch.size ? { size: patch.size } : {}),
        ...(patch.model ? { model: patch.model } : {}),
        ...(patch.dependsOn ? { dependsOn: patch.dependsOn } : {}),
      },
    });
    return this.getRow(t.id);
  }

  /**
   * Retry (project owner or task creator): earlier failures no longer count for the dispatcher
   * (shut-out, backoff, env counter), `needsAttention` is cleared. History is kept.
   */
  async retry(t: TaskRow, user: User, access: Access, via: 'web' | 'mcp', ip?: string) {
    if (!(access.isOwner || t.createdById === user.id)) {
      throw new HttpError(403, 'forbidden', 'Only the creator or the project owner can retry');
    }
    const now = new Date();
    const res = await this.prisma.task.updateMany({
      where: { id: t.id, status: 'TODO' },
      data: {
        retryResetAt: now,
        needsAttention: false,
        needsAttentionReason: null,
        needsAttentionAt: null,
      },
    });
    if (res.count !== 1) {
      throw new HttpError(409, 'not_retryable', 'Only a task waiting in To do can be retried');
    }
    await audit(this.prisma, {
      actorUserId: user.id,
      action: 'task.retried',
      projectId: t.projectId,
      taskId: t.id,
      ip,
      data: {
        via,
        failedAttempts: failureView(t).failedAttempts,
        ...(t.needsAttention ? { clearedNeedsAttention: true } : {}),
      },
    });
    return this.getRow(t.id);
  }

  // ---------- agent side: list ----------

  /** Tasks the agent's member can take right now. */
  async takeable(agent: AgentWithUser, projectFullName?: string): Promise<TasksListPayload> {
    const parts = await this.prisma.participation.findMany({
      where: {
        userId: agent.userId,
        active: true,
        project: { archivedAt: null, ...(projectFullName ? { fullName: projectFullName } : {}) },
      },
      include: { project: true },
    });
    const ok = parts.filter(
      (p) => participationStatus(p, p.project.requireParticipantApproval) === 'active',
    );
    const rows = await this.prisma.task.findMany({
      where: { projectId: { in: ok.map((p) => p.projectId) }, status: 'TODO' },
      include: taskInclude,
      orderBy: [{ createdAt: 'asc' }],
    });
    const part = new Map(ok.map((p) => [p.projectId, p]));
    return {
      tasks: rows
        .filter((t) => effectiveStatus(t) === 'TODO')
        .filter((t) => part.get(t.projectId)?.allowedModels.includes(t.model))
        .map((t) => ({
          taskId: t.id,
          projectFullName: t.project.fullName,
          issueNumber: t.githubIssueNumber,
          title: t.title,
          size: t.size,
          model: t.model,
          createdBy: { login: t.createdBy.login },
        })),
    };
  }

  // ---------- agent side: claim ----------

  async claim(
    agent: AgentWithUser,
    payload: { projectFullName: string; issueNumber: number },
    /** `server`: the member took it outside the agent (MCP `take_task`). */
    initiatedBy: 'agent' | 'server' = 'agent',
  ): Promise<ClaimResult> {
    const { prisma } = this;
    if (agent.paused || agent.user.paused) return { ack: refuse('paused', 'The agent is paused') };
    const project = await prisma.project.findUnique({
      where: { fullName: payload.projectFullName },
    });
    const task = project
      ? await prisma.task.findUnique({
          where: {
            projectId_githubIssueNumber: {
              projectId: project.id,
              githubIssueNumber: payload.issueNumber,
            },
          },
          include: taskInclude,
        })
      : null;
    if (!project || project.archivedAt || !task) {
      return { ack: refuse('not_found', 'No such task') };
    }
    const part = await prisma.participation.findUnique({
      where: { userId_projectId: { userId: agent.userId, projectId: project.id } },
    });
    if (!part || participationStatus(part, project.requireParticipantApproval) !== 'active') {
      return { ack: refuse('not_participating', 'You do not participate in this project') };
    }
    if (!part.allowedModels.includes(task.model)) {
      return { ack: refuse('model_not_allowed', `Model ${task.model} is not allowed for you`) };
    }
    const running = await prisma.assignment.count({
      where: { agentId: agent.id, status: { in: ['ACCEPTED', 'RUNNING'] } },
    });
    if (running >= agent.user.maxConcurrent) {
      return { ack: refuse('max_concurrency', 'Too many tasks are already running') };
    }
    if (task.status === 'PROPOSED') {
      return { ack: refuse('not_approved', 'The task is waiting for approval') };
    }
    if (task.status !== 'TODO') return { ack: refuse('already_taken', 'The task is not open') };
    if (effectiveStatus(task) === 'BLOCKED') {
      return { ack: refuse('dependencies_unmet', 'Dependencies are not done yet') };
    }

    // Atomic claim: the conditional update lets exactly one claimer win; the partial unique index
    // `one_live_assignment` is the second line of defense.
    let assignment: Assignment;
    let withdrawn: Assignment[] = [];
    try {
      assignment = await prisma.$transaction(async (tx) => {
        const won = await tx.task.updateMany({
          where: { id: task.id, status: 'TODO' },
          data: { status: 'IN_PROGRESS', assigneeId: agent.userId, assigneeAgentId: agent.id },
        });
        if (won.count !== 1) throw new HttpError(409, 'already_taken', 'Taken by someone else');
        // First acceptance wins: pending offers and requests of this task are withdrawn.
        withdrawn = await tx.assignment.findMany({ where: { taskId: task.id, status: 'PENDING' } });
        if (withdrawn.length) {
          await tx.assignment.updateMany({
            where: { id: { in: withdrawn.map((w) => w.id) }, status: 'PENDING' },
            data: { status: 'CANCELLED', reason: 'taken', respondedAt: new Date() },
          });
        }
        return tx.assignment.create({
          data: {
            taskId: task.id,
            userId: agent.userId,
            agentId: agent.id,
            kind: 'CLAIM',
            status: 'ACCEPTED',
            execMode: 'MANUAL',
            respondedAt: new Date(),
          },
        });
      });
    } catch (err) {
      if (
        (err instanceof HttpError && err.code === 'already_taken') ||
        (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')
      ) {
        return { ack: refuse('already_taken', 'The task was taken by someone else') };
      }
      throw err;
    }
    await audit(prisma, {
      actorType: 'AGENT',
      actorUserId: agent.userId,
      actorAgentId: agent.id,
      agentId: agent.id,
      action: 'task.claimed',
      projectId: project.id,
      taskId: task.id,
      data: {
        assignmentId: assignment.id,
        issueNumber: task.githubIssueNumber,
        execMode: 'MANUAL',
        ...(initiatedBy === 'server' ? { via: 'mcp' } : {}),
      },
    });
    const offer: TaskOfferPayload = {
      assignmentId: assignment.id,
      kind: 'CLAIM',
      expiresAt: null,
      ...(initiatedBy === 'server' ? { initiatedBy, execMode: 'MANUAL', accepted: true } : {}),
      task: {
        taskId: task.id,
        project: {
          id: project.id,
          fullName: project.fullName,
          defaultBranch: project.defaultBranch,
        },
        issueNumber: task.githubIssueNumber,
        title: task.title,
        prompt: buildPrompt(task),
        bodyHash: task.bodyHash,
        acceptanceCriteria: task.acceptanceCriteria,
        size: task.size,
        model: task.model,
        baseBranch: task.integrationBranch ?? task.baseBranch,
        branchName: task.branchName ?? branchNameFor(task.githubIssueNumber, task.title),
        createdBy: { login: task.createdBy.login },
      },
    };
    return { ack: { ok: true }, offer, withdrawn };
  }

  // ---------- agent side: assignment lookups ----------

  private async liveAssignment(agentId: string, assignmentId: string) {
    const a = await this.prisma.assignment.findUnique({
      where: { id: assignmentId },
      include: { task: { include: { project: { include: { installation: true } } } } },
    });
    if (!a || a.agentId !== agentId) return null;
    return a;
  }

  // ---------- agent side: token ----------

  async mintToken(
    agent: AgentWithUser,
    p: { assignmentId: string; purpose: 'clone' | 'push' },
  ): Promise<
    | {
        ok: true;
        token: string;
        expiresAt: Date;
        repository: string;
        permissions: Record<string, 'read' | 'write'>;
      }
    | { ok: false; reason: string }
  > {
    const a = await this.liveAssignment(agent.id, p.assignmentId);
    if (!a) return { ok: false, reason: 'unknown_assignment' };
    if (agent.revokedAt) return { ok: false, reason: 'revoked' };
    if (
      !(LIVE_ASSIGNMENT as readonly string[]).includes(a.status) ||
      a.task.status !== 'IN_PROGRESS' ||
      a.task.assigneeAgentId !== agent.id
    ) {
      return { ok: false, reason: 'assignment_not_live' };
    }
    if (!this.deps.github) return { ok: false, reason: 'github_not_configured' };
    const project = a.task.project;
    const repository = project.fullName.split('/')[1] ?? '';
    // PLAN 5.5: the server opens the PR itself, so the agent never needs pull_requests:write.
    const permissions: Record<string, 'read' | 'write'> =
      p.purpose === 'clone' ? { contents: 'read' } : { contents: 'write' };
    const minted = await this.deps.github.createInstallationToken(
      Number(project.installation.githubInstallationId),
      { repository, permissions },
    );
    await audit(this.prisma, {
      actorType: 'AGENT',
      actorUserId: agent.userId,
      actorAgentId: agent.id,
      agentId: agent.id,
      action: 'token.minted',
      projectId: project.id,
      taskId: a.taskId,
      data: {
        assignmentId: a.id,
        purpose: p.purpose,
        repository: project.fullName,
        permissions,
        expiresAt: minted.expiresAt.toISOString(),
      },
    });
    return {
      ok: true,
      token: minted.token,
      expiresAt: minted.expiresAt,
      repository: project.fullName,
      permissions,
    };
  }

  // ---------- agent side: progress ----------

  /** Common checks for task.status / task.pushed / task.finished. */
  private async progressTarget(
    agent: AgentWithUser,
    assignmentId: string,
    seq: number,
  ): Promise<
    | { a: NonNullable<Awaited<ReturnType<TaskService['liveAssignment']>>>; err: null }
    | { a: null; err: AckPayload }
  > {
    const a = await this.liveAssignment(agent.id, assignmentId);
    if (!a) return { a: null, err: refuse('unknown_assignment', 'Unknown assignment') };
    if (seq <= a.lastSeq) return { a: null, err: { ok: true, duplicate: true } };
    if (!(LIVE_ASSIGNMENT as readonly string[]).includes(a.status)) {
      return { a: null, err: refuse('assignment_not_live', 'The assignment is over') };
    }
    return { a, err: null };
  }

  private agentAudit(
    agent: AgentWithUser,
    action: string,
    a: Assignment & { task: { projectId: string } },
    data: Prisma.InputJsonValue = {},
  ) {
    return audit(this.prisma, {
      actorType: 'AGENT',
      actorUserId: agent.userId,
      actorAgentId: agent.id,
      agentId: agent.id,
      action,
      projectId: a.task.projectId,
      taskId: a.taskId,
      data: { assignmentId: a.id, ...(data as object) },
    });
  }

  async onStatus(
    agent: AgentWithUser,
    p: { assignmentId: string; seq: number; state: string; detail?: string },
  ): Promise<AckPayload> {
    const t = await this.progressTarget(agent, p.assignmentId, p.seq);
    if (t.a === null) return t.err;
    const a = t.a;
    const first = a.status === 'ACCEPTED';
    await this.prisma.assignment.update({
      where: { id: a.id },
      data: {
        lastSeq: p.seq,
        ...(first ? { status: 'RUNNING', startedAt: new Date() } : {}),
      },
    });
    if (first) await this.agentAudit(agent, 'task.started', a);
    await this.agentAudit(agent, 'task.status', a, {
      state: p.state,
      ...(p.detail ? { detail: p.detail.slice(0, 500) } : {}),
    });
    return { ok: true };
  }

  async onPushed(
    agent: AgentWithUser,
    p: {
      assignmentId: string;
      seq: number;
      branch: string;
      headSha: string;
      changedFiles: number;
      summary: string;
    },
  ): Promise<{
    ack: AckPayload;
    prOpened?: { assignmentId: string; prNumber: number; prUrl: string };
  }> {
    const t = await this.progressTarget(agent, p.assignmentId, p.seq);
    if (t.a === null) return { ack: t.err };
    const a = t.a;
    const task = a.task;
    if (task.prNumber && task.prUrl) {
      // Already opened (e.g. a re-push): tell the agent again, nothing to create.
      await this.prisma.assignment.update({ where: { id: a.id }, data: { lastSeq: p.seq } });
      return {
        ack: { ok: true },
        prOpened: { assignmentId: a.id, prNumber: task.prNumber, prUrl: task.prUrl },
      };
    }
    if (p.branch !== task.branchName) {
      return { ack: refuse('branch_mismatch', `Expected branch ${task.branchName ?? '?'}`) };
    }
    if (!this.deps.github)
      return { ack: refuse('github_not_configured', 'GitHub is not configured') };
    const creator = await this.prisma.user.findUniqueOrThrow({ where: { id: task.createdById } });
    const draft = a.execMode === 'AUTO';
    const pr = await this.deps.github.createPullRequest(
      Number(task.project.installation.githubInstallationId),
      task.project.fullName,
      {
        head: p.branch,
        base: task.integrationBranch ?? task.baseBranch,
        title: task.title,
        body: buildPrBody(task, creator.login, agent.user.login, a.execMode ?? 'MANUAL', p),
        draft,
      },
    );
    await this.prisma.$transaction([
      this.prisma.task.update({
        where: { id: task.id },
        data: { status: 'IN_REVIEW', prNumber: pr.number, prUrl: pr.htmlUrl, headSha: p.headSha },
      }),
      this.prisma.assignment.update({
        where: { id: a.id },
        data: { status: 'PUSHED', lastSeq: p.seq },
      }),
    ]);
    await this.agentAudit(agent, 'task.pushed', a, {
      branch: p.branch,
      headSha: p.headSha,
      changedFiles: p.changedFiles,
    });
    await this.agentAudit(agent, 'task.pr_opened', a, {
      prNumber: pr.number,
      draft,
      execMode: a.execMode ?? 'MANUAL',
    });
    return {
      ack: { ok: true },
      prOpened: { assignmentId: a.id, prNumber: pr.number, prUrl: pr.htmlUrl },
    };
  }

  async onFinished(
    agent: AgentWithUser,
    p: {
      assignmentId: string;
      seq: number;
      outcome: 'succeeded' | 'failed' | 'cancelled' | 'no_changes';
      usage: { weighted: number; input: number; output: number };
      error?: string;
      failureClass?: FailureClass;
      rateLimitedUntil?: string;
    },
  ): Promise<AckPayload> {
    const t = await this.progressTarget(agent, p.assignmentId, p.seq);
    if (t.a === null) return t.err;
    const a = t.a;
    const status =
      p.outcome === 'succeeded' ? 'SUCCEEDED' : p.outcome === 'cancelled' ? 'CANCELLED' : 'FAILED';
    // Older agents send no class: classify their error text the same way.
    const failureClass: FailureClass | null =
      status !== 'FAILED'
        ? null
        : p.outcome === 'no_changes'
          ? 'task'
          : (p.failureClass ?? classifyFailure(p.error));
    const now = new Date();
    const [, returned] = await this.prisma.$transaction([
      this.prisma.assignment.update({
        where: { id: a.id },
        data: {
          status,
          lastSeq: p.seq,
          finishedAt: new Date(),
          reason: p.error?.slice(0, 1000) ?? (p.outcome === 'no_changes' ? 'no_changes' : null),
          failureClass,
          usageWeighted: BigInt(Math.round(p.usage.weighted)),
        },
      }),
      // Without a PR nothing was delivered: the task goes back to the pool. Only while this run
      // still holds it: a task already IN_REVIEW or DONE (PR opened or merged meanwhile) stays.
      this.prisma.task.updateMany({
        where: { id: a.taskId, status: 'IN_PROGRESS', assigneeAgentId: agent.id },
        data: { status: 'TODO', assigneeId: null, assigneeAgentId: null },
      }),
    ]);
    await this.agentAudit(agent, 'task.finished', a, {
      outcome: p.outcome,
      weighted: p.usage.weighted,
      ...(p.error ? { error: summarizeFailure(p.error, 500) } : {}),
      ...(failureClass ? { failureClass } : {}),
      returnedToPool: returned.count === 1,
    });
    await this.afterRun(agent, a, status, failureClass, p, now);
    return { ok: true };
  }

  /** What a finished run means beyond the run itself (see dispatch/failures). */
  private async afterRun(
    agent: AgentWithUser,
    a: Assignment,
    status: 'SUCCEEDED' | 'CANCELLED' | 'FAILED',
    failureClass: FailureClass | null,
    p: { error?: string; rateLimitedUntil?: string },
    now: Date,
  ): Promise<void> {
    const { prisma } = this;
    if (status === 'SUCCEEDED' && !agent.claudeAuthValid) {
      // A real run went through: the login works again.
      await prisma.agent.update({
        where: { id: agent.id },
        data: { claudeAuthValid: true, claudeAuthInvalidAt: null },
      });
      return;
    }
    if (failureClass === 'claude_auth') {
      await prisma.agent.update({
        where: { id: agent.id },
        data: { claudeAuthValid: false, claudeAuthInvalidAt: now },
      });
      if (agent.claudeAuthValid) {
        await audit(prisma, {
          actorType: 'SYSTEM',
          action: 'agent.claude_auth_invalid',
          targetUserId: agent.userId,
          agentId: agent.id,
          taskId: a.taskId,
          data: { assignmentId: a.id },
        });
      }
      return;
    }
    if (failureClass === 'rate_limited') {
      const parsed = p.rateLimitedUntil ? new Date(p.rateLimitedUntil) : null;
      const until =
        parsed && parsed.getTime() > now.getTime()
          ? parsed
          : new Date(now.getTime() + RATE_LIMIT_FALLBACK_MS);
      // The existing mechanism: the member's latest usage report carries `rateLimitedUntil`
      // (kept by the following reports while it lies in the future, see recordUsage).
      const latest = await prisma.usageReport.findFirst({
        where: { agentId: agent.id },
        orderBy: { reportedAt: 'desc' },
      });
      if (latest && (!latest.rateLimitedUntil || latest.rateLimitedUntil < until)) {
        await prisma.usageReport.update({
          where: { id: latest.id },
          data: { rateLimitedUntil: until },
        });
      }
      return;
    }
    if (failureClass === 'env') {
      const task = await prisma.task.findUniqueOrThrow({ where: { id: a.taskId } });
      if (task.needsAttention) return;
      const envFailures = await prisma.assignment.findMany({
        where: { taskId: a.taskId, status: 'FAILED' },
        select: { failureClass: true, reason: true, finishedAt: true, updatedAt: true },
      });
      const count = envFailures.filter(
        (f) => failureClassOf(f) === 'env' && !beforeRetry(f, task.retryResetAt),
      ).length;
      if (count < ENV_FAILURES_BEFORE_ATTENTION) return;
      const reason = attentionReason(p.error ?? null);
      const r = await prisma.task.updateMany({
        where: { id: a.taskId, needsAttention: false },
        data: { needsAttention: true, needsAttentionReason: reason, needsAttentionAt: now },
      });
      if (r.count === 1) {
        await audit(prisma, {
          actorType: 'SYSTEM',
          action: 'task.needs_attention',
          projectId: task.projectId,
          taskId: a.taskId,
          data: { envFailures: count, reason },
        });
      }
    }
  }

  async onDoneRequest(agent: AgentWithUser, assignmentId: string): Promise<AckPayload> {
    const a = await this.liveAssignment(agent.id, assignmentId);
    if (!a) return refuse('unknown_assignment', 'Unknown assignment');
    if (!(LIVE_ASSIGNMENT as readonly string[]).includes(a.status)) {
      return refuse('assignment_not_live', 'The assignment is over');
    }
    await this.agentAudit(agent, 'task.done_requested', a);
    return { ok: true };
  }
}

export function buildPrompt(t: {
  title: string;
  bodySnapshot: string;
  acceptanceCriteria: string[];
}) {
  const parts = [`# ${t.title}`, '', t.bodySnapshot];
  if (t.acceptanceCriteria.length > 0) {
    parts.push('', 'Acceptance criteria:', ...t.acceptanceCriteria.map((c) => `- ${c}`));
  }
  return parts.join('\n').trim();
}

function buildPrBody(
  task: { githubIssueNumber: number; acceptanceCriteria: string[]; size: string; model: string },
  creatorLogin: string,
  runnerLogin: string,
  execMode: string,
  p: { headSha: string; changedFiles: number; summary: string },
): string {
  const lines = [`Closes #${task.githubIssueNumber}`, ''];
  if (task.acceptanceCriteria.length > 0) {
    lines.push('## Acceptance criteria', ...task.acceptanceCriteria.map((c) => `- [ ] ${c}`), '');
  }
  if (p.summary.trim()) lines.push('## Summary', p.summary.trim().slice(0, 5000), '');
  lines.push(
    '---',
    `Opened by orch. Task by @${creatorLogin}, run by @${runnerLogin} (${execMode.toLowerCase()} mode, model ${task.model.toLowerCase()}, size ${task.size}).`,
    `Head: ${p.headSha.slice(0, 12)}, ${p.changedFiles} changed file(s).`,
  );
  return lines.join('\n');
}

export type { ServerMessage, Project };
export { serverMessage };
