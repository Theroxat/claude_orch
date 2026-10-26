import type { Participation, Prisma, Project, ProjectPermission, User } from '@prisma/client';
import type { GithubRole, ParticipationView, ProjectView, ParticipationStatus } from '@orch/shared';
import type { PrismaClient } from '../db';
import type { GithubClient } from '../github';
import { canParticipate } from './roles';

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

type ProjectRef = Project & { installation: { githubInstallationId: bigint } };
type UserRef = Pick<User, 'id' | 'login'>;

/**
 * Is the user still the owner of the project? The owner is whoever added it, as long as GitHub
 * still gives them the ADMIN role on the repo (cached role, re-synced every few minutes). Without a
 * GitHub client the role cannot be re-checked and the stored owner is kept.
 */
export async function isCurrentOwner(
  prisma: PrismaClient,
  github: GithubClient | undefined,
  project: ProjectRef,
  user: UserRef,
  memo?: RoleMemo,
): Promise<boolean> {
  if (project.addedById !== user.id) return false;
  if (!github) return true;
  return (await getRoleInfo(prisma, github, project, user, memo)).role === 'ADMIN';
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
  project: ProjectRef,
  user: UserRef,
  memo?: RoleMemo,
): Promise<boolean> {
  if (!github || !project.isPrivate || project.addedById !== user.id) return false;
  return (await getRoleInfo(prisma, github, project, user, memo)).role === 'NONE';
}

/**
 * Owner test for aggregates (usage, pool): `addedById`, and for a private repository GitHub's
 * ADMIN role too. Public repositories keep trusting the stored owner.
 */
export async function stillOwns(
  prisma: PrismaClient,
  github: GithubClient | undefined,
  project: ProjectRef,
  user: UserRef,
  memo?: RoleMemo,
): Promise<boolean> {
  if (project.addedById !== user.id) return false;
  if (!project.isPrivate) return true;
  return isCurrentOwner(prisma, github, project, user, memo);
}

/**
 * May this member still work on (and see) a PRIVATE repository through a stored participation?
 * Used by the board, the pool, the dispatcher (candidates and accept), agent claims and token
 * minting. The stored owner needs a GitHub role (see `ownerLostAccess`); any other member needs
 * a GitHub role too, unless the project lets every member participate (`ALL_MEMBERS`) or the
 * owner explicitly allowed them (override). Public repositories and a missing GitHub client:
 * always true (the participation rules alone decide).
 */
export async function repoAccessAllows(
  prisma: PrismaClient,
  github: GithubClient | undefined,
  project: ProjectRef,
  user: UserRef,
  memo?: RoleMemo,
): Promise<boolean> {
  if (!github || !project.isPrivate) return true;
  const info = await getRoleInfo(prisma, github, project, user, memo);
  if (info.role !== 'NONE') return true;
  if (project.addedById === user.id) return false;
  return canParticipate(project.participationPolicy, 'NONE', info);
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

interface RepoAccessState extends RepoAccessSettings {
  /** Refreshes in flight, per (project, user): concurrent checks share one GitHub call. */
  inflight: Map<string, Promise<GithubRole>>;
}

const newState = (): RepoAccessState => ({
  ttlMs: ROLE_CACHE_TTL_MS,
  graceMs: DEFAULT_GRACE_MS,
  inflight: new Map(),
});
/** One state per app, keyed by its GitHub client (no client: no refresh, only the TTL matters). */
const states = new WeakMap<GithubClient, RepoAccessState>();
const noClientState = newState();

function stateFor(github: GithubClient | undefined): RepoAccessState {
  if (!github) return noClientState;
  let s = states.get(github);
  if (!s) {
    s = newState();
    states.set(github, s);
  }
  return s;
}

/** Sets the cache TTL, the outage grace window and the observer of the app using `github`. */
export function configureRepoAccess(
  github: GithubClient | undefined,
  next: Partial<RepoAccessSettings>,
): void {
  Object.assign(stateFor(github), next);
}

/**
 * Per-request (or per dispatcher tick) memo of role lookups: each (project, user) pair is read at
 * most once, and `prime` loads the cached rows of many pairs in one query (list endpoints, the
 * dispatcher snapshot) instead of one query per project.
 */
export class RoleMemo {
  private readonly infos = new Map<string, Promise<RoleInfo>>();
  private readonly rows = new Map<string, ProjectPermission>();
  private readonly primed: Array<{ projects: Set<string>; users: Set<string> }> = [];

  async prime(prisma: PrismaClient, projectIds: string[], userIds: string[]): Promise<void> {
    if (projectIds.length === 0 || userIds.length === 0) return;
    const rows = await prisma.projectPermission.findMany({
      where: { projectId: { in: projectIds }, userId: { in: userIds } },
    });
    for (const r of rows) this.rows.set(pairKey(r.projectId, r.userId), r);
    this.primed.push({ projects: new Set(projectIds), users: new Set(userIds) });
  }

  /** The primed row (null: primed and absent), or undefined when the pair was not primed. */
  row(projectId: string, userId: string): ProjectPermission | null | undefined {
    const r = this.rows.get(pairKey(projectId, userId));
    if (r) return r;
    return this.primed.some((b) => b.projects.has(projectId) && b.users.has(userId))
      ? null
      : undefined;
  }

  info(key: string, load: () => Promise<RoleInfo>): Promise<RoleInfo> {
    let p = this.infos.get(key);
    if (!p) {
      p = load();
      this.infos.set(key, p);
      // A failure (database) is not memoized: the next lookup tries again.
      p.catch(() => this.infos.delete(key));
    }
    return p;
  }
}

const pairKey = (projectId: string, userId: string) => `${projectId}:${userId}`;

const statusOf = (err: unknown): number | undefined => {
  const s = (err as { status?: unknown } | null)?.status;
  return typeof s === 'number' ? s : undefined;
};

/**
 * A 403 that is GitHub throttling us (primary or secondary rate limit), not a refusal: it must be
 * treated as an outage, never cached as "no access".
 */
function isRateLimited(err: unknown): boolean {
  const e = err as {
    message?: unknown;
    response?: { headers?: Record<string, string | number | undefined> };
  } | null;
  const h = e?.response?.headers ?? {};
  return (
    String(h['x-ratelimit-remaining'] ?? '') === '0' ||
    h['retry-after'] !== undefined ||
    /rate limit/i.test(typeof e?.message === 'string' ? e.message : '')
  );
}

/**
 * "Can user U still access repo R on GitHub?" The one access check behind every role lookup.
 *
 * The GitHub role is cached per (project, user) in ProjectPermission for `ttlMs`. For a PRIVATE
 * repository:
 *   - GitHub answers 403/404: denied (role NONE) and that answer is cached (fail closed). A
 *     403 that is a rate limit is an outage, not a denial;
 *   - GitHub is down or the app's own credentials fail (5xx, 429, 401, timeout, network): the last verified role is reused while it is
 *     younger than `graceMs`, otherwise denied (nothing is cached: the next check asks again);
 *   - webhooks mark rows stale (`invalidateRepoAccess`), which also ends the grace for them, and
 *     a refresh started before an invalidation never overwrites it (compare-and-set on syncedAt).
 * Public repositories keep the legacy behaviour (an unreachable GitHub keeps the cached role).
 */
export async function getRoleInfo(
  prisma: PrismaClient,
  github: GithubClient | undefined,
  project: ProjectRef,
  user: UserRef,
  memo?: RoleMemo,
): Promise<RoleInfo> {
  const key = pairKey(project.id, user.id);
  if (memo) return memo.info(key, () => lookupRole(prisma, github, project, user, memo));
  return lookupRole(prisma, github, project, user);
}

async function lookupRole(
  prisma: PrismaClient,
  github: GithubClient | undefined,
  project: ProjectRef,
  user: UserRef,
  memo?: RoleMemo,
): Promise<RoleInfo> {
  const state = stateFor(github);
  const primed = memo?.row(project.id, user.id);
  const cached =
    primed !== undefined
      ? primed
      : await prisma.projectPermission.findUnique({
          where: { projectId_userId: { projectId: project.id, userId: user.id } },
        });
  const info = (role: GithubRole): RoleInfo => ({
    role,
    canSubmit: cached?.canSubmit ?? null,
    canParticipate: cached?.canParticipate ?? null,
  });
  const age = cached ? Date.now() - cached.syncedAt.getTime() : Infinity;
  if (cached && age < state.ttlMs) return info(cached.githubRole);
  if (!github) return info(cached?.githubRole ?? 'NONE');
  const key = pairKey(project.id, user.id);
  let refresh = state.inflight.get(key);
  if (!refresh) {
    refresh = refreshRole(prisma, github, state, project, user, cached, age);
    state.inflight.set(key, refresh);
    const done = () => {
      if (state.inflight.get(key) === refresh) state.inflight.delete(key);
    };
    refresh.then(done, done);
  }
  return info(await refresh);
}

async function refreshRole(
  prisma: PrismaClient,
  github: GithubClient,
  state: RepoAccessState,
  project: ProjectRef,
  user: UserRef,
  cached: ProjectPermission | null,
  age: number,
): Promise<GithubRole> {
  // Compare-and-set: only the row as it was read is replaced. A webhook invalidation (or another
  // refresh) that landed while GitHub was being asked wins; this answer is then not cached.
  const store = async (role: GithubRole) => {
    const syncedAt = new Date();
    if (cached) {
      await prisma.projectPermission.updateMany({
        where: { projectId: project.id, userId: user.id, syncedAt: cached.syncedAt },
        data: { githubRole: role, syncedAt },
      });
    } else {
      await prisma.projectPermission.createMany({
        data: [{ projectId: project.id, userId: user.id, githubRole: role, syncedAt }],
        skipDuplicates: true,
      });
    }
  };
  let role: GithubRole;
  try {
    role = await github.getUserRole(
      Number(project.installation.githubInstallationId),
      project.fullName,
      user.login,
    );
  } catch (err) {
    if (!project.isPrivate) return cached?.githubRole ?? 'NONE';
    const status = statusOf(err);
    if (status === 404 || (status === 403 && !isRateLimited(err))) {
      state.observer?.count('denied');
      await store('NONE');
      return 'NONE';
    }
    if (cached && age < state.graceMs) {
      state.observer?.count('grace');
      state.observer?.warn(
        { projectId: project.id, userId: user.id, status, ageSec: Math.round(age / 1000) },
        'GitHub unreachable: reusing the last verified repository role',
      );
      return cached.githubRole;
    }
    state.observer?.count('outage_denied');
    state.observer?.warn(
      { projectId: project.id, userId: user.id, status },
      'GitHub unreachable and no recent verified role: repository access denied',
    );
    return 'NONE';
  }
  state.observer?.count('refreshed');
  await store(role);
  return role;
}

/** How far back an invalidated row's syncedAt is set: older than any TTL or grace window. */
const INVALIDATED_AGE_MS = 100 * 365 * 24 * 3600_000;
let lastInvalidation = 0;
/** A distinct "very old" timestamp per invalidation, so compare-and-set always sees it changed. */
function invalidationStamp(): Date {
  lastInvalidation = Math.max(Date.now() - INVALIDATED_AGE_MS, lastInvalidation + 1);
  return new Date(lastInvalidation);
}

/**
 * Marks cached roles stale (webhooks: collaborator removed, visibility change, installation
 * removed, org or team member removed). The overrides in the row are kept; the next check asks
 * GitHub, a stale row gives no outage grace, and a refresh already in flight cannot overwrite the
 * invalidation. For one (project, user) pair without a row, a stale NONE row is written so that
 * such a refresh cannot cache its answer either. Returns the number of rows touched.
 */
export async function invalidateRepoAccess(
  prisma: PrismaClient,
  where: { projectId?: string; userId?: string; installationId?: string; accountLogin?: string },
  github?: GithubClient,
): Promise<number> {
  const project: Prisma.ProjectWhereInput = {};
  if (where.installationId) project.installationId = where.installationId;
  if (where.accountLogin) {
    project.installation = {
      accountLogin: { equals: where.accountLogin, mode: 'insensitive' },
    };
  }
  const syncedAt = invalidationStamp();
  let { count } = await prisma.projectPermission.updateMany({
    where: {
      ...(where.projectId ? { projectId: where.projectId } : {}),
      ...(where.userId ? { userId: where.userId } : {}),
      ...(Object.keys(project).length ? { project } : {}),
    },
    data: { syncedAt },
  });
  if (count === 0 && where.projectId && where.userId) {
    ({ count } = await prisma.projectPermission.createMany({
      data: [{ projectId: where.projectId, userId: where.userId, githubRole: 'NONE', syncedAt }],
      skipDuplicates: true,
    }));
  }
  if (count > 0) stateFor(github).observer?.count('invalidated');
  return count;
}
