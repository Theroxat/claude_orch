import type { Prisma } from '@prisma/client';
import type { PrismaClient } from '../db';

export interface AuditEntry {
  actorType?: 'USER' | 'AGENT' | 'SYSTEM' | 'GITHUB';
  actorUserId?: string;
  action: string;
  projectId?: string;
  targetUserId?: string;
  /** Set when the actor is an agent (actorType AGENT). */
  actorAgentId?: string;
  /** The agent the action is about. */
  agentId?: string;
  ip?: string;
  /** Never put secrets here. */
  data?: Prisma.InputJsonValue;
}

export async function audit(prisma: PrismaClient, e: AuditEntry): Promise<void> {
  await prisma.auditLog.create({
    data: {
      actorType: e.actorType ?? 'USER',
      actorUserId: e.actorUserId,
      action: e.action,
      projectId: e.projectId,
      targetUserId: e.targetUserId,
      actorAgentId: e.actorAgentId,
      agentId: e.agentId,
      ip: e.ip,
      data: e.data ?? {},
    },
  });
}
