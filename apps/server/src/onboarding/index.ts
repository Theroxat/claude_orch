/**
 * `GET /api/onboarding`: the "Getting started" checklist, computed from existing data.
 * Contract in shared api/onboarding.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { OnboardingResponse, OnboardingStep, OnboardingStepId } from '@orch/shared';
import type { AgentGateway } from '../agents/gateway';
import { getUserAccessToken, requireUser, toApiUser, type AuthDeps } from '../auth';
import type { PrismaClient } from '../db';

/** An agent seen within this window counts as connected. */
export const AGENT_SEEN_WINDOW_MS = 15 * 60_000;

const step = (id: OnboardingStepId, state: OnboardingStep['state']): OnboardingStep => ({
  id,
  done: state === 'done',
  state,
});
const flag = (id: OnboardingStepId, ok: boolean) => step(id, ok ? 'done' : 'todo');

/** A non-revoked MCP OAuth grant with a live refresh token means Claude Code is connected. */
async function hasOauthGrant(prisma: PrismaClient, userId: string): Promise<boolean> {
  const n = await prisma.oAuthGrant.count({
    where: {
      userId,
      revokedAt: null,
      tokens: { some: { kind: 'REFRESH', usedAt: null, expiresAt: { gt: new Date() } } },
    },
  });
  return n > 0;
}

export async function computeOnboarding(
  deps: AuthDeps & { gateway: Pick<AgentGateway, 'isConnected'> },
  userId: string,
  now = new Date(),
): Promise<OnboardingResponse> {
  const { prisma, gateway } = deps;
  const [ownedCount, activeParticipation, knownRepo, agents, usedPat] = await Promise.all([
    prisma.project.count({ where: { addedById: userId, archivedAt: null } }),
    prisma.participation.count({
      where: { userId, active: true, project: { archivedAt: null } },
    }),
    prisma.projectPermission.count({ where: { userId } }),
    prisma.agent.findMany({
      where: { userId, revokedAt: null },
      select: { id: true, lastSeenAt: true, claudeTokenPresent: true, claudeAuthValid: true },
    }),
    prisma.personalToken.count({
      where: { userId, revokedAt: null, lastUsedAt: { not: null } },
    }),
  ]);

  let githubOk = ownedCount > 0 || knownRepo > 0;
  if (!githubOk && deps.github) {
    try {
      const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
      const repos = await deps.github.listUserRepos(await getUserAccessToken(deps, user));
      githubOk = repos.length > 0;
    } catch {
      githubOk = false;
    }
  }

  // Done when any live agent reports a Claude token; todo when an agent is connected and reports
  // none; unknown without data.
  const live = agents.filter(
    (a) =>
      gateway.isConnected(a.id) ||
      (a.lastSeenAt !== null && now.getTime() - a.lastSeenAt.getTime() <= AGENT_SEEN_WINDOW_MS),
  );
  const agentOk = live.length > 0;
  const loginOk = (a: (typeof live)[number]) => a.claudeTokenPresent === true && a.claudeAuthValid;
  // An expired login (a run failed with 401) is todo again, with the reason.
  const loginExpired = !live.some(loginOk) && live.some((a) => !a.claudeAuthValid);
  const claudeState: OnboardingStep['state'] = live.some(loginOk)
    ? 'done'
    : loginExpired || live.some((a) => a.claudeTokenPresent === false)
      ? 'todo'
      : 'unknown';
  const mcpOk = usedPat > 0 || (await hasOauthGrant(prisma, userId));

  return {
    steps: [
      flag('github_app_installed', githubOk),
      flag('project_added', ownedCount > 0 || activeParticipation > 0),
      flag('participation_set', activeParticipation > 0 || ownedCount > 0),
      flag('agent_connected', agentOk),
      {
        ...step('claude_connected', claudeState),
        ...(loginExpired && { reason: 'claude_login_expired' }),
      },
      flag('mcp_connected', mcpOk),
    ],
  };
}

export function registerOnboarding(
  app: FastifyInstance,
  deps: AuthDeps & { gateway: AgentGateway },
): void {
  app.get('/api/onboarding', async (req): Promise<OnboardingResponse> => {
    const user = requireUser(req);
    return computeOnboarding(deps, user.id);
  });

  // Wizard state lives on the user so the first-visit redirect does not depend on the browser.
  // Idempotent: the first timestamp is kept.
  const mark =
    (field: 'onboardingCompletedAt' | 'onboardingDismissedAt') => async (req: FastifyRequest) => {
      const user = requireUser(req);
      if (user[field]) return toApiUser(user, app.allowlist.isAdmin(user.login));
      const updated = await deps.prisma.user.update({
        where: { id: user.id },
        data: { [field]: new Date() },
      });
      return toApiUser(updated, app.allowlist.isAdmin(updated.login));
    };
  app.post('/api/onboarding/complete', mark('onboardingCompletedAt'));
  app.post('/api/onboarding/dismiss', mark('onboardingDismissedAt'));
}
