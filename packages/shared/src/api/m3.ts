/**
 * M3 REST contract: tasks and the Backlog (JSON, cookie session, every route under /api).
 *
 * Routes:
 *   POST   /api/projects/:id/tasks          CreateTaskRequest -> TaskView (201)
 *          Creates the GitHub issue (label `pool`, hidden orch metadata block in the body) and the task.
 *          Submitters (write or more, or owner override) create TODO tasks; proposers (read/triage
 *          or any collaborator without submit rights) create PROPOSED tasks.
 *          409 `pending_limit` when the creator already has `maxPendingTasks` (default 20)
 *          PROPOSED/TODO tasks. 400 `dependency_cycle` / `invalid_dependency` for bad dependsOn.
 *   POST   /api/projects/:id/tasks/import   -> ImportTasksResponse   (submitters and owner)
 *          Imports open issues labeled `pool` that are not imported yet (origin LABEL_IMPORT, TODO).
 *   GET    /api/projects/:id/tasks          -> TaskBoard   (project owner, participants, collaborators)
 *   GET    /api/tasks                       -> TaskBoard   (all my projects: owned or participating)
 *   GET    /api/tasks/:id                   -> TaskView
 *   POST   /api/tasks/:id/approve           -> TaskView    (PROPOSED -> TODO; submitters and owner)
 *   PATCH  /api/tasks/:id                   UpdateTaskRequest -> TaskView  (creator or owner)
 *          Only while the task is PROPOSED or TODO (409 `task_locked` otherwise).
 *
 * Errors: HTTP status + `{ error: { code, message } }` (see ApiErrorSchema in m1).
 */
import { z } from 'zod';
import { Model } from '../domain/enums';
import { TaskSize } from '../protocol/messages';
import { DispatchRequestSchema, DispatchViewSchema } from './dispatch';

/**
 * Effective status shown in the Backlog. BLOCKED is derived: a TODO task whose dependencies are
 * not all DONE. Kanban columns: To do = PROPOSED/BLOCKED/TODO, In progress, In review, Done.
 */
export const TaskStatus = z.enum([
  'PROPOSED',
  'TODO',
  'BLOCKED',
  'IN_PROGRESS',
  'IN_REVIEW',
  'DONE',
]);
export type TaskStatus = z.infer<typeof TaskStatus>;
export const TASK_STATUSES = TaskStatus.options;

export const TaskUserSchema = z.object({
  id: z.string(),
  githubLogin: z.string(),
  avatarUrl: z.string().nullable(),
});
export type TaskUser = z.infer<typeof TaskUserSchema>;

/** A dependency, as shown on a card. */
export const TaskRefSchema = z.object({
  id: z.string(),
  issueNumber: z.number().int(),
  title: z.string(),
  status: TaskStatus,
});
export type TaskRef = z.infer<typeof TaskRefSchema>;

export const TaskViewSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  projectFullName: z.string(),
  issueNumber: z.number().int(),
  issueUrl: z.string(),
  title: z.string(),
  /** Issue description without the orch metadata block. */
  body: z.string(),
  acceptanceCriteria: z.array(z.string()),
  size: TaskSize,
  model: Model,
  status: TaskStatus,
  dependsOn: z.array(TaskRefSchema),
  integrationBranch: z.string().nullable(),
  baseBranch: z.string(),
  branchName: z.string().nullable(),
  prNumber: z.number().int().nullable(),
  prUrl: z.string().nullable(),
  origin: z.enum(['PLATFORM', 'LABEL_IMPORT', 'MCP']),
  createdBy: TaskUserSchema,
  assignee: TaskUserSchema.nullable(),
  assigneeAgentId: z.string().nullable(),
  /** Name of the assignee's machine (the agent), for cards. */
  assigneeMachineName: z.string().nullable().optional(),
  /** The caller may PATCH it (creator or project owner) and the task is still PROPOSED/TODO. */
  canEdit: z.boolean(),
  /** The caller may approve it (PROPOSED, and caller is a submitter or the owner). */
  canApprove: z.boolean(),
  /** M4 (additive): dispatch targeting. */
  dispatch: DispatchViewSchema.optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type TaskView = z.infer<typeof TaskViewSchema>;

/** The caller's rights on one project, so the UI does not infer them. */
export const ProjectTaskAccessSchema = z.object({
  myRole: z.enum(['owner', 'submitter', 'proposer', 'none']),
  /** Create TODO tasks, import issues, approve proposals. */
  canSubmit: z.boolean(),
  /** Create PROPOSED tasks (any collaborator). */
  canPropose: z.boolean(),
  canApprove: z.boolean(),
});
export type ProjectTaskAccess = z.infer<typeof ProjectTaskAccessSchema>;

/** Tasks grouped by effective status; every status key is always present. */
export const TaskBoardSchema = z.object({
  PROPOSED: z.array(TaskViewSchema),
  TODO: z.array(TaskViewSchema),
  BLOCKED: z.array(TaskViewSchema),
  IN_PROGRESS: z.array(TaskViewSchema),
  IN_REVIEW: z.array(TaskViewSchema),
  DONE: z.array(TaskViewSchema),
  /** Caller's rights per projectId (additive; present on the server's responses). */
  access: z.record(z.string(), ProjectTaskAccessSchema).optional(),
});
export type TaskBoard = z.infer<typeof TaskBoardSchema>;

export const CreateTaskRequestSchema = z.object({
  title: z.string().trim().min(1).max(256),
  body: z.string().max(60_000).default(''),
  acceptanceCriteria: z.array(z.string().trim().min(1).max(1000)).max(50).default([]),
  size: TaskSize.default('M'),
  model: Model.default('SONNET'),
  /** Task ids of the same project. */
  dependsOn: z.array(z.string()).max(50).default([]),
  /** Subtask PRs target this branch instead of the default branch. */
  integrationBranch: z.string().trim().min(1).max(200).nullable().default(null),
  /** M4 (additive): who the dispatcher may offer it to. Default `{ mode: 'pool' }`. */
  dispatch: DispatchRequestSchema.optional(),
});
export type CreateTaskRequest = z.input<typeof CreateTaskRequestSchema>;

export const UpdateTaskRequestSchema = z
  .object({
    size: TaskSize,
    model: Model,
    dependsOn: z.array(z.string()).max(50),
  })
  .partial();
export type UpdateTaskRequest = z.infer<typeof UpdateTaskRequestSchema>;

export const ImportTasksResponseSchema = z.object({
  imported: z.array(TaskViewSchema),
  /** Labeled issues that were already imported. */
  alreadyImported: z.number().int().nonnegative(),
});
export type ImportTasksResponse = z.infer<typeof ImportTasksResponseSchema>;
