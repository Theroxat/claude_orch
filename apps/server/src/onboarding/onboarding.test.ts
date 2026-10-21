import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { OnboardingResponseSchema, type OnboardingStepId } from '@orch/shared';
import { FakeGithub, api, loginAs, makeApp, prisma, repoFor, uid } from '../../test/harness';

let gh: FakeGithub;
let app: FastifyInstance;

beforeAll(() => {
  gh = new FakeGithub();
  app = makeApp(gh);
});
afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

async function steps(user: Awaited<ReturnType<typeof loginAs>>) {
  const res = await api(app, user)('GET', '/api/onboarding');
  expect(res.statusCode).toBe(200);
  const parsed = OnboardingResponseSchema.parse(res.json());
  return Object.fromEntries(parsed.steps.map((s) => [s.id, s])) as Record<
    OnboardingStepId,
    (typeof parsed.steps)[number]
  >;
}

describe('GET /api/onboarding', () => {
  it('requires a session', async () => {
    expect((await api(app, null)('GET', '/api/onboarding')).statusCode).toBe(401);
  });

  it('starts with nothing done and Claude unknown', async () => {
    const u = await loginAs(app, gh);
    const s = await steps(u);
    expect(Object.values(s).map((x) => x.id)).toEqual([
      'github_app_installed',
      'project_added',
      'participation_set',
      'agent_connected',
      'claude_connected',
      'mcp_connected',
    ]);
    expect(Object.values(s).every((x) => !x.done)).toBe(true);
    expect(s.claude_connected.state).toBe('unknown');
    expect(s.github_app_installed.state).toBe('todo');
  });

  it('sees available repos, then an added project (owner), without double counting', async () => {
    const u = await loginAs(app, gh);
    const repo = repoFor();
    gh.repos.set(u.token, [repo]);
    let s = await steps(u);
    expect(s.github_app_installed.done).toBe(true);
    expect(s.project_added.done).toBe(false);

    const add = await api(app, u)('POST', '/api/projects', { githubRepoId: repo.githubRepoId });
    expect(add.statusCode).toBe(201);
    s = await steps(u);
    expect(s.project_added.done).toBe(true);
    expect(s.participation_set.done).toBe(true);
  });

  it('counts an active participation for a non-owner', async () => {
    const owner = await loginAs(app, gh);
    const member = await loginAs(app, gh);
    const repo = repoFor();
    gh.repos.set(owner.token, [repo]);
    const added = (
      await api(app, owner)('POST', '/api/projects', { githubRepoId: repo.githubRepoId })
    ).json() as { id: string };
    expect((await steps(member)).project_added.done).toBe(false);
    await prisma.participation.create({
      data: {
        userId: member.userId,
        projectId: added.id,
        active: false,
        percent: 10,
        mode: 'AUTO',
      },
    });
    expect((await steps(member)).participation_set.done).toBe(false);
    await prisma.participation.updateMany({
      where: { userId: member.userId },
      data: { active: true },
    });
    const s = await steps(member);
    expect(s.project_added.done).toBe(true);
    expect(s.participation_set.done).toBe(true);
  });

  it('claude_connected follows the Claude login state reported by live agents', async () => {
    const u = await loginAs(app, gh);
    const mk = (claudeTokenPresent: boolean | null, lastSeenAt: Date | null = new Date()) =>
      prisma.agent.create({
        data: {
          id: `agt_${uid()}`,
          userId: u.userId,
          name: 'laptop',
          secretHash: uid(),
          secretPrefix: 'abcdef',
          lastSeenAt,
          claudeTokenPresent,
        },
      });
    expect((await steps(u)).claude_connected.state).toBe('unknown');
    await mk(true, new Date(Date.now() - 60 * 60_000)); // stale: ignored
    expect((await steps(u)).claude_connected.state).toBe('unknown');
    await mk(null);
    expect((await steps(u)).claude_connected.state).toBe('unknown');
    await mk(false);
    let s = await steps(u);
    expect(s.claude_connected).toMatchObject({ state: 'todo', done: false });
    await mk(true);
    s = await steps(u);
    expect(s.claude_connected).toMatchObject({ state: 'done', done: true });
  });

  it('agent_connected needs a recent, non-revoked agent', async () => {
    const u = await loginAs(app, gh);
    const mk = (lastSeenAt: Date | null, revokedAt: Date | null = null) =>
      prisma.agent.create({
        data: {
          id: `agt_${uid()}`,
          userId: u.userId,
          name: 'laptop',
          secretHash: uid(),
          secretPrefix: 'abcdef',
          lastSeenAt,
          revokedAt,
        },
      });
    await mk(null);
    await mk(new Date(Date.now() - 60 * 60_000));
    await mk(new Date(), new Date());
    expect((await steps(u)).agent_connected.done).toBe(false);
    await mk(new Date(Date.now() - 5 * 60_000));
    expect((await steps(u)).agent_connected.done).toBe(true);
  });

  it('mcp_connected needs a PAT used at least once', async () => {
    const u = await loginAs(app, gh);
    const mk = (lastUsedAt: Date | null, revokedAt: Date | null = null) =>
      prisma.personalToken.create({
        data: {
          userId: u.userId,
          name: 't',
          tokenHash: uid() + uid(),
          prefix: 'orch_pat_ab',
          lastUsedAt,
          revokedAt,
        },
      });
    await mk(null);
    await mk(new Date(), new Date());
    expect((await steps(u)).mcp_connected.done).toBe(false);
    await mk(new Date());
    expect((await steps(u)).mcp_connected.done).toBe(true);
  });

  it('mcp_connected counts a live, non-revoked OAuth grant', async () => {
    const u = await loginAs(app, gh);
    const client = await prisma.oAuthClient.create({
      data: {
        clientIdHash: uid() + uid(),
        name: 'Claude Code',
        redirectUris: ['http://localhost:1/cb'],
      },
    });
    const grant = await prisma.oAuthGrant.create({
      data: { userId: u.userId, clientId: client.id, resource: 'http://x/mcp', scope: 'mcp' },
    });
    const refresh = (expiresAt: Date) =>
      prisma.oAuthToken.create({
        data: { tokenHash: uid() + uid(), grantId: grant.id, kind: 'REFRESH', expiresAt },
      });
    await refresh(new Date(Date.now() - 1000));
    expect((await steps(u)).mcp_connected.done).toBe(false);
    await refresh(new Date(Date.now() + 3600_000));
    expect((await steps(u)).mcp_connected.done).toBe(true);
    await prisma.oAuthGrant.update({ where: { id: grant.id }, data: { revokedAt: new Date() } });
    expect((await steps(u)).mcp_connected.done).toBe(false);
  });
});
