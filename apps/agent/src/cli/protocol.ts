/** Control socket protocol between `orch` and the daemon: newline-delimited JSON. */
import { z } from 'zod';
import { ClaudeAuthPayloadSchema } from '@orch/shared';

const Issue = z.number().int().positive();

export const ControlRequestSchema = z.discriminatedUnion('cmd', [
  z.object({ cmd: z.literal('status') }),
  z.object({ cmd: z.literal('pause') }),
  z.object({ cmd: z.literal('resume') }),
  z.object({ cmd: z.literal('list'), project: z.string().optional() }),
  z.object({ cmd: z.literal('take'), issue: Issue, project: z.string().optional() }),
  z.object({ cmd: z.literal('done'), issue: Issue, project: z.string().optional() }),
  z.object({ cmd: z.literal('attach'), issue: Issue, project: z.string().optional() }),
  z.object({ cmd: z.literal('shell'), issue: Issue, project: z.string().optional() }),
  z.object({
    cmd: z.literal('logs'),
    issue: Issue,
    project: z.string().optional(),
    follow: z.boolean().optional(),
    lines: z.number().int().positive().max(10_000).optional(),
  }),
  z.object({ cmd: z.literal('requests') }),
  z.object({ cmd: z.literal('accept'), id: z.string().min(1).max(200) }),
  z.object({ cmd: z.literal('reject'), id: z.string().min(1).max(200) }),
  z.object({
    cmd: z.literal('update'),
    /** Target release; default: the version the server announced in `welcome`. */
    version: z.string().min(1).max(64).optional(),
    whenIdle: z.boolean().optional(),
  }),
  /** Runs the real Claude login check now (`orch doctor`, `orch login`). */
  z.object({
    cmd: z.literal('claude.check'),
    reason: z.string().min(1).max(64).optional(),
  }),
]);
export type ControlRequest = z.infer<typeof ControlRequestSchema>;
export type ControlCommand = ControlRequest['cmd'];

export const UpdateStateSchema = z.object({
  updateId: z.string(),
  targetVersion: z.string(),
  status: z.enum(['pending', 'deferred', 'pulling', 'restarting', 'failed', 'done']),
  code: z.string().optional(),
  detail: z.string().optional(),
});

export const StatusInfoSchema = z.object({
  agentId: z.string().nullable(),
  version: z.string(),
  connected: z.boolean(),
  paused: z.boolean(),
  /** Server base URL, never the credential. */
  serverUrl: z.string(),
  lastUsageReportAt: z.string().nullable(),
  outboxPending: z.number().int().nonnegative(),
  maxConcurrent: z.number().int().positive().optional(),
  /** Version the server recommends (from `welcome`), null when unknown. */
  latestAgentVersion: z.string().nullable().optional(),
  /** Last self-update of this agent process, if any. */
  update: UpdateStateSchema.nullable().optional(),
  /** False after a task failed on an expired Claude login, until `orch login`. */
  claudeAuthValid: z.boolean().optional(),
});
export type StatusInfo = z.infer<typeof StatusInfoSchema>;

export const TaskViewSchema = z.object({
  assignmentId: z.string(),
  project: z.string(),
  issueNumber: z.number().int(),
  title: z.string(),
  branch: z.string(),
  state: z.string(),
  prUrl: z.string().nullable(),
  error: z.string().nullable(),
  warnings: z.array(z.string()),
  attach: z.string(),
  mode: z.enum(['auto', 'manual']).optional(),
  startedAt: z.string().nullable().optional(),
  timeoutSec: z.number().nullable().optional(),
  elapsedSec: z.number().nullable().optional(),
});
export type TaskViewInfo = z.infer<typeof TaskViewSchema>;

export const AvailableTaskSchema = z.object({
  taskId: z.string(),
  projectFullName: z.string(),
  issueNumber: z.number().int(),
  title: z.string(),
  size: z.string(),
  model: z.string(),
  createdBy: z.object({ login: z.string() }),
});

export const RequestViewSchema = z.object({
  assignmentId: z.string(),
  project: z.string(),
  issueNumber: z.number().int(),
  title: z.string(),
  size: z.string(),
  model: z.string(),
  createdBy: z.string(),
  expiresAt: z.string().nullable(),
});
export type RequestViewInfo = z.infer<typeof RequestViewSchema>;

/** Successful answer: each command fills the fields it needs. */
export const ControlResultSchema = z.object({
  status: StatusInfoSchema.optional(),
  tasks: z.array(TaskViewSchema).optional(),
  task: TaskViewSchema.optional(),
  available: z.array(AvailableTaskSchema).optional(),
  /** Interactive command for the CLI to run (attach, shell, logs). */
  exec: z.array(z.string()).optional(),
  /** Pending approval requests (`orch requests`). */
  requests: z.array(RequestViewSchema).optional(),
  /** Human-readable outcome (accept, reject, update). */
  message: z.string().optional(),
  /** `update`: the resulting update state. */
  update: UpdateStateSchema.optional(),
  /** `claude.check`: result of the real Claude login check. */
  claudeAuth: ClaudeAuthPayloadSchema.optional(),
});
export type ControlResult = z.infer<typeof ControlResultSchema>;

export const ControlResponseSchema = z.union([
  ControlResultSchema.extend({ ok: z.literal(true) }),
  z.object({ ok: z.literal(false), error: z.object({ code: z.string(), message: z.string() }) }),
]);
export type ControlResponse = z.infer<typeof ControlResponseSchema>;
