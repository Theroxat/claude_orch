import type { Participation, Prisma, Project, User } from '@prisma/client';
import type { GithubRole, ParticipationView, ProjectView, ParticipationStatus } from '@orch/shared';
import type { PrismaClient } from '../db';
import type { GithubClient } from '../github';

export const ROLE_CACHE_TTL_MS = 5 * 60 * 1000;
export const DEFAULT_GRACE_MS = 15 * 60 * 1000;

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
  const status = participationStatus(p, requireApproval);
  return {
    id: p.id,
    projectId: p.projectId,
    userId: p.userId,
    participating: p.active,
    budgetPercent: p.percent,
    mode: p.mode === 'AUTO' ? 'auto' : 'approval',
    status,
    approvedAt: p.approvedAt ? p.approvedAt.toISOString() : null,
    rejectionReason: p.rejectionReason,
    // While rejected the rejection is current, not "previous".
    previouslyRejectedAt:
      status !== 'rejected' && p.lastRejectedAt ? p.lastRejectedAt.toISOString() : null,
  };
}

/**
 * Is the user still the owner of the project? The owner is whoever added it, as long as GitHub
 * still gives them the ADMIN role on the repo (cached role, re-synced every few minutes). Without a
 * GitHub client the role cannot be re-checked and the stored owner is kept.
 */
export async function isCurrentOwner(
  prisma: PrismaClient,
  github: GithubClient | undefined,
  project: Project & { installation: { githubInstallationId: bigint } },
  user: Pick<User, 'id' | 'login'>,
): Promise<boolean> {
  if (project.addedById !== user.id) return false;
  if (!github) return true;
  return (await getRoleInfo(prisma, github, project, user)).role === 'ADMIN';
}

/**
 * The stored owner of a PRIVATE repository who GitHub no longer lets in (role NONE: removed,
 * repository made private to them, installation gone, ...). Such a user must see nothing of the
 * project, whatever stored rows (addedById, participation, permission overrides) still say.
 * Public repositories and a missing GitHub client are unaffected.
 */
export async function ownerLostAccess(
  prisma: PrismaClient,
  github: GithubClient | undefined,
  project: Project & { installation: { githubInstallationId: bigint } },
  user: Pick<User, 'id' | 'login'>,
): Promise<boolean> {
  if (!github || !project.isPrivate || project.addedById !== user.id) return false;
  return (await getRoleInfo(prisma, github, project, user)).role === 'NONE';
}

/**
 * Owner test for aggregates (usage, pool): `addedById`, and for a private repository GitHub's
 * ADMIN role too. Public repositories keep trusting the stored owner.
 */
export async function stillOwns(
  prisma: PrismaClient,
  github: GithubClient | undefined,
  project: Project & { installation: { githubInstallationId: bigint } },
  user: Pick<User, 'id' | 'login'>,
): Promise<boolean> {
  if (project.addedById !== user.id) return false;
  if (!project.isPrivate) return true;
  return isCurrentOwner(prisma, github, project, user);
}

export interface RoleInfo {
  role: GithubRole;
  canSubmit: boolean | null;
  canParticipate: boolean | null;
}

/** Counters/log for the repository access check (wired in app.ts). */
export interface RepoAccessObserver {
  /** result: refreshed | denied | grace | outage_denied | invalidated */
  count(result: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
}

interface RepoAccessSettings {
  ttlMs: number;
  graceMs: number;
  observer?: RepoAccessObserver;
}
let settings: RepoAccessSettings = { ttlMs: ROLE_CACHE_TTL_MS, graceMs: DEFAULT_GRACE_MS };

/** Sets the cache TTL, the outage grace window and the observer of the access check. */
export function configureRepoAccess(next: Partial<RepoAccessSettings>): void {
  settings = { ...settings, ...next };
}

const statusOf = (err: unknown): number | undefined => {
  const s = (err as { status?: unknown } | null)?.status;
  return typeof s === 'number' ? s : undefined;
};

/**
 * "Can user U still access repo R on GitHub?" The one access check behind every role lookup.
 *
 * The GitHub role is cached per (project, user) in ProjectPermission for `ttlMs`. For a PRIVATE
 * repository:
 *   - GitHub answers 401/403/404: denied (role NONE) and that answer is cached (fail closed);
 *   - GitHub is down (5xx, timeout, network): the last verified role is reused while it is younger
 *     than `graceMs`, otherwise denied;
 *   - webhooks mark rows stale (`invalidateRepoAccess`), which also ends the grace for them.
 * Public repositories keep the legacy behaviour (an unreachable GitHub keeps the cached role).
 */
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
  const age = cached ? Date.now() - cached.syncedAt.getTime() : Infinity;
  if (cached && age < settings.ttlMs) return info(cached.githubRole);
  if (!github) return info(cached?.githubRole ?? 'NONE');
  const store = async (role: GithubRole) => {
    await prisma.projectPermission.upsert({
      where: { projectId_userId: { projectId: project.id, userId: user.id } },
      create: { projectId: project.id, userId: user.id, githubRole: role, syncedAt: new Date() },
      update: { githubRole: role, syncedAt: new Date() },
    });
  };
  let role: GithubRole;
  try {
    role = await github.getUserRole(
      Number(project.installation.githubInstallationId),
      project.fullName,
      user.login,
    );
  } catch (err) {
    if (!project.isPrivate) return info(cached?.githubRole ?? 'NONE');
    const status = statusOf(err);
    if (status === 401 || status === 403 || status === 404) {
      settings.observer?.count('denied');
      await store('NONE');
      return info('NONE');
    }
    if (cached && age < settings.graceMs) {
      settings.observer?.count('grace');
      settings.observer?.warn(
        { projectId: project.id, userId: user.id, status, ageSec: Math.round(age / 1000) },
        'GitHub unreachable: reusing the last verified repository role',
      );
      return info(cached.githubRole);
    }
    settings.observer?.count('outage_denied');
    settings.observer?.warn(
      { projectId: project.id, userId: user.id, status },
      'GitHub unreachable and no recent verified role: repository access denied',
    );
    return info('NONE');
  }
  settings.observer?.count('refreshed');
  await store(role);
  return info(role);
}

/**
 * Marks cached roles stale (webhooks: collaborator removed, visibility change, installation
 * removed, org member removed). The overrides in the row are kept; the next check asks GitHub and
 * a stale row gives no outage grace. Returns the number of rows touched.
 */
export async function invalidateRepoAccess(
  prisma: PrismaClient,
  where: { projectId?: string; userId?: string; installationId?: string; accountLogin?: string },
): Promise<number> {
  const project: Prisma.ProjectWhereInput = {};
  if (where.installationId) project.installationId = where.installationId;
  if (where.accountLogin) {
    project.installation = {
      accountLogin: { equals: where.accountLogin, mode: 'insensitive' },
    };
  }
  const { count } = await prisma.projectPermission.updateMany({
    where: {
      ...(where.projectId ? { projectId: where.projectId } : {}),
      ...(where.userId ? { userId: where.userId } : {}),
      ...(Object.keys(project).length ? { project } : {}),
    },
    data: { syncedAt: new Date(0) },
  });
  if (count > 0) settings.observer?.count('invalidated');
  return count;
}
