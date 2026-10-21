import type { FastifyInstance } from 'fastify';
import {
  AddProjectRequestSchema,
  UpdateProjectRequestSchema,
  type AvailableRepo,
  type DiscoverItem,
} from '@orch/shared';
import { audit } from '../audit';
import { getUserAccessToken, requireUser, type AuthDeps } from '../auth';
import { HttpError, parseBody } from '../http/errors';
import { canSee, toOrchRole } from './roles';
import { getRoleInfo, toParticipationView, toProjectView } from './service';

export function registerProjects(app: FastifyInstance, deps: AuthDeps): void {
  const { prisma, config } = deps;

  const needGithub = () => {
    if (!deps.github) {
      throw new HttpError(503, 'github_not_configured', 'GitHub App is not configured');
    }
    return deps.github;
  };
  const installUrl = () =>
    `https://github.com/apps/${config.GITHUB_APP_SLUG ?? ''}/installations/new`;

  app.get('/api/github/install-url', async (req) => {
    requireUser(req);
    if (!config.GITHUB_APP_SLUG) {
      throw new HttpError(503, 'github_not_configured', 'GitHub App is not configured');
    }
    return { url: installUrl() };
  });

  app.get('/api/repos/available', async (req) => {
    const user = requireUser(req);
    const github = needGithub();
    const repos = await github.listUserRepos(await getUserAccessToken(deps, user));
    const admin = repos.filter((r) => r.admin);
    const added = await prisma.project.findMany({
      where: { githubRepoId: { in: admin.map((r) => BigInt(r.githubRepoId)) } },
      select: { githubRepoId: true },
    });
    const addedIds = new Set(added.map((p) => Number(p.githubRepoId)));
    return admin.map((r): AvailableRepo => ({
      githubRepoId: r.githubRepoId,
      fullName: r.fullName,
      private: r.private,
      installationId: r.installationId,
      alreadyAdded: addedIds.has(r.githubRepoId),
    }));
  });

  app.post('/api/projects', async (req, reply) => {
    const user = requireUser(req);
    const github = needGithub();
    const { githubRepoId } = parseBody(AddProjectRequestSchema, req.body);
    const repos = await github.listUserRepos(await getUserAccessToken(deps, user));
    const repo = repos.find((r) => r.githubRepoId === githubRepoId);
    if (!repo) {
      throw new HttpError(
        409,
        'app_not_installed',
        'The orch GitHub App is not installed on this repository. Install it first.',
      );
    }
    if (!repo.admin) throw new HttpError(403, 'not_admin', 'Only repository admins can add it');
    const existing = await prisma.project.findUnique({
      where: { githubRepoId: BigInt(githubRepoId) },
    });
    if (existing) throw new HttpError(409, 'already_added', 'This repository is already added');

    const installation = await prisma.installation.upsert({
      where: { githubInstallationId: BigInt(repo.installationId) },
      create: {
        githubInstallationId: BigInt(repo.installationId),
        accountLogin: repo.accountLogin,
        accountType: repo.accountType,
      },
      update: { accountLogin: repo.accountLogin, accountType: repo.accountType },
    });
    const project = await prisma.project.create({
      data: {
        githubRepoId: BigInt(repo.githubRepoId),
        fullName: repo.fullName,
        installationId: installation.id,
        defaultBranch: repo.defaultBranch,
        isPrivate: repo.private,
        addedById: user.id,
      },
    });
    await prisma.projectPermission.create({
      data: { projectId: project.id, userId: user.id, githubRole: 'ADMIN', syncedAt: new Date() },
    });
    await audit(prisma, {
      actorUserId: user.id,
      action: 'project.added',
      projectId: project.id,
      data: { fullName: project.fullName },
      ip: req.ip,
    });
    return reply.status(201).send(toProjectView(project));
  });

  app.get('/api/projects/mine', async (req) => {
    const user = requireUser(req);
    const projects = await prisma.project.findMany({
      where: { addedById: user.id, archivedAt: null },
      orderBy: { createdAt: 'asc' },
    });
    return projects.map(toProjectView);
  });

  async function ownedProject(id: string, userId: string) {
    const project = await prisma.project.findUnique({ where: { id } });
    if (!project) throw new HttpError(404, 'not_found', 'Project not found');
    if (project.addedById !== userId) {
      throw new HttpError(403, 'forbidden', 'Only the project owner can do this');
    }
    return project;
  }

  app.patch('/api/projects/:id', async (req) => {
    const user = requireUser(req);
    const { id } = req.params as { id: string };
    const project = await ownedProject(id, user.id);
    const body = parseBody(UpdateProjectRequestSchema, req.body);
    const updated = await prisma.project.update({
      where: { id: project.id },
      data: {
        visibility: body.visibility,
        requireParticipantApproval: body.requireParticipantApproval,
        participationPolicy: body.whoCanParticipate,
        submissionPolicy: body.whoCanSubmit,
      },
    });
    await audit(prisma, {
      actorUserId: user.id,
      action: 'project.updated',
      projectId: project.id,
      data: body,
      ip: req.ip,
    });
    return toProjectView(updated);
  });

  app.delete('/api/projects/:id', async (req, reply) => {
    const user = requireUser(req);
    const { id } = req.params as { id: string };
    const project = await ownedProject(id, user.id);
    await prisma.project.delete({ where: { id: project.id } });
    await audit(prisma, {
      actorUserId: user.id,
      action: 'project.deleted',
      projectId: project.id,
      data: { fullName: project.fullName },
      ip: req.ip,
    });
    return reply.status(204).send();
  });

  app.get('/api/projects/discover', async (req) => {
    const user = requireUser(req);
    const projects = await prisma.project.findMany({
      where: { addedById: { not: user.id }, archivedAt: null },
      include: { installation: true, addedBy: true },
      orderBy: { createdAt: 'asc' },
    });
    const mine = await prisma.participation.findMany({ where: { userId: user.id } });
    const myByProject = new Map(mine.map((p) => [p.projectId, p]));
    const items = await Promise.all(
      projects.map(async (p): Promise<DiscoverItem | null> => {
        const info = await getRoleInfo(prisma, deps.github, p, user);
        if (!canSee(p.visibility, info.role, info)) return null;
        const part = myByProject.get(p.id);
        return {
          project: toProjectView(p),
          owner: { githubLogin: p.addedBy.login, avatarUrl: p.addedBy.avatarUrl },
          myRole: toOrchRole(info.role),
          myParticipation: part ? toParticipationView(part, p.requireParticipantApproval) : null,
        };
      }),
    );
    return items.filter((i): i is DiscoverItem => i !== null);
  });
}
