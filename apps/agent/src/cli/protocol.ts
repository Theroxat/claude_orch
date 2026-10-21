/** Control socket protocol between `orch` and the daemon: newline-delimited JSON. */
import { z } from 'zod';

export const ControlRequestSchema = z.object({
  cmd: z.enum(['status', 'pause', 'resume']),
});
export type ControlRequest = z.infer<typeof ControlRequestSchema>;

export const StatusInfoSchema = z.object({
  agentId: z.string().nullable(),
  version: z.string(),
  connected: z.boolean(),
  paused: z.boolean(),
  /** Server base URL, never the credential. */
  serverUrl: z.string(),
  lastUsageReportAt: z.string().nullable(),
  outboxPending: z.number().int().nonnegative(),
});
export type StatusInfo = z.infer<typeof StatusInfoSchema>;

export const ControlResponseSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), status: StatusInfoSchema }),
  z.object({ ok: z.literal(false), error: z.object({ code: z.string(), message: z.string() }) }),
]);
export type ControlResponse = z.infer<typeof ControlResponseSchema>;
