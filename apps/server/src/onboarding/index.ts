/**
 * `GET /api/onboarding`: the "Getting started" checklist, computed from existing data.
 * Contract in shared api/onboarding.
 */
import type { FastifyInstance } from 'fastify';
import type { OnboardingResponse, OnboardingStep, OnboardingStepId } from '@orch/shared';
import type { AgentGateway } from '../agents/gateway';
import { getUserAccessToken, requireUser, type AuthDeps } from '../auth';
import type { PrismaClient } from '../db';

/** An agent seen within this window counts as connected. */
export const AGENT_SEEN_WINDOW_MS = 15 * 60_000;

const step = (id: OnboardingStepId, state: OnboardingStep['state']): OnboardingStep => ({
  id,
  done: state === 'done',
  state,
});
const flag = (id: OnboardingStepId, ok: boolean) => step(id, ok ? 'done' : 'todo');

/**
 * TODO(mcp-oauth): once the MCP OAuth grant table exists, count a non-revoked grant of the user
 * here. Until then PATs are the only signal.
 */
async function hasOauthGrant(prisma: PrismaClient, userId: string): Promise<boolean> {
  void prisma;
  void userId;
  return false;
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
      select: { id: true, lastSeenAt: true },
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

  const agentOk = agents.some(
    (a) =>
      gateway.isConnected(a.id) ||
      (a.lastSeenAt !== null && now.getTime() - a.lastSeenAt.getTime() <= AGENT_SEEN_WINDOW_MS),
  );
  const mcpOk = usedPat > 0 || (await hasOauthGrant(prisma, userId));

  return {
    steps: [
      flag('github_app_installed', githubOk),
      flag('project_added', ownedCount > 0 || activeParticipation > 0),
      flag('participation_set', activeParticipation > 0 || ownedCount > 0),
      flag('agent_connected', agentOk),
      // The agent does not report the Claude token yet (field `claudeTokenPresent`).
      step('claude_connected', 'unknown'),
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
}
