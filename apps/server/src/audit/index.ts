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
  taskId?: string;
  ip?: string;
  /** Never put secrets here. */
  data?: Prisma.InputJsonValue;
}

/**
 * Called after an audit row is written. Listeners must not block (they queue their own work) and
 * their errors never reach the caller: auditing is on the request path.
 */
export type AuditListener = (e: AuditEntry) => void;

/** Per client, so several apps in one process (tests) each hear only their own database. */
const listeners = new WeakMap<PrismaClient, Set<AuditListener>>();

/** Subscribes to audit events written through `prisma`. Returns the unsubscribe function. */
export function onAudit(prisma: PrismaClient, listener: AuditListener): () => void {
  let set = listeners.get(prisma);
  if (!set) listeners.set(prisma, (set = new Set()));
  set.add(listener);
  return () => set.delete(listener);
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
      taskId: e.taskId,
      ip: e.ip,
      data: e.data ?? {},
    },
  });
  const set = listeners.get(prisma);
  if (!set) return;
  for (const l of set) {
    try {
      l(e);
    } catch {
      // A listener bug must not fail the audited action.
    }
  }
}
