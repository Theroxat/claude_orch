/**
 * Task templates (contract in shared api/templates). Built-ins live in code; personal and
 * project-shared ones in the TaskTemplate table.
 *
 * Rights: personal = its creator only (other users get 404, the template does not exist for
 * them). Project = anyone who can see the project may use it (`visibleProject`, so private
 * repositories and visibility rules apply), only the project owner creates, edits and deletes.
 */
import type { FastifyInstance } from 'fastify';
import type { Prisma, TaskTemplate, User } from '@prisma/client';
import {
  BUILTIN_TEMPLATES,
  CreateTemplateRequestSchema,
  RenderTemplateRequestSchema,
  TEMPLATE_LIMITS,
  TemplateError,
  UpdateTemplateRequestSchema,
  builtinId,
  builtinViews,
  placeholdersOf,
  renderTemplate,
  type RenderedTemplate,
  type TaskTemplateView,
  type TemplateSource,
} from '@orch/shared';
import { audit } from '../audit';
import { requireUser, type AuthDeps } from '../auth';
import type { PrismaClient } from '../db';
import { HttpError, parseBody } from '../http/errors';
import { TaskService } from '../tasks';

type Row = TaskTemplate & { project: { fullName: string } | null; createdBy: { login: string } };
const include = {
  project: { select: { fullName: true } },
  createdBy: { select: { login: true } },
} satisfies Prisma.TaskTemplateInclude;

const toView = (t: Row, canEdit: boolean): TaskTemplateView => ({
  id: t.id,
  scope: t.scope === 'PERSONAL' ? 'personal' : 'project',
  projectId: t.projectId,
  projectFullName: t.project?.fullName ?? null,
  name: t.name,
  description: t.description,
  titleTemplate: t.titleTemplate,
  bodyTemplate: t.bodyTemplate,
  acceptanceCriteria: t.acceptanceCriteria,
  size: t.size,
  model: t.model,
  labels: t.labels,
  dependenciesMode: t.dependenciesMode === 'ASK' ? 'ask' : 'none',
  placeholders: placeholdersOf(t),
  createdBy: t.createdBy.login,
  canEdit,
  createdAt: t.createdAt.toISOString(),
  updatedAt: t.updatedAt.toISOString(),
});

const toSource = (t: TaskTemplateView): TemplateSource => t;

export class TemplateService {
  private readonly tasks: TaskService;
  private readonly prisma: PrismaClient;

  constructor(deps: AuthDeps) {
    this.tasks = new TaskService(deps);
    this.prisma = deps.prisma;
  }

  /** Built-ins, the user's personal templates and, with `projectId`, the project's shared ones. */
  async list(user: User, projectId?: string): Promise<TaskTemplateView[]> {
    const out = builtinViews();
    const personal = await this.prisma.taskTemplate.findMany({
      where: { scope: 'PERSONAL', createdById: user.id },
      include,
      orderBy: { name: 'asc' },
    });
    out.push(...personal.map((t) => toView(t, true)));
    if (projectId) {
      const [, access] = await this.tasks.visibleProject(projectId, user);
      const shared = await this.prisma.taskTemplate.findMany({
        where: { scope: 'PROJECT', projectId },
        include,
        orderBy: { name: 'asc' },
      });
      out.push(...shared.map((t) => toView(t, access.isOwner)));
    }
    return out;
  }

  /** A template the user may use. 404 when it does not exist or is not visible to them. */
  async getForUse(id: string, user: User): Promise<TaskTemplateView> {
    const builtin = builtinViews().find((b) => b.id === id);
    if (builtin) return builtin;
    const row = await this.row(id);
    if (row.scope === 'PERSONAL') {
      if (row.createdById !== user.id) throw notFound();
      return toView(row, true);
    }
    const [, access] = await this.tasks.visibleProject(row.projectId!, user);
    return toView(row, access.isOwner);
  }

  /** Resolves an id or an exact (case-insensitive) name, for the MCP tool. */
  async resolve(ref: string, user: User, projectId?: string): Promise<TaskTemplateView> {
    if (ref.startsWith('builtin:') || /^c[a-z0-9]{20,}$/.test(ref)) {
      return this.getForUse(ref, user);
    }
    const all = await this.list(user, projectId);
    const named = all.filter((t) => t.name.toLowerCase() === ref.toLowerCase());
    // Project templates win over personal, personal over built-in, on a name clash.
    const rank = { project: 0, personal: 1, builtin: 2 } as const;
    named.sort((a, b) => rank[a.scope] - rank[b.scope]);
    const hit = named[0];
    if (!hit) throw new HttpError(404, 'template_not_found', `Template "${ref}" not found`);
    return hit;
  }

  render(t: TaskTemplateView, variables: Record<string, string>): RenderedTemplate {
    try {
      return renderTemplate(toSource(t), variables);
    } catch (err) {
      if (err instanceof TemplateError) throw new HttpError(400, err.code, err.message);
      throw err;
    }
  }

  async create(
    user: User,
    input: ReturnType<typeof CreateTemplateRequestSchema.parse>,
    ip?: string,
  ): Promise<TaskTemplateView> {
    let projectId: string | null = null;
    if (input.scope === 'project') {
      const [project, access] = await this.tasks.visibleProject(input.projectId!, user);
      if (!access.isOwner) {
        throw new HttpError(403, 'forbidden', 'Only the project owner manages shared templates');
      }
      projectId = project.id;
    }
    const where: Prisma.TaskTemplateWhereInput =
      input.scope === 'project'
        ? { scope: 'PROJECT', projectId }
        : { scope: 'PERSONAL', createdById: user.id };
    if ((await this.prisma.taskTemplate.count({ where })) >= TEMPLATE_LIMITS.perScope) {
      throw new HttpError(
        409,
        'template_limit',
        `At most ${TEMPLATE_LIMITS.perScope} templates per ${input.scope === 'project' ? 'project' : 'user'}`,
      );
    }
    const row = await this.prisma.taskTemplate.create({
      data: {
        scope: input.scope === 'project' ? 'PROJECT' : 'PERSONAL',
        projectId,
        createdById: user.id,
        name: input.name,
        description: input.description,
        titleTemplate: input.titleTemplate,
        bodyTemplate: input.bodyTemplate,
        acceptanceCriteria: input.acceptanceCriteria,
        size: input.size,
        model: input.model,
        labels: input.labels,
        dependenciesMode: input.dependenciesMode === 'ask' ? 'ASK' : 'NONE',
      },
      include,
    });
    await audit(this.prisma, {
      actorUserId: user.id,
      action: 'template.created',
      ...(projectId ? { projectId } : {}),
      ip,
      data: { templateId: row.id, scope: row.scope, name: row.name },
    });
    return toView(row, true);
  }

  /** The row, only when the user may edit it. */
  private async editable(id: string, user: User): Promise<Row> {
    if (id.startsWith('builtin:') && BUILTIN_TEMPLATES.some((b) => builtinId(b.slug) === id)) {
      throw new HttpError(403, 'template_readonly', 'Built-in templates are read-only');
    }
    const row = await this.row(id);
    if (row.scope === 'PERSONAL') {
      if (row.createdById !== user.id) throw notFound();
      return row;
    }
    const [, access] = await this.tasks.visibleProject(row.projectId!, user);
    if (!access.isOwner) {
      throw new HttpError(403, 'forbidden', 'Only the project owner manages shared templates');
    }
    return row;
  }

  async update(
    id: string,
    user: User,
    patch: ReturnType<typeof UpdateTemplateRequestSchema.parse>,
    ip?: string,
  ): Promise<TaskTemplateView> {
    const cur = await this.editable(id, user);
    // Placeholder syntax is checked on the merged result too (a patch may touch only one field).
    const merged = { ...cur, ...patch };
    const parsed = CreateTemplateRequestSchema.safeParse({
      scope: 'personal',
      name: merged.name,
      description: merged.description,
      titleTemplate: merged.titleTemplate,
      bodyTemplate: merged.bodyTemplate,
      acceptanceCriteria: merged.acceptanceCriteria,
      size: merged.size,
      model: merged.model,
      labels: merged.labels,
      dependenciesMode:
        merged.dependenciesMode === 'ASK' || merged.dependenciesMode === 'ask' ? 'ask' : 'none',
    });
    if (!parsed.success) {
      throw new HttpError(
        400,
        'invalid_request',
        parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      );
    }
    const { dependenciesMode, ...rest } = patch;
    const row = await this.prisma.taskTemplate.update({
      where: { id },
      data: {
        ...rest,
        ...(dependenciesMode
          ? { dependenciesMode: dependenciesMode === 'ask' ? 'ASK' : 'NONE' }
          : {}),
      },
      include,
    });
    await audit(this.prisma, {
      actorUserId: user.id,
      action: 'template.updated',
      ...(row.projectId ? { projectId: row.projectId } : {}),
      ip,
      data: { templateId: id, fields: Object.keys(patch) },
    });
    return toView(row, true);
  }

  async remove(id: string, user: User, ip?: string): Promise<void> {
    const cur = await this.editable(id, user);
    await this.prisma.taskTemplate.delete({ where: { id } });
    await audit(this.prisma, {
      actorUserId: user.id,
      action: 'template.deleted',
      ...(cur.projectId ? { projectId: cur.projectId } : {}),
      ip,
      data: { templateId: id, name: cur.name },
    });
  }

  private async row(id: string): Promise<Row> {
    const row = await this.prisma.taskTemplate.findUnique({ where: { id }, include });
    if (!row) throw notFound();
    return row;
  }
}

const notFound = () => new HttpError(404, 'not_found', 'Template not found');

export function registerTemplates(app: FastifyInstance, deps: AuthDeps): TemplateService {
  const svc = new TemplateService(deps);

  app.get('/api/templates', async (req): Promise<TaskTemplateView[]> => {
    const user = requireUser(req);
    const { projectId } = req.query as { projectId?: string };
    return svc.list(user, projectId || undefined);
  });

  app.post('/api/templates', async (req, reply): Promise<TaskTemplateView> => {
    const user = requireUser(req);
    const body = parseBody(CreateTemplateRequestSchema, req.body);
    return reply.status(201).send(await svc.create(user, body, req.ip));
  });

  app.patch('/api/templates/:id', async (req): Promise<TaskTemplateView> => {
    const user = requireUser(req);
    const { id } = req.params as { id: string };
    const patch = parseBody(UpdateTemplateRequestSchema, req.body);
    return svc.update(id, user, patch, req.ip);
  });

  app.delete('/api/templates/:id', async (req, reply) => {
    const user = requireUser(req);
    const { id } = req.params as { id: string };
    await svc.remove(id, user, req.ip);
    return reply.status(204).send();
  });

  app.post('/api/templates/:id/render', async (req): Promise<RenderedTemplate> => {
    const user = requireUser(req);
    const { id } = req.params as { id: string };
    const { variables } = parseBody(RenderTemplateRequestSchema, req.body);
    return svc.render(await svc.getForUse(id, user), variables);
  });

  return svc;
}
