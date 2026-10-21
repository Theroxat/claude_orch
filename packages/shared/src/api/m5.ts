/**
 * M5 contract: personal access tokens (REST) and the MCP tool inputs.
 *
 * REST routes (cookie session, JSON):
 *   POST   /api/tokens        CreatePersonalTokenRequest -> CreatePersonalTokenResponse (201)
 *          The plain token is returned ONCE (only its SHA-256 is stored). `mcpAddCommand` is the
 *          ready-to-paste `claude mcp add` command, pre-filled with the server URL and the token.
 *   GET    /api/tokens        -> PersonalTokenView[]   the caller's tokens, newest first (revoked
 *          ones included, with `revokedAt` set). Never contains the token itself.
 *   DELETE /api/tokens/:id    -> 204   revokes the token (idempotent). 404 for other users' tokens.
 *   Create and revoke are written to the audit log (`token.created`, `token.revoked`).
 *
 * MCP endpoint: Streamable HTTP at `/mcp`, `Authorization: Bearer orch_pat_<...>` (401 otherwise).
 * Tools: view_pool, list_tasks, submit_task, take_task, task_status, retry_task (inputs below). Each tool runs
 * the same permission and consent checks as the REST API, as the token's user.
 *
 * Errors: HTTP status + `{ error: { code, message } }` (see ApiErrorSchema in m1). Tool errors are
 * returned as an MCP tool result with `isError: true` and the same `{ error: { code, message } }`.
 */
import { z } from 'zod';
import { TaskStatus } from './m3';

export const PAT_PREFIX = 'orch_pat_';
export const PersonalTokenScope = z.enum(['mcp']);
export type PersonalTokenScope = z.infer<typeof PersonalTokenScope>;

export const CreatePersonalTokenRequestSchema = z.object({
  name: z.string().trim().min(1).max(100),
  /** Optional lifetime in days. Omitted: the token does not expire (revoke it instead). */
  expiresInDays: z.number().int().min(1).max(3650).optional(),
});
export type CreatePersonalTokenRequest = z.infer<typeof CreatePersonalTokenRequestSchema>;

export const PersonalTokenViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** First characters of the token, for recognizing it (e.g. `orch_pat_AbCd`). */
  prefix: z.string(),
  scopes: z.array(PersonalTokenScope),
  createdAt: z.string(),
  lastUsedAt: z.string().nullable(),
  expiresAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
});
export type PersonalTokenView = z.infer<typeof PersonalTokenViewSchema>;
export const PersonalTokenListResponseSchema = z.array(PersonalTokenViewSchema);

export const CreatePersonalTokenResponseSchema = PersonalTokenViewSchema.extend({
  /** The plain token. Shown once, never retrievable again. */
  token: z.string().startsWith(PAT_PREFIX),
  /** `claude mcp add --transport http --scope user orch <url>/mcp --header "Authorization: Bearer <token>"` */
  mcpAddCommand: z.string(),
  /** The OAuth alternative without a token: `claude mcp add ... <url>/mcp`, then `/mcp` -> Authenticate. */
  mcpAddCommandOAuth: z.string().optional(),
});
export type CreatePersonalTokenResponse = z.infer<typeof CreatePersonalTokenResponseSchema>;

/** The `claude mcp add` command for a server base URL and a token (or a placeholder). */
export function mcpAddCommand(baseUrl: string, token = '<your-orch-token>'): string {
  const url = `${baseUrl.replace(/\/+$/, '')}/mcp`;
  return `claude mcp add --transport http --scope user orch ${url} --header "Authorization: Bearer ${token}"`;
}

// ---------- MCP tool inputs ----------

const ProjectFullName = z
  .string()
  .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, 'Expected "owner/repo"')
  .describe('GitHub repository of the project, as "owner/repo".');

export const ViewPoolInputSchema = z.object({
  projectFullName: ProjectFullName.optional().describe(
    'Limit to one project ("owner/repo"). Omitted: every project you own or participate in.',
  ),
});
export type ViewPoolInput = z.infer<typeof ViewPoolInputSchema>;

export const ListTasksInputSchema = z.object({
  projectFullName: ProjectFullName.optional().describe(
    'Limit to one project ("owner/repo"). Omitted: every project you own or participate in.',
  ),
  status: z
    .union([TaskStatus, z.array(TaskStatus)])
    .optional()
    .describe('Only tasks in this status (or any of these statuses).'),
});
export type ListTasksInput = z.infer<typeof ListTasksInputSchema>;

export const SubmitTaskItemSchema = z.object({
  ref: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,40}$/)
    .describe('Local id of this subtask inside the request (e.g. "a"), used by dependsOn.'),
  title: z.string().trim().min(1).max(200).describe('Short imperative title of the issue.'),
  description: z
    .string()
    .trim()
    .min(1)
    .max(20_000)
    .describe(
      'Self-contained instructions for the Claude Code session that will run it: context, files, approach.',
    ),
  acceptanceCriteria: z
    .array(z.string().trim().min(1).max(500))
    .min(1)
    .max(30)
    .describe('Checkable conditions that prove the subtask is done (tests pass, behavior...).'),
  size: z.enum(['S', 'M', 'L']).describe('S < 30 min, M < 90 min, L < 180 min of agent time.'),
  model: z.enum(['sonnet', 'opus']).describe('sonnet for routine work, opus for hard work.'),
  dependsOn: z
    .array(z.union([z.string().min(1), z.number().int().positive()]))
    .max(30)
    .default([])
    .describe(
      'Refs of other subtasks of this request, or issue numbers of existing tasks of the same project ("#12" or 12).',
    ),
});
export type SubmitTaskItem = z.infer<typeof SubmitTaskItemSchema>;

export const SubmitTaskInputSchema = z.object({
  projectFullName: ProjectFullName,
  tasks: z.array(SubmitTaskItemSchema).min(1).max(20),
  integrationBranch: z
    .string()
    .regex(/^(?!-)(?!.*\.\.)(?!.*\/\/)[A-Za-z0-9._/-]{1,200}(?<![/.])$/, 'Invalid branch name')
    .optional()
    .describe(
      'Branch the subtask PRs target. Created from the default branch when it does not exist.',
    ),
  dispatch: z
    .object({
      mode: z.enum(['pool', 'members', 'broadcast']),
      members: z
        .array(z.string().min(1))
        .max(50)
        .optional()
        .describe('GitHub logins, required when mode is "members".'),
    })
    .default({ mode: 'pool' })
    .describe(
      'pool: best available member. members: only these participants. broadcast (project owner only): offered to every eligible member, first acceptance wins.',
    ),
});
export type SubmitTaskInput = z.infer<typeof SubmitTaskInputSchema>;

export const TakeTaskInputSchema = z.object({
  projectFullName: ProjectFullName,
  issueNumber: z.number().int().positive(),
});
export type TakeTaskInput = z.infer<typeof TakeTaskInputSchema>;

export const TaskStatusInputSchema = TakeTaskInputSchema;
export type TaskStatusInput = z.infer<typeof TaskStatusInputSchema>;

/** v0.5.1: same semantics and rights as `POST /api/tasks/:id/retry` (owner or creator). */
export const RetryTaskInputSchema = TakeTaskInputSchema;
export type RetryTaskInput = z.infer<typeof RetryTaskInputSchema>;

export const MCP_TOOL_NAMES = [
  'view_pool',
  'list_tasks',
  'submit_task',
  'take_task',
  'task_status',
  'retry_task',
] as const;
