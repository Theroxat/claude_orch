import type { FastifyInstance } from 'fastify';
import {
  UpsertParticipationRequestSchema,
  type ParticipantItem,
  type ParticipationView,
} from '@orch/shared';
import { audit } from '../audit';
import { requireUser, toApiUser, type AuthDeps } from '../auth';
import { HttpError, parseBody } from '../http/errors';
import { canParticipate, canSee } from '../projects/roles';
import { getRoleInfo, toParticipationView } from '../projects/service';

export function registerParticipation(app: FastifyInstance, deps: AuthDeps): void {
  const { prisma } = deps;

  /**
   * Consent rule: the only writer of active/percent/mode is the member via this PUT.
   * Owner routes below touch approvedAt/rejectedAt only.
   */
  app.put('/api/projects/:id/participation', async (req): Promise<ParticipationView> => {
    const user = requireUser(req);
    const { id } = req.params as { id: string };
    const body = parseBody(UpsertParticipationRequestSchema, req.body);
    const project = await prisma.project.findUnique({
      where: { id },
      include: { installation: true },
    });
    if (!project || project.archivedAt) throw new HttpError(404, 'not_found', 'Project not found');
    const isOwner = project.addedById === user.id;

    if (!isOwner) {
      const info = await getRoleInfo(prisma, deps.github, project, user);
      if (!canSee(project.visibility, info.role, info)) {
        throw new HttpError(404, 'not_found', 'Project not found');
      }
      if (body.participating && !canParticipate(project.participationPolicy, info.role, info)) {
        throw new HttpError(403, 'not_allowed', 'You may not participate in this project');
      }
    }

    const others = await prisma.participation.aggregate({
      where: { userId: user.id, active: true, projectId: { not: project.id } },
      _sum: { percent: true },
    });
    const total = (others._sum.percent ?? 0) + (body.participating ? body.budgetPercent : 0);
    if (total > 100) {
      throw new HttpError(
        409,
        'budget_exceeded',
        `Active budgets would total ${total}%, the maximum is 100%`,
      );
    }

    const mode = body.mode === 'auto' ? 'AUTO' : 'APPROVAL';
    const approvedAt = isOwner ? new Date() : undefined;
    const part = await prisma.participation.upsert({
      where: { userId_projectId: { userId: user.id, projectId: project.id } },
      create: {
        userId: user.id,
        projectId: project.id,
        active: body.participating,
        percent: body.budgetPercent,
        mode,
        approvedAt,
      },
      update: {
        active: body.participating,
        percent: body.budgetPercent,
        mode,
        // Asking again after a rejection puts the request back to pending.
        ...(body.participating ? { rejectedAt: null } : {}),
        ...(approvedAt ? { approvedAt } : {}),
      },
    });
    await audit(prisma, {
      actorUserId: user.id,
      action: 'participation.updated',
      projectId: project.id,
      data: { active: part.active, percent: part.percent, mode: part.mode },
      ip: req.ip,
    });
    return toParticipationView(part, project.requireParticipantApproval);
  });

  async function ownedProject(id: string, userId: string) {
    const project = await prisma.project.findUnique({ where: { id } });
    if (!project) throw new HttpError(404, 'not_found', 'Project not found');
    if (project.addedById !== userId) {
      throw new HttpError(403, 'forbidden', 'Only the project owner can do this');
    }
    return project;
  }

  app.get('/api/projects/:id/participants', async (req): Promise<ParticipantItem[]> => {
    const user = requireUser(req);
    const { id } = req.params as { id: string };
    const project = await ownedProject(id, user.id);
    const rows = await prisma.participation.findMany({
      where: { projectId: project.id },
      include: { user: true },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((r) => ({
      user: toApiUser(r.user),
      participation: toParticipationView(r, project.requireParticipantApproval),
    }));
  });

  for (const decision of ['approve', 'reject'] as const) {
    app.post(`/api/projects/:id/participants/:userId/${decision}`, async (req) => {
      const user = requireUser(req);
      const { id, userId } = req.params as { id: string; userId: string };
      const project = await ownedProject(id, user.id);
      const existing = await prisma.participation.findUnique({
        where: { userId_projectId: { userId, projectId: project.id } },
      });
      if (!existing) throw new HttpError(404, 'not_found', 'Participation not found');
      // Only the decision timestamps change: active, percent and mode stay the member's choice.
      const part = await prisma.participation.update({
        where: { id: existing.id },
        data:
          decision === 'approve'
            ? { approvedAt: new Date(), rejectedAt: null }
            : { approvedAt: null, rejectedAt: new Date() },
      });
      await audit(prisma, {
        actorUserId: user.id,
        action: `participation.${decision}d`,
        projectId: project.id,
        targetUserId: userId,
        ip: req.ip,
      });
      return toParticipationView(part, project.requireParticipantApproval);
    });
  }
}
