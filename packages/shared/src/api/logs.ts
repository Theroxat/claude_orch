/**
 * Live task logs (v0.8): follow a running auto-mode task from the web.
 *
 *   GET /api/tasks/:id/logs/stream   (cookie session) -> `text/event-stream`
 *
 * Same visibility as `GET /api/tasks/:id` (404 when the caller may not see the task). The server
 * keeps a bounded in-memory buffer per assignment (live, and for a while after it finished): on
 * connect it replays that backlog, then pushes new lines as the agent sends them. Events:
 *
 *   event: meta     data: LiveLogMeta     (first, and again whenever a new run of the task starts)
 *   event: lines    data: LiveLogLines    `id:` = the id of the last line (resume point)
 *   event: end      data: LiveLogMeta     the run finished; the stream stays open for a retry
 *   `: ping` comments every 15 s keep proxies from closing an idle stream.
 *
 * Reconnects send `Last-Event-ID` (EventSource does it on its own; `?after=<id>` works too):
 * only lines with a greater id are replayed. Line ids grow across runs, so a client keeps one
 * resume point per task.
 */
import { z } from 'zod';
import { TaskLogEntrySchema } from '../protocol/messages';

export const LiveLogLineSchema = TaskLogEntrySchema.extend({ id: z.number().int().positive() });
export type LiveLogLine = z.infer<typeof LiveLogLineSchema>;

export const LiveLogState = z.enum(['waiting', 'live', 'finished']);
export type LiveLogState = z.infer<typeof LiveLogState>;

export const LiveLogMetaSchema = z.object({
  /** The run being shown; null while waiting for one (or after the buffer expired). */
  assignmentId: z.string().nullable(),
  state: LiveLogState,
  /** Lines dropped from the start of the buffer (it is bounded) or lost on the way. */
  truncated: z.number().int().nonnegative(),
});
export type LiveLogMeta = z.infer<typeof LiveLogMetaSchema>;

export const LiveLogLinesSchema = z.object({ lines: z.array(LiveLogLineSchema) });
export type LiveLogLines = z.infer<typeof LiveLogLinesSchema>;

/* eslint-disable no-control-regex -- these patterns exist to match control characters */
const ANSI_RE =
  /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;
const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
/* eslint-enable no-control-regex */

/** Removes ANSI escape sequences (colors, cursor moves, OSC titles) and stray control bytes. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '').replace(CONTROL_RE, '');
}
