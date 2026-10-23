/**
 * Consent guard (PLAN section 6, "enforced twice"). Nothing may auto-start on a member's machine
 * unless the member participates in the project (active, approved when required), is in AUTO
 * mode and neither the member nor the agent is paused. There is no override: owners and admins
 * go through the same check.
 */
import type { Prisma } from '@prisma/client';
import type { PrismaClient } from '../db';
import { participationStatus } from '../projects/service';

export class ConsentError extends Error {
  constructor(readonly code: 'not_participating' | 'not_auto' | 'paused' | 'agent') {
    super(`No consent for an automatic start: ${code}`);
  }
}

type Db = PrismaClient | Prisma.TransactionClient;

/** Throws ConsentError unless an AUTO offer to this member (and agent) is allowed right now. */
export async function assertAutoConsent(
  db: Db,
  userId: string,
  projectId: string,
  agentId: string | null,
): Promise<{ percent: number }> {
  const p = await db.participation.findUnique({
    where: { userId_projectId: { userId, projectId } },
    include: { project: true, user: true },
  });
  if (
    !p ||
    p.project.archivedAt ||
    participationStatus(p, p.project.requireParticipantApproval) !== 'active'
  ) {
    throw new ConsentError('not_participating');
  }
  if (p.mode !== 'AUTO') throw new ConsentError('not_auto');
  if (p.user.paused) throw new ConsentError('paused');
  if (agentId !== null) {
    const agent = await db.agent.findUnique({ where: { id: agentId } });
    if (!agent || agent.userId !== userId || agent.revokedAt) throw new ConsentError('agent');
    if (agent.paused) throw new ConsentError('paused');
  }
  return p;
}

/** Same for a member who explicitly accepts a request: participation is required, not AUTO mode. */
export async function assertParticipates(db: Db, userId: string, projectId: string) {
  const p = await db.participation.findUnique({
    where: { userId_projectId: { userId, projectId } },
    include: { project: true },
  });
  if (
    !p ||
    p.project.archivedAt ||
    participationStatus(p, p.project.requireParticipantApproval) !== 'active'
  ) {
    throw new ConsentError('not_participating');
  }
  return p;
}
