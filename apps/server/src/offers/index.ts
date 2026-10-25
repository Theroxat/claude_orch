/**
 * M4 REST: requests for approval-mode members and the Pool page (contract in shared api/m4).
 */
import type { Prisma, User } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import type { OfferView, PoolMember, PoolResponse } from '@orch/shared';
import type { AgentGateway } from '../agents/gateway';
import { requireUser, type AuthDeps } from '../auth';
import type { Config } from '../config';
import { issueUrlFor } from '../tasks/service';
import type { PrismaClient } from '../db';
import { usageState } from '../dispatch/budget';
import type { Dispatcher } from '../dispatch/dispatcher';
import { HttpError } from '../http/errors';
import type { GithubClient } from '../github';
import { canSubmit } from '../projects/roles';
import { getRoleInfo, participationStatus, stillOwns } from '../projects/service';

const offerInclude = {
  task: { include: { project: true, createdBy: true } },
} satisfies Prisma.AssignmentInclude;
type OfferRow = Prisma.AssignmentGetPayload<{ include: typeof offerInclude }>;

function toOfferView(a: OfferRow, webUrl: string): OfferView {
  const t = a.task;
  return {
    id: a.id,
    kind: a.kind,
    status: a.status,
    offeredAt: a.offeredAt.toISOString(),
    expiresAt: a.expiresAt?.toISOString() ?? null,
    task: {
      id: t.id,
      projectId: t.projectId,
      projectFullName: t.project.fullName,
      issueNumber: t.githubIssueNumber,
      issueUrl: issueUrlFor(webUrl, t.project.fullName, t.githubIssueNumber),
      title: t.title,
      body: t.bodySnapshot,
      acceptanceCriteria: t.acceptanceCriteria,
      size: t.size,
      model: t.model,
      createdBy: {
        id: t.createdBy.id,
        githubLogin: t.createdBy.login,
        avatarUrl: t.createdBy.avatarUrl,
      },
    },
    acceptCommand: `orch accept ${a.id}`,
    requestedBy: { githubLogin: t.createdBy.login, avatarUrl: t.createdBy.avatarUrl },
  };
}

const ERROR_STATUS: Record<string, number> = { not_found: 404 };

export function registerOffers(
  app: FastifyInstance,
  deps: AuthDeps & { dispatcher: Dispatcher; gateway: AgentGateway },
): void {
  const { prisma, dispatcher, config } = deps;

  app.get('/api/offers/mine', async (req): Promise<OfferView[]> => {
    const user = requireUser(req);
    const rows = await prisma.assignment.findMany({
      where: {
        userId: user.id,
        kind: 'CONSENT_REQUEST',
        status: 'PENDING',
        expiresAt: { gt: new Date() },
      },
      include: offerInclude,
      orderBy: { offeredAt: 'asc' },
    });
    return rows.map((r) => toOfferView(r, config.GITHUB_WEB_URL));
  });

  for (const action of ['accept', 'reject'] as const) {
    app.post(`/api/offers/:id/${action}`, async (req): Promise<OfferView> => {
      const user = requireUser(req);
      const { id } = req.params as { id: string };
      const existing = await prisma.assignment.findUnique({ where: { id } });
      // The web answers requests only: auto offers belong to the machine they were sent to.
      if (!existing || existing.userId !== user.id || existing.kind !== 'CONSENT_REQUEST') {
        throw new HttpError(404, 'not_found', 'No such offer');
      }
      const by = { userId: user.id, via: 'web' as const };
      const r =
        action === 'accept'
          ? await dispatcher.accept(id, by)
          : await dispatcher.reject(id, by, 'user_declined');
      if (!r.ok) throw new HttpError(ERROR_STATUS[r.code] ?? 409, r.code, r.message);
      const row = await prisma.assignment.findUniqueOrThrow({
        where: { id },
        include: offerInclude,
      });
      return toOfferView(row, config.GITHUB_WEB_URL);
    });
  }

  app.get('/api/pool', async (req): Promise<PoolResponse> => {
    const user = requireUser(req);
    const { projectId } = req.query as { projectId?: string };
    return buildPool(deps, user, projectId);
  });
}

export interface PoolDeps {
  prisma: PrismaClient;
  config: Config;
  dispatcher: Dispatcher;
  gateway: AgentGateway;
  github?: GithubClient;
}

/**
 * Members of the caller's projects (owned or participating), every usage figure an ESTIMATE.
 * With `projectId`, a submitter of that project who does not participate sees it too: they may
 * send a task to specific members and need to know who participates.
 * Shared by `GET /api/pool` and the MCP `view_pool` tool. 404 when `projectId` is not visible.
 */
export async function buildPool(
  deps: PoolDeps,
  user: User,
  projectId?: string,
): Promise<PoolResponse> {
  const { prisma, dispatcher, gateway, config } = deps;
  const candidates = await prisma.project.findMany({
    where: {
      archivedAt: null,
      ...(projectId ? { id: projectId } : {}),
      OR: [{ addedById: user.id }, { participations: { some: { userId: user.id } } }],
    },
    include: { participations: { where: { userId: user.id } }, installation: true },
    orderBy: { fullName: 'asc' },
  });
  // Owners and ACTIVE participants only: a pending, rejected or inactive row sees nothing. A
  // private repository's stored owner counts only while GitHub still gives them ADMIN, and an
  // owner who lost the repository entirely is not let back in through an old participation row.
  const projects = [];
  const ownedIds = new Set<string>();
  for (const p of candidates) {
    if (await stillOwns(deps.prisma, deps.github, p, user)) {
      projects.push(p);
      ownedIds.add(p.id);
      continue;
    }
    if (p.addedById === user.id && p.isPrivate && deps.github) {
      const role = (await getRoleInfo(deps.prisma, deps.github, p, user)).role;
      if (role === 'NONE') continue;
    }
    if (
      p.participations.some(
        (r) => participationStatus(r, p.requireParticipantApproval) === 'active',
      )
    ) {
      projects.push(p);
    }
  }
  if (projectId && projects.length === 0) {
    const asSubmitter = await submitterProject(deps, user, projectId);
    if (!asSubmitter) throw new HttpError(404, 'not_found', 'Project not found');
    projects.push(asSubmitter);
  }
  const owned = ownedIds;
  const parts = await prisma.participation.findMany({
    where: { projectId: { in: projects.map((p) => p.id) }, active: true },
    include: { user: { include: { agents: true } }, project: true },
    orderBy: { createdAt: 'asc' },
  });
  const now = new Date();
  const staleMs = config.USAGE_STALE_SEC * 1000;
  const byUser = new Map<string, typeof parts>();
  for (const p of parts) {
    if (participationStatus(p, p.project.requireParticipantApproval) !== 'active') continue;
    byUser.set(p.userId, [...(byUser.get(p.userId) ?? []), p]);
  }
  const members: PoolMember[] = [];
  for (const [userId, list] of byUser) {
    const u = list[0]!.user;
    const agents = u.agents.filter((a) => !a.revokedAt);
    const usage = await dispatcher.latestUsage(userId);
    const state = usageState(usage, now, staleMs);
    const fresh = usage && state === 'fresh' ? usage : null;
    // One ledger per member (a few batched reads), then every project's margin in memory.
    const ledger = fresh ? await dispatcher.budgetLedger(userId, fresh, now) : null;
    const projectsOut = [];
    for (const p of list) {
      const m = fresh && ledger ? ledger.marginOf(userId, p.projectId, p.percent, fresh) : null;
      projectsOut.push({
        projectId: p.projectId,
        fullName: p.project.fullName,
        mode: p.mode,
        budgetPercent: p.percent,
        estimatedBudget: m ? Math.round(m.budget) : null,
        estimatedMargin: m ? Math.round(Math.max(0, m.margin)) : null,
        marginFraction: m && m.budget > 0 ? Math.max(0, Math.min(1, m.margin / m.budget)) : null,
        isOwner: owned.has(p.projectId),
      });
    }
    const running = await prisma.assignment.findMany({
      // Only tasks of the projects listed for the caller: never leak other (private) repos.
      where: {
        userId,
        status: { in: ['ACCEPTED', 'RUNNING', 'PUSHED'] },
        task: { projectId: { in: projects.map((p) => p.id) } },
      },
      include: { task: { include: { project: true } } },
      orderBy: { offeredAt: 'asc' },
    });
    members.push({
      userId,
      login: u.login,
      avatarUrl: u.avatarUrl,
      online: agents.some((a) => gateway.isConnected(a.id)),
      paused: u.paused || (agents.length > 0 && agents.every((a) => a.paused)),
      machines: agents.map((a) => ({
        name: a.name,
        online: gateway.isConnected(a.id),
        paused: a.paused,
      })),
      usageStale: state !== 'fresh',
      resetAt: usage?.windowResetAt?.toISOString() ?? null,
      rateLimitedUntil: usage?.rateLimitedUntil?.toISOString() ?? null,
      projects: projectsOut,
      runningTasks: running.map((a) => ({
        taskId: a.task.id,
        projectId: a.task.projectId,
        issueNumber: a.task.githubIssueNumber,
        title: a.task.title,
        status: a.status,
        projectFullName: a.task.project.fullName,
        issueUrl: issueUrlFor(
          config.GITHUB_WEB_URL,
          a.task.project.fullName,
          a.task.githubIssueNumber,
        ),
      })),
    });
  }
  return {
    estimate: true,
    members,
    projects: projects.map((p) => ({
      projectId: p.id,
      fullName: p.fullName,
      isOwner: owned.has(p.id),
    })),
  };
}

/** The project when the user may submit tasks to it (same rule as task creation), else null. */
async function submitterProject(deps: PoolDeps, user: User, projectId: string) {
  const project = await deps.prisma.project.findFirst({
    where: { id: projectId, archivedAt: null },
    include: { installation: true },
  });
  if (!project) return null;
  const info = await getRoleInfo(deps.prisma, deps.github, project, user);
  const policy = project.submissionPolicy === 'ALLOWLIST' ? 'ALLOWLIST' : 'GITHUB';
  if (!canSubmit(policy, info.role, info)) return null;
  return { ...project, participations: [] };
}
