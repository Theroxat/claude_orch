/**
 * Live task output (v0.8): bounded in-memory buffers, one per assignment, fed by the agents'
 * `task.log` batches and read by the web (SSE). Nothing is written to the database: a server
 * restart forgets them, and a finished run's buffer is kept for `retainMs`, then dropped.
 */
import {
  StreamRedactor,
  TASK_LOG_TEXT_MAX,
  redactSecrets,
  stripAnsi,
  type LiveLogLine,
  type LiveLogMeta,
  type TaskLogEntry,
} from '@orch/shared';

export type LiveLogEvent =
  | { type: 'meta'; meta: LiveLogMeta }
  | { type: 'lines'; lines: LiveLogLine[] }
  | { type: 'end'; meta: LiveLogMeta };

export type LiveLogListener = (e: LiveLogEvent) => void;

interface Run {
  assignmentId: string;
  taskId: string;
  agentId: string;
  lines: LiveLogLine[];
  bytes: number;
  truncated: number;
  finished: boolean;
  lastAt: number;
  /** Per entry kind: a token split between two lines or two batches is masked too. */
  streams: Map<string, StreamRedactor>;
}

export interface LiveLogStoreOptions {
  /** Text kept per run; older lines are dropped first. Default 512 KB. */
  maxBytesPerRun?: number;
  /** How long a finished run stays readable. Default 30 min. */
  retainMs?: number;
  /** A live run that received nothing for this long is treated as finished. Default 4 h. */
  idleMs?: number;
  /** Runs kept at most (finished ones are evicted first). Default 200. */
  maxRuns?: number;
  now?: () => number;
}

/**
 * Approximate heap cost of a stored line: its strings plus the object itself (a few fields,
 * ~150 bytes in V8), so a flood of empty lines is bounded as well as a few long ones.
 */
const lineBytes = (l: { text: string; tool?: string }) =>
  l.text.length + (l.tool?.length ?? 0) + 160;

export class LiveLogStore {
  private readonly runs = new Map<string, Run>();
  /** Latest run per task. */
  private readonly byTask = new Map<string, string>();
  private readonly listeners = new Map<string, Set<LiveLogListener>>();
  /**
   * Line ids grow across every run, so one resume point per client is enough. They also grow
   * across server restarts (seeded from the clock: start time in ms x 1000): a browser that
   * reconnects to a restarted server with an old `Last-Event-ID` must not have every new line
   * filtered out as "already seen". 1000 ids per millisecond of uptime leave plenty of room,
   * and the values stay far below Number.MAX_SAFE_INTEGER.
   */
  private nextId: number;
  private readonly maxBytes: number;
  private readonly retainMs: number;
  private readonly idleMs: number;
  private readonly maxRuns: number;
  private readonly now: () => number;

  constructor(o: LiveLogStoreOptions = {}) {
    this.maxBytes = o.maxBytesPerRun ?? 512 * 1024;
    this.retainMs = o.retainMs ?? 30 * 60_000;
    this.idleMs = o.idleMs ?? 4 * 3600_000;
    this.maxRuns = o.maxRuns ?? 200;
    this.now = o.now ?? Date.now;
    this.nextId = Math.max(1, Math.floor(this.now()) * 1000);
  }

  /** Who may append to a known run (the gateway checks the database for unknown ones). */
  owner(assignmentId: string): { agentId: string; taskId: string; finished: boolean } | undefined {
    const r = this.runs.get(assignmentId);
    return r && { agentId: r.agentId, taskId: r.taskId, finished: r.finished };
  }

  /** Opens the buffer of a run that the gateway verified (assignment of that agent, running). */
  start(assignmentId: string, taskId: string, agentId: string): void {
    if (this.runs.has(assignmentId)) return;
    this.sweep();
    const prev = this.byTask.get(taskId);
    const old = prev ? this.runs.get(prev) : undefined;
    if (old && !old.finished) old.finished = true; // superseded by a new run (retry, re-offer)
    const run: Run = {
      assignmentId,
      taskId,
      agentId,
      lines: [],
      bytes: 0,
      truncated: 0,
      finished: false,
      lastAt: this.now(),
      streams: new Map(),
    };
    this.runs.set(assignmentId, run);
    this.byTask.set(taskId, assignmentId);
    this.emit(taskId, { type: 'meta', meta: this.metaOf(run) });
  }

  /** Adds a batch (sanitized again here: redacted, ANSI stripped, clipped). */
  append(assignmentId: string, entries: readonly TaskLogEntry[], lost = 0): void {
    const run = this.runs.get(assignmentId);
    if (!run || run.finished) return;
    run.lastAt = this.now();
    run.truncated += lost;
    const added: LiveLogLine[] = [];
    for (const e of entries) {
      let stream = run.streams.get(e.kind);
      if (!stream) run.streams.set(e.kind, (stream = new StreamRedactor()));
      const line: LiveLogLine = {
        id: this.nextId++,
        ts: e.ts,
        kind: e.kind,
        text: stream.push(stripAnsi(e.text)).slice(0, TASK_LOG_TEXT_MAX),
        ...(e.tool !== undefined ? { tool: redactSecrets(stripAnsi(e.tool)).slice(0, 80) } : {}),
        ...(e.error ? { error: true } : {}),
      };
      run.lines.push(line);
      run.bytes += lineBytes(line);
      added.push(line);
    }
    while (run.bytes > this.maxBytes && run.lines.length > 0) {
      const old = run.lines.shift() as LiveLogLine;
      run.bytes -= lineBytes(old);
      run.truncated++;
    }
    if (added.length > 0 && this.byTask.get(run.taskId) === assignmentId) {
      this.emit(run.taskId, { type: 'lines', lines: added });
    }
  }

  /** The run ended (`task.finished`); its buffer stays readable for `retainMs`. */
  finish(assignmentId: string): void {
    const run = this.runs.get(assignmentId);
    if (!run || run.finished) return;
    run.finished = true;
    run.lastAt = this.now();
    if (this.byTask.get(run.taskId) === assignmentId) {
      this.emit(run.taskId, { type: 'end', meta: this.metaOf(run) });
    }
  }

  /** Current state of a task's latest run and its lines after `after` (exclusive). */
  snapshot(taskId: string, after = 0): { meta: LiveLogMeta; lines: LiveLogLine[] } {
    this.sweep();
    const id = this.byTask.get(taskId);
    const run = id ? this.runs.get(id) : undefined;
    if (!run) return { meta: { assignmentId: null, state: 'waiting', truncated: 0 }, lines: [] };
    return { meta: this.metaOf(run), lines: run.lines.filter((l) => l.id > after) };
  }

  subscribe(taskId: string, fn: LiveLogListener): () => void {
    let set = this.listeners.get(taskId);
    if (!set) this.listeners.set(taskId, (set = new Set()));
    set.add(fn);
    return () => {
      set.delete(fn);
      if (set.size === 0) this.listeners.delete(taskId);
    };
  }

  /** Drops expired runs (finished past retention, idle live runs, over the run cap). */
  sweep(): void {
    const now = this.now();
    for (const run of this.runs.values()) {
      if (!run.finished && now - run.lastAt > this.idleMs) this.finish(run.assignmentId);
    }
    for (const run of [...this.runs.values()]) {
      if (run.finished && now - run.lastAt > this.retainMs) this.drop(run);
    }
    if (this.runs.size >= this.maxRuns) {
      // Finished first (oldest first), then the idlest live runs.
      const order = [...this.runs.values()].sort(
        (a, b) => Number(b.finished) - Number(a.finished) || a.lastAt - b.lastAt,
      );
      for (const run of order) {
        if (this.runs.size < this.maxRuns) break;
        this.drop(run);
      }
    }
  }

  /** Number of runs held (tests, metrics). */
  get size(): number {
    return this.runs.size;
  }

  private drop(run: Run): void {
    this.runs.delete(run.assignmentId);
    if (this.byTask.get(run.taskId) === run.assignmentId) {
      this.byTask.delete(run.taskId);
      this.emit(run.taskId, {
        type: 'meta',
        meta: { assignmentId: null, state: 'waiting', truncated: 0 },
      });
    }
  }

  private metaOf(run: Run): LiveLogMeta {
    return {
      assignmentId: run.assignmentId,
      state: run.finished ? 'finished' : 'live',
      truncated: run.truncated,
    };
  }

  private emit(taskId: string, e: LiveLogEvent): void {
    for (const fn of this.listeners.get(taskId) ?? []) {
      try {
        fn(e);
      } catch {
        // A broken subscriber never affects the others or the agent's frame.
      }
    }
  }
}
