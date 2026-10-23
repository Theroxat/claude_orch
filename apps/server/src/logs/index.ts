/**
 * `GET /api/tasks/:id/logs/stream`: live output of a task's latest run as Server-Sent Events
 * (contract in @orch/shared `api/logs.ts`).
 *
 * Authorization is the one of `GET /api/tasks/:id` (signed-in, allowlisted, project visible:
 * owner, active participant or GitHub collaborator), checked when the stream opens. A stream is
 * closed after `LIVE_LOG_STREAM_MAX_MS`; the browser reconnects on its own (with
 * `Last-Event-ID`), which runs the full check again, so a removed member stops receiving output
 * within that delay.
 */
import type { FastifyInstance } from 'fastify';
import type { LiveLogLine, LiveLogMeta } from '@orch/shared';
import { requireUser, type AuthDeps } from '../auth';
import { HttpError } from '../http/errors';
import { TaskService } from '../tasks/service';
import type { LiveLogEvent, LiveLogStore } from './store';

export { LiveLogStore } from './store';

declare module 'fastify' {
  interface FastifyInstance {
    liveLogs: LiveLogStore;
  }
}

export const LIVE_LOG_STREAM_MAX_MS = 2 * 60_000;
const PING_MS = 15_000;
const MAX_STREAMS_PER_USER = 8;
/** Backlog lines per `lines` event on connect. */
const REPLAY_BATCH = 500;
/**
 * Output queued for a client that does not read (slow link, stalled tab, hostile client) beyond
 * this is not buffered further: the stream is closed and the browser resumes from the last
 * event it really received (`Last-Event-ID`), so nothing is lost and memory stays bounded.
 */
export const LIVE_LOG_MAX_QUEUED_BYTES = 1024 * 1024;

function resumePoint(header: unknown, query: unknown): number {
  for (const v of [header, query]) {
    const n = typeof v === 'string' ? Number(v) : NaN;
    if (Number.isSafeInteger(n) && n >= 0) return n;
  }
  return 0;
}

export function registerLiveLogs(
  app: FastifyInstance,
  deps: AuthDeps & { liveLogs: LiveLogStore; streamMaxMs?: number; maxQueuedBytes?: number },
): void {
  const svc = new TaskService(deps);
  const store = deps.liveLogs;
  const open = new Map<string, number>();
  const sweep = setInterval(() => store.sweep(), 60_000);
  sweep.unref();
  const closers = new Set<() => void>();
  app.decorate('liveLogs', store);
  // preClose: open streams would otherwise keep the server from closing.
  app.addHook('preClose', async () => {
    clearInterval(sweep);
    for (const c of [...closers]) c();
  });

  app.get('/api/tasks/:id/logs/stream', async (req, reply) => {
    const user = requireUser(req);
    const { id } = req.params as { id: string };
    const [task] = await svc.getVisible(id, user); // 404 when not visible
    const count = open.get(user.id) ?? 0;
    if (count >= MAX_STREAMS_PER_USER) {
      throw new HttpError(429, 'too_many_streams', 'Too many open log streams');
    }
    open.set(user.id, count + 1);
    let after = resumePoint(
      req.headers['last-event-id'],
      (req.query as Record<string, unknown> | undefined)?.after,
    );

    let closed = false;
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      'x-accel-buffering': 'no',
      'x-content-type-options': 'nosniff',
      connection: 'keep-alive',
    });
    const maxQueued = deps.maxQueuedBytes ?? LIVE_LOG_MAX_QUEUED_BYTES;
    // The backlog replay is bounded by the store already; the cap applies to what comes after.
    let replaying = true;
    const write = (chunk: string) => {
      if (closed || raw.destroyed || raw.writableEnded) return;
      raw.write(chunk);
      if (!replaying && raw.writableLength > maxQueued) close();
    };
    const event = (name: string, data: unknown, eventId?: number) =>
      write(
        `${eventId !== undefined ? `id: ${eventId}\n` : ''}event: ${name}\ndata: ${JSON.stringify(data)}\n\n`,
      );
    const sendLines = (lines: LiveLogLine[]) => {
      const fresh = lines.filter((l) => l.id > after);
      for (let i = 0; i < fresh.length; i += REPLAY_BATCH) {
        const batch = fresh.slice(i, i + REPLAY_BATCH);
        after = (batch[batch.length - 1] as LiveLogLine).id;
        event('lines', { lines: batch }, after);
      }
    };
    const sendMeta = (name: 'meta' | 'end', meta: LiveLogMeta) => event(name, meta);

    const unsubscribe = store.subscribe(task.id, (e: LiveLogEvent) => {
      if (e.type === 'lines') sendLines(e.lines);
      else sendMeta(e.type, e.meta);
    });
    const ping = setInterval(() => write(': ping\n\n'), PING_MS);
    const lifetime = setTimeout(() => close(), deps.streamMaxMs ?? LIVE_LOG_STREAM_MAX_MS);
    function close() {
      if (closed) return;
      closed = true;
      closers.delete(close);
      clearInterval(ping);
      clearTimeout(lifetime);
      unsubscribe();
      const n = (open.get(user.id) ?? 1) - 1;
      if (n <= 0) open.delete(user.id);
      else open.set(user.id, n);
      if (!raw.writableEnded) raw.end();
    }
    closers.add(close);
    raw.on('close', close);
    raw.on('error', close);

    // Synchronous: no store event can slip in between the snapshot and the subscription above.
    write('retry: 2000\n\n');
    const snap = store.snapshot(task.id, after);
    sendMeta('meta', snap.meta);
    sendLines(snap.lines);
    if (snap.meta.state === 'finished') sendMeta('end', snap.meta);
    replaying = false;
  });
}
