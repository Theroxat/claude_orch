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
import { participationStatus } from '../projects/service';

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
}

/**
 * Members of the caller's projects (owned or participating), every usage figure an ESTIMATE.
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
    include: { participations: { where: { userId: user.id } } },
    orderBy: { fullName: 'asc' },
  });
  // Owners and ACTIVE participants only: a pending, rejected or inactive row sees nothing.
  const projects = candidates.filter(
    (p) =>
      p.addedById === user.id ||
      p.participations.some(
        (r) => participationStatus(r, p.requireParticipantApproval) === 'active',
      ),
  );
  if (projectId && projects.length === 0) {
    throw new HttpError(404, 'not_found', 'Project not found');
  }
  const owned = new Set(projects.filter((p) => p.addedById === user.id).map((p) => p.id));
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
    const projectsOut = [];
    for (const p of list) {
      const m = fresh
        ? await dispatcher.marginOf(userId, p.projectId, p.percent, fresh, now)
        : null;
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
      where: { userId, status: { in: ['ACCEPTED', 'RUNNING', 'PUSHED'] } },
      include: { task: { include: { project: true } } },
      orderBy: { offeredAt: 'asc' },
    });
    members.push({
      userId,
      login: u.login,
      avatarUrl: u.avatarUrl,
      online: agents.some((a) => gateway.isConnected(a.id)),
      paused: u.paused || (agents.length > 0 && agents.every((a) => a.paused)),
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
