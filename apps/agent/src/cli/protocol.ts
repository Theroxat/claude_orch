/** Control socket protocol between `orch` and the daemon: newline-delimited JSON. */
import { z } from 'zod';

const Issue = z.number().int().positive();

export const ControlRequestSchema = z.discriminatedUnion('cmd', [
  z.object({ cmd: z.literal('status') }),
  z.object({ cmd: z.literal('pause') }),
  z.object({ cmd: z.literal('resume') }),
  z.object({ cmd: z.literal('list'), project: z.string().optional() }),
  z.object({ cmd: z.literal('take'), issue: Issue, project: z.string().optional() }),
  z.object({ cmd: z.literal('done'), issue: Issue }),
  z.object({ cmd: z.literal('attach'), issue: Issue }),
  z.object({ cmd: z.literal('shell'), issue: Issue }),
]);
export type ControlRequest = z.infer<typeof ControlRequestSchema>;
export type ControlCommand = ControlRequest['cmd'];

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

/** Successful answer: each command fills the fields it needs. */
export const ControlResultSchema = z.object({
  status: StatusInfoSchema.optional(),
  tasks: z.array(TaskViewSchema).optional(),
  task: TaskViewSchema.optional(),
  available: z.array(AvailableTaskSchema).optional(),
  /** Interactive command for the CLI to run (attach, shell). */
  exec: z.array(z.string()).optional(),
});
export type ControlResult = z.infer<typeof ControlResultSchema>;

export const ControlResponseSchema = z.union([
  ControlResultSchema.extend({ ok: z.literal(true) }),
  z.object({ ok: z.literal(false), error: z.object({ code: z.string(), message: z.string() }) }),
]);
export type ControlResponse = z.infer<typeof ControlResponseSchema>;
