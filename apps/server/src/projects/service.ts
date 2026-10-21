import type { Participation, Project, User } from '@prisma/client';
import type { GithubRole, ParticipationView, ProjectView, ParticipationStatus } from '@orch/shared';
import type { PrismaClient } from '../db';
import type { GithubClient } from '../github';

export const ROLE_CACHE_TTL_MS = 5 * 60 * 1000;

export function toProjectView(p: Project): ProjectView {
  return {
    id: p.id,
    githubRepoId: Number(p.githubRepoId),
    fullName: p.fullName,
    isPrivate: p.isPrivate,
    defaultBranch: p.defaultBranch,
    visibility: p.visibility,
    requireParticipantApproval: p.requireParticipantApproval,
    whoCanParticipate: p.participationPolicy,
    whoCanSubmit: p.submissionPolicy === 'ALLOWLIST' ? 'ALLOWLIST' : 'GITHUB',
    ownerId: p.addedById,
    createdAt: p.createdAt.toISOString(),
  };
}

export function participationStatus(
  p: Participation,
  requireApproval: boolean,
): ParticipationStatus {
  if (p.rejectedAt && !p.approvedAt) return 'rejected';
  if (!p.active) return 'inactive';
  return !requireApproval || p.approvedAt ? 'active' : 'pending';
}

export function toParticipationView(p: Participation, requireApproval: boolean): ParticipationView {
  return {
    id: p.id,
    projectId: p.projectId,
    userId: p.userId,
    participating: p.active,
    budgetPercent: p.percent,
    mode: p.mode === 'AUTO' ? 'auto' : 'approval',
    status: participationStatus(p, requireApproval),
    approvedAt: p.approvedAt ? p.approvedAt.toISOString() : null,
  };
}

export interface RoleInfo {
  role: GithubRole;
  canSubmit: boolean | null;
  canParticipate: boolean | null;
}

/** GitHub role of a user on a project, cached in ProjectPermission for a few minutes. */
export async function getRoleInfo(
  prisma: PrismaClient,
  github: GithubClient | undefined,
  project: Project & { installation: { githubInstallationId: bigint } },
  user: Pick<User, 'id' | 'login'>,
): Promise<RoleInfo> {
  const cached = await prisma.projectPermission.findUnique({
    where: { projectId_userId: { projectId: project.id, userId: user.id } },
  });
  const info = (role: GithubRole): RoleInfo => ({
    role,
    canSubmit: cached?.canSubmit ?? null,
    canParticipate: cached?.canParticipate ?? null,
  });
  if (cached && Date.now() - cached.syncedAt.getTime() < ROLE_CACHE_TTL_MS) {
    return info(cached.githubRole);
  }
  if (!github) return info(cached?.githubRole ?? 'NONE');
  let role: GithubRole;
  try {
    role = await github.getUserRole(
      Number(project.installation.githubInstallationId),
      project.fullName,
      user.login,
    );
  } catch {
    return info(cached?.githubRole ?? 'NONE');
  }
  await prisma.projectPermission.upsert({
    where: { projectId_userId: { projectId: project.id, userId: user.id } },
    create: { projectId: project.id, userId: user.id, githubRole: role, syncedAt: new Date() },
    update: { githubRole: role, syncedAt: new Date() },
  });
  return info(role);
}
