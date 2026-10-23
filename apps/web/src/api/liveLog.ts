import {
  LiveLogLinesSchema,
  LiveLogMetaSchema,
  type LiveLogLine,
  type LiveLogMeta,
} from '@orch/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ZodType } from 'zod';

/** Lines kept in the page; older ones are dropped (the server buffer is bounded too). */
export const MAX_CLIENT_LINES = 5000;

export type LiveLogConnection = 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface LiveLogState {
  lines: LiveLogLine[];
  meta: LiveLogMeta | null;
  connection: LiveLogConnection;
  /** Reopens a stream the browser gave up on (signed out, task hidden, server gone). */
  reconnect: () => void;
}

function parse<T>(schema: ZodType<T>, raw: string): T | null {
  try {
    const r = schema.safeParse(JSON.parse(raw));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

const supported = () => typeof EventSource !== 'undefined';

/**
 * Follows `GET /api/tasks/:id/logs/stream` (SSE). The browser reconnects on its own after a
 * network drop or the server's periodic close and resumes with `Last-Event-ID`; a refused
 * reconnect (401/404) ends in `closed`, and `reconnect()` tries again from the last line seen.
 */
export function useLiveLog(taskId: string): LiveLogState {
  const [lines, setLines] = useState<LiveLogLine[]>([]);
  const [meta, setMeta] = useState<LiveLogMeta | null>(null);
  const [connection, setConnection] = useState<LiveLogConnection>('connecting');
  const [attempt, setAttempt] = useState(0);
  const lastId = useRef(0);
  const run = useRef<string | null>(null);

  useEffect(() => {
    if (!supported()) return;
    const after = lastId.current > 0 ? `?after=${lastId.current}` : '';
    const es = new EventSource(`/api/tasks/${encodeURIComponent(taskId)}/logs/stream${after}`, {
      withCredentials: true,
    });
    const onMeta = (e: MessageEvent<string>) => {
      const m = parse(LiveLogMetaSchema, e.data);
      if (!m) return;
      if (m.assignmentId !== null && run.current !== null && m.assignmentId !== run.current) {
        setLines([]); // a new run of the task (retry): start over
      }
      if (m.assignmentId !== null) run.current = m.assignmentId;
      setMeta(m);
    };
    const onLines = (e: MessageEvent<string>) => {
      const batch = parse(LiveLogLinesSchema, e.data);
      if (!batch || batch.lines.length === 0) return;
      const fresh = batch.lines.filter((l) => l.id > lastId.current);
      if (fresh.length === 0) return;
      lastId.current = (fresh[fresh.length - 1] as LiveLogLine).id;
      setLines((prev) => {
        const next = prev.concat(fresh);
        return next.length > MAX_CLIENT_LINES ? next.slice(next.length - MAX_CLIENT_LINES) : next;
      });
    };
    es.addEventListener('meta', onMeta as EventListener);
    es.addEventListener('end', onMeta as EventListener);
    es.addEventListener('lines', onLines as EventListener);
    es.onopen = () => setConnection('open');
    es.onerror = () => {
      setConnection(es.readyState === EventSource.CLOSED ? 'closed' : 'reconnecting');
    };
    return () => es.close();
  }, [taskId, attempt]);

  const reconnect = useCallback(() => {
    setConnection('reconnecting');
    setAttempt((n) => n + 1);
  }, []);
  return { lines, meta, connection: supported() ? connection : 'closed', reconnect };
}
