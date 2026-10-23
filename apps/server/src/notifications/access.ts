import type { User } from '@prisma/client';
import type { PrismaClient } from '../db';
import type { GithubClient } from '../github';
import { getRoleInfo } from '../projects/service';

/** Whether a user may still receive a notification (about `projectId`, when set). */
export type RecipientCheck = (userId: string, projectId: string | null) => Promise<boolean>;

export interface RecipientCheckDeps {
  prisma: PrismaClient;
  github?: GithubClient;
  /** Sign-in allowlist decision (the same one the web session and the agent gateway apply). */
  isAllowed: (user: User) => Promise<boolean>;
}

/**
 * Notifications carry task titles, repository names and error messages, and external channels
 * (Slack, e-mail, ...) are read outside orch. A recipient computed from stored ids (task creator,
 * project owner, runner) may have lost access since: removed from the sign-in allowlist, or from
 * a private repository. Such users are not notified.
 *
 * For a private repository, access is a GitHub role on it (cached, like everywhere else), an
 * explicit owner override, or an active participation (the member's agent runs the project's
 * code anyway).
 */
export function recipientCheck(deps: RecipientCheckDeps): RecipientCheck {
  const { prisma, github } = deps;
  return async (userId, projectId) => {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user || !(await deps.isAllowed(user))) return false;
    if (!projectId) return true;
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      include: { installation: true },
    });
    if (!project) return false;
    if (!project.isPrivate) return true;
    const info = await getRoleInfo(prisma, github, project, user);
    if (info.role !== 'NONE' || info.canSubmit === true || info.canParticipate === true) {
      return true;
    }
    const part = await prisma.participation.findUnique({
      where: { userId_projectId: { userId, projectId } },
      select: { active: true },
    });
    return part?.active === true;
  };
}
