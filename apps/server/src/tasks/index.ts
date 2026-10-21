import type { FastifyInstance } from 'fastify';
import {
  CreateTaskRequestSchema,
  UpdateTaskRequestSchema,
  type ImportTasksResponse,
  type TaskBoard,
  type TaskView,
  type WhyNotRunningResponse,
} from '@orch/shared';
import { requireUser, type AuthDeps } from '../auth';
import type { Dispatcher } from '../dispatch/dispatcher';
import { HttpError, parseBody } from '../http/errors';
import { TaskService } from './service';

export { TaskService } from './service';

export function registerTasks(
  app: FastifyInstance,
  deps: AuthDeps & { dispatcher?: Dispatcher },
): TaskService {
  const svc = new TaskService(deps);

  app.post('/api/projects/:id/tasks', async (req, reply): Promise<TaskView> => {
    const user = requireUser(req);
    const { id } = req.params as { id: string };
    const body = parseBody(CreateTaskRequestSchema, req.body);
    const [project, access] = await svc.visibleProject(id, user);
    const task = await svc.create(project, user, access, body, req.ip);
    deps.dispatcher?.kick();
    return reply.status(201).send(svc.view(task, access, user));
  });

  app.post('/api/projects/:id/tasks/import', async (req): Promise<ImportTasksResponse> => {
    const user = requireUser(req);
    const { id } = req.params as { id: string };
    const [project, access] = await svc.visibleProject(id, user);
    const r = await svc.importIssues(project, user, access, req.ip);
    return {
      imported: r.imported.map((t) => svc.view(t, access, user)),
      alreadyImported: r.alreadyImported,
    };
  });

  app.get('/api/projects/:id/tasks', async (req): Promise<TaskBoard> => {
    const user = requireUser(req);
    const { id } = req.params as { id: string };
    const [project, access] = await svc.visibleProject(id, user);
    return svc.listForProject(project, user, access);
  });

  app.get('/api/tasks', async (req): Promise<TaskBoard> => svc.listMine(requireUser(req)));

  app.get('/api/tasks/:id', async (req): Promise<TaskView> => {
    const user = requireUser(req);
    const { id } = req.params as { id: string };
    const [t, access] = await svc.getVisible(id, user);
    return svc.view(t, access, user);
  });

  app.post('/api/tasks/:id/approve', async (req): Promise<TaskView> => {
    const user = requireUser(req);
    const { id } = req.params as { id: string };
    const [t, access] = await svc.getVisible(id, user);
    const approved = await svc.approve(t, user, access, req.ip);
    deps.dispatcher?.kick();
    return svc.view(approved, access, user);
  });

  app.patch('/api/tasks/:id', async (req): Promise<TaskView> => {
    const user = requireUser(req);
    const { id } = req.params as { id: string };
    const patch = parseBody(UpdateTaskRequestSchema, req.body);
    const [t, access] = await svc.getVisible(id, user);
    const updated = await svc.update(t, user, access, patch, req.ip);
    // Pending offers and requests were made for the old size, model and dependencies: withdraw
    // them (a new dependency must not be skipped by accepting an older offer), then re-dispatch.
    if (deps.dispatcher) {
      await deps.dispatcher.withdrawForTask(t.id, 'edited');
      deps.dispatcher.kick();
    }
    return svc.view(updated, access, user);
  });

  app.post('/api/tasks/:id/retry', async (req): Promise<TaskView> => {
    const user = requireUser(req);
    const { id } = req.params as { id: string };
    const [t, access] = await svc.getVisible(id, user);
    const retried = await svc.retry(t, user, access, 'web', req.ip);
    deps.dispatcher?.kick();
    return svc.view(retried, access, user);
  });

  app.get('/api/tasks/:id/why-not-running', async (req): Promise<WhyNotRunningResponse> => {
    const user = requireUser(req);
    const { id } = req.params as { id: string };
    await svc.getVisible(id, user);
    if (!deps.dispatcher) {
      throw new HttpError(503, 'dispatcher_unavailable', 'The dispatcher is not running');
    }
    return deps.dispatcher.whyNotRunning(id);
  });

  return svc;
}
