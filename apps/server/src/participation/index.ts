import type { FastifyInstance } from 'fastify';
import type { User } from '@prisma/client';
import {
  RejectParticipantRequestSchema,
  UndoRejectionRequestSchema,
  UpsertParticipationRequestSchema,
  type ParticipantItem,
  type ParticipationView,
} from '@orch/shared';
import { audit } from '../audit';
import { requireUser, toApiUser, type AuthDeps } from '../auth';
import type { Dispatcher } from '../dispatch/dispatcher';
import { HttpError, parseBody } from '../http/errors';
import { canParticipate, canSee } from '../projects/roles';
import {
  getRoleInfo,
  isCurrentOwner,
  participationStatus,
  toParticipationView,
} from '../projects/service';

export function registerParticipation(
  app: FastifyInstance,
  deps: AuthDeps & { dispatcher?: Dispatcher },
): void {
  const { prisma } = deps;

  /**
   * Consent rule: the only writer of active/percent/mode is the member via this PUT.
   * Owner routes below touch approvedAt/rejectedAt (and the rejection note) only. The owner's own
   * row goes through this same PUT, so the owner joins their pool only by their own choice; it is
   * auto-approved because the approver is the member.
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
    const isOwner = await isCurrentOwner(prisma, deps.github, project, user);

    if (!isOwner) {
      const info = await getRoleInfo(prisma, deps.github, project, user);
      if (!canSee(project.visibility, info.role, info)) {
        throw new HttpError(404, 'not_found', 'Project not found');
      }
      if (body.participating && !canParticipate(project.participationPolicy, info.role, info)) {
        throw new HttpError(403, 'not_allowed', 'You may not participate in this project');
      }
    }

    if (!body.participating) {
      // Opting out never creates a row: it only switches off an existing one.
      const existing = await prisma.participation.findUnique({
        where: { userId_projectId: { userId: user.id, projectId: project.id } },
      });
      if (!existing) {
        return {
          id: '',
          projectId: project.id,
          userId: user.id,
          participating: false,
          budgetPercent: body.budgetPercent,
          mode: body.mode === 'auto' ? 'auto' : 'approval',
          status: 'inactive',
          approvedAt: null,
          rejectionReason: null,
          previouslyRejectedAt: null,
        };
      }
    }

    const mode = body.mode === 'auto' ? 'AUTO' : 'APPROVAL';
    const approvedAt = isOwner ? new Date() : undefined;
    // The budget check and the write run in one transaction that locks the member's user row,
    // so concurrent PUTs on different projects cannot each see the old total and overshoot 100%.
    let reapplied = false;
    // Whether this write turns the row into a pending request (owners are told once, not on every
    // budget change of a request that is already pending).
    let requested = false;
    const part = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM "User" WHERE "id" = ${user.id} FOR UPDATE`;
      const before = await tx.participation.findUnique({
        where: { userId_projectId: { userId: user.id, projectId: project.id } },
      });
      reapplied = body.participating && !!before?.rejectedAt && !before.approvedAt && !isOwner;
      const others = await tx.participation.aggregate({
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

      const after = await tx.participation.upsert({
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
          // Asking again after a rejection puts the request back to pending. The reason and
          // lastRejectedAt stay, so the owner sees "previously rejected" on the new request.
          ...(body.participating ? { rejectedAt: null } : {}),
          ...(approvedAt ? { approvedAt } : {}),
        },
      });
      const needsApproval = project.requireParticipantApproval;
      requested =
        participationStatus(after, needsApproval) === 'pending' &&
        (!before || participationStatus(before, needsApproval) !== 'pending');
      return after;
    });
    await audit(prisma, {
      actorUserId: user.id,
      action: 'participation.updated',
      projectId: project.id,
      data: {
        active: part.active,
        percent: part.percent,
        mode: part.mode,
        reapplied,
        requested,
        ownerAutoApproved: isOwner && part.active,
      },
      ip: req.ip,
    });
    await deps.dispatcher?.onParticipationChanged(user.id, project.id);
    return toParticipationView(part, project.requireParticipantApproval);
  });

  async function ownedProject(id: string, user: User) {
    const project = await prisma.project.findUnique({
      where: { id },
      include: { installation: true },
    });
    if (!project) throw new HttpError(404, 'not_found', 'Project not found');
    if (!(await isCurrentOwner(prisma, deps.github, project, user))) {
      throw new HttpError(403, 'forbidden', 'Only the project owner can do this');
    }
    return project;
  }

  app.get('/api/projects/:id/participants', async (req): Promise<ParticipantItem[]> => {
    const user = requireUser(req);
    const { id } = req.params as { id: string };
    const project = await ownedProject(id, user);
    const rows = await prisma.participation.findMany({
      where: { projectId: project.id },
      include: { user: true },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((r) => ({
      user: toApiUser(r.user, app.allowlist.isAdmin(r.user.login)),
      participation: toParticipationView(r, project.requireParticipantApproval),
    }));
  });

  for (const decision of ['approve', 'reject'] as const) {
    app.post(`/api/projects/:id/participants/:userId/${decision}`, async (req) => {
      const user = requireUser(req);
      const { id, userId } = req.params as { id: string; userId: string };
      const project = await ownedProject(id, user);
      const reason =
        decision === 'reject'
          ? parseBody(RejectParticipantRequestSchema, req.body).reason || null
          : null;
      const existing = await prisma.participation.findUnique({
        where: { userId_projectId: { userId, projectId: project.id } },
      });
      if (!existing) throw new HttpError(404, 'not_found', 'Participation not found');
      if (decision === 'reject' && userId === project.addedById) {
        throw new HttpError(400, 'cannot_reject_owner', 'The owner cannot be rejected');
      }
      const now = new Date();
      // Only the decision fields change: active, percent and mode stay the member's choice.
      const part = await prisma.participation.update({
        where: { id: existing.id },
        data:
          decision === 'approve'
            ? { approvedAt: now, rejectedAt: null, rejectionReason: null, lastRejectedAt: null }
            : { approvedAt: null, rejectedAt: now, rejectionReason: reason, lastRejectedAt: now },
      });
      await audit(prisma, {
        actorUserId: user.id,
        action: decision === 'approve' ? 'participation.approved' : 'participation.rejected',
        projectId: project.id,
        targetUserId: userId,
        ...(decision === 'reject' ? { data: { reason } } : {}),
        ip: req.ip,
      });
      await deps.dispatcher?.onParticipationChanged(userId, project.id);
      return toParticipationView(part, project.requireParticipantApproval);
    });
  }

  app.post('/api/projects/:id/participants/:userId/undo-rejection', async (req) => {
    const user = requireUser(req);
    const { id, userId } = req.params as { id: string; userId: string };
    const project = await ownedProject(id, user);
    const { to } = parseBody(UndoRejectionRequestSchema, req.body);
    const existing = await prisma.participation.findUnique({
      where: { userId_projectId: { userId, projectId: project.id } },
    });
    if (!existing) throw new HttpError(404, 'not_found', 'Participation not found');
    if (participationStatus(existing, project.requireParticipantApproval) !== 'rejected') {
      throw new HttpError(409, 'not_rejected', 'This participation is not rejected');
    }
    // Back to the member's own choice (active, percent, mode untouched), pending or approved.
    const part = await prisma.participation.update({
      where: { id: existing.id },
      data: {
        rejectedAt: null,
        rejectionReason: null,
        lastRejectedAt: null,
        approvedAt: to === 'approved' ? new Date() : null,
      },
    });
    await audit(prisma, {
      actorUserId: user.id,
      action: 'participation.rejection_undone',
      projectId: project.id,
      targetUserId: userId,
      data: { to },
      ip: req.ip,
    });
    await deps.dispatcher?.onParticipationChanged(userId, project.id);
    return toParticipationView(part, project.requireParticipantApproval);
  });
}
