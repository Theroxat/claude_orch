/**
 * Live task output (best effort): turns `claude -p` stream-json lines into compact entries and
 * sends them to the server in batches (`task.log`), outside the durable outbox.
 *
 * Rules: never block or break the run. Every public method swallows its own errors; a batch that
 * cannot be sent right away (offline, socket back-pressure) is dropped and only counted. Text is
 * redacted (known secret values, then the shared token patterns) and stripped of ANSI codes
 * before it is queued, so nothing unredacted is ever held for sending.
 */
import {
  TASK_LOG_MAX_ENTRIES,
  TASK_LOG_TEXT_MAX,
  redactSecrets,
  stripAnsi,
  type TaskLogEntry,
  type TaskLogPayload,
} from '@orch/shared';

/** Flush at least this often while entries are pending. */
export const LIVE_LOG_FLUSH_MS = 500;
/** Flush as soon as a batch reaches this many bytes of text. */
export const LIVE_LOG_BATCH_BYTES = 32 * 1024;
/** Pending text beyond this is dropped (oldest first) and counted. */
export const LIVE_LOG_MAX_PENDING_BYTES = 256 * 1024;

const RESULT_TEXT_MAX = 600;
const ARGS_MAX = 240;

/** Secret values shorter than this are not masked literally (too many false hits). */
const MIN_SECRET_LEN = 8;

/**
 * Masks the literal `secrets` (Claude token, GitHub tokens of this run, agent credential...),
 * then the shared token patterns. Secrets are read on every call, so new ones apply at once.
 */
export function makeRedactor(secrets: () => Iterable<string | null | undefined>) {
  return (text: string): string => {
    let out = text;
    for (const s of secrets()) {
      if (typeof s === 'string' && s.length >= MIN_SECRET_LEN && out.includes(s)) {
        out = out.split(s).join('[REDACTED]');
      }
    }
    return redactSecrets(out);
  };
}

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/** Sanitizes a raw string BEFORE it is shortened (see `entriesFromStreamLine`). */
type Clean = (s: string) => string;
const keep: Clean = (s) => s;

/** The one argument that says what a tool call does (command, path, pattern...), shortened. */
export function toolArgs(name: string, input: unknown, clean: Clean = keep): string {
  if (!input || typeof input !== 'object') return '';
  const i = input as Record<string, unknown>;
  if ((name === 'Grep' || name === 'Glob') && typeof i.pattern === 'string') {
    const where = typeof i.path === 'string' ? ` in ${i.path}` : '';
    return clip(oneLine(clean(i.pattern + where)), ARGS_MAX);
  }
  const pick =
    str(i.command) ??
    str(i.file_path) ??
    str(i.notebook_path) ??
    str(i.path) ??
    str(i.pattern) ??
    str(i.url) ??
    str(i.query) ??
    str(i.description) ??
    str(i.prompt);
  if (pick !== undefined) return clip(oneLine(clean(pick)), ARGS_MAX);
  if (name === 'TodoWrite' && Array.isArray(i.todos)) return `${i.todos.length} todos`;
  let json: string;
  try {
    json = JSON.stringify(input);
  } catch {
    return '';
  }
  return clip(json === '{}' ? '' : clean(json), ARGS_MAX);
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((c) =>
      c && typeof c === 'object' && (c as { type?: unknown }).type === 'text'
        ? (str((c as { text?: unknown }).text) ?? '')
        : '',
    )
    .filter(Boolean)
    .join('\n');
}

/**
 * Compact entries for one stream-json line. Lines that are not JSON are shown as plain text;
 * usage-only and unknown events give nothing.
 *
 * `clean` (the streamer passes its redactor) runs on every raw string BEFORE it is clipped:
 * clipping first could cut a token in the middle, and a partial token no longer matches the
 * literal secret nor the token patterns (`ghp_` + fewer than 20 chars), so its start would leak.
 */
export function entriesFromStreamLine(
  line: string,
  ts: number,
  clean: Clean = keep,
): Array<Omit<TaskLogEntry, 'ts'> & { ts: number }> {
  let ev: unknown;
  try {
    ev = JSON.parse(line);
  } catch {
    return line.trim() ? [{ ts, kind: 'text', text: line }] : [];
  }
  if (!ev || typeof ev !== 'object') return [];
  const e = ev as Record<string, unknown>;
  const out: TaskLogEntry[] = [];
  if (e.type === 'system' && e.subtype === 'init') {
    const model = str(e.model) && clean(str(e.model) as string);
    out.push({ ts, kind: 'system', text: `session started${model ? ` (${model})` : ''}` });
  } else if (e.type === 'assistant' || e.type === 'user') {
    const msg =
      e.message && typeof e.message === 'object' ? (e.message as Record<string, unknown>) : {};
    const content = Array.isArray(msg.content) ? (msg.content as unknown[]) : [];
    for (const c of content) {
      if (!c || typeof c !== 'object') continue;
      const b = c as Record<string, unknown>;
      if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
        out.push({ ts, kind: 'text', text: clean(b.text).trim() });
      } else if (b.type === 'tool_use') {
        const name = str(b.name) ?? 'tool';
        out.push({
          ts,
          kind: 'tool',
          tool: clip(clean(name), 80),
          text: toolArgs(name, b.input, clean),
        });
      } else if (b.type === 'tool_result') {
        const text = clip(clean(resultText(b.content)).trim(), RESULT_TEXT_MAX);
        out.push({
          ts,
          kind: 'tool_result',
          text,
          ...(b.is_error === true ? { error: true } : {}),
        });
      }
    }
  } else if (e.type === 'result') {
    const isError =
      e.is_error === true || (typeof e.subtype === 'string' && e.subtype !== 'success');
    const turns = typeof e.num_turns === 'number' ? `, ${e.num_turns} turns` : '';
    const head = `${str(e.subtype) ?? 'done'}${turns}`;
    const raw = str(e.result);
    const body = raw === undefined ? undefined : clean(raw).trim();
    out.push({
      ts,
      kind: 'result',
      text: clip(body ? `${head}: ${body}` : head, RESULT_TEXT_MAX * 2),
      ...(isError ? { error: true } : {}),
    });
  }
  return out;
}

export interface LiveLogOptions {
  assignmentId: string;
  /** Sends one batch right now; false when it could not (offline, back-pressure). */
  send: (payload: TaskLogPayload) => boolean;
  redact: (text: string) => string;
  now?: () => number;
  flushMs?: number;
  batchBytes?: number;
  maxPendingBytes?: number;
  onError?: (err: unknown) => void;
}

/** One per auto run. `stdout`/`stderr` take raw lines; `close()` flushes and stops. */
export class LiveLogStreamer {
  private pending: TaskLogEntry[] = [];
  private pendingBytes = 0;
  private dropped = 0;
  private chunk = 0;
  private timer: NodeJS.Timeout | undefined;
  private closed = false;
  private readonly flushMs: number;
  private readonly batchBytes: number;
  private readonly maxPending: number;

  constructor(private readonly o: LiveLogOptions) {
    this.flushMs = o.flushMs ?? LIVE_LOG_FLUSH_MS;
    this.batchBytes = o.batchBytes ?? LIVE_LOG_BATCH_BYTES;
    this.maxPending = o.maxPendingBytes ?? LIVE_LOG_MAX_PENDING_BYTES;
  }

  private now(): number {
    return this.o.now?.() ?? Date.now();
  }

  stdout(line: string): void {
    this.guard(() => {
      const clean = (s: string) => this.o.redact(stripAnsi(s));
      for (const e of entriesFromStreamLine(line, this.now(), clean)) this.push(e);
    });
  }

  stderr(line: string): void {
    this.guard(() => {
      if (line.trim()) this.push({ ts: this.now(), kind: 'stderr', text: line });
    });
  }

  /** Adds an agent-side note (timeout, cancel...). */
  note(text: string): void {
    this.guard(() => this.push({ ts: this.now(), kind: 'system', text }));
  }

  /** Flushes what is pending (unless `drop`) and stops; later lines are ignored. */
  close(opts: { drop?: boolean } = {}): void {
    if (this.closed) return;
    this.guard(() => {
      if (!opts.drop) this.flush();
    });
    this.closed = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.pending = [];
    this.pendingBytes = 0;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  private guard(fn: () => void): void {
    if (this.closed) return;
    try {
      fn();
    } catch (err) {
      this.o.onError?.(err);
    }
  }

  private push(raw: TaskLogEntry): void {
    const text = clip(this.o.redact(stripAnsi(raw.text)), TASK_LOG_TEXT_MAX);
    const entry: TaskLogEntry = {
      ...raw,
      text,
      ...(raw.tool !== undefined ? { tool: clip(this.o.redact(stripAnsi(raw.tool)), 80) } : {}),
    };
    const size = entry.text.length + (entry.tool?.length ?? 0) + 32;
    this.pending.push(entry);
    this.pendingBytes += size;
    while (this.pendingBytes > this.maxPending && this.pending.length > 1) {
      const old = this.pending.shift() as TaskLogEntry;
      this.pendingBytes -= old.text.length + (old.tool?.length ?? 0) + 32;
      this.dropped++;
    }
    if (this.pendingBytes >= this.batchBytes || this.pending.length >= TASK_LOG_MAX_ENTRIES) {
      this.flush();
    } else if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        this.guard(() => this.flush());
      }, this.flushMs);
      this.timer.unref?.();
    }
  }

  private flush(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    while (this.pending.length > 0) {
      let bytes = 0;
      let n = 0;
      while (n < this.pending.length && n < TASK_LOG_MAX_ENTRIES) {
        const e = this.pending[n] as TaskLogEntry;
        const size = e.text.length + (e.tool?.length ?? 0) + 32;
        if (n > 0 && bytes + size > this.batchBytes) break;
        bytes += size;
        n++;
      }
      const entries = this.pending.splice(0, n);
      this.pendingBytes = Math.max(0, this.pendingBytes - bytes);
      const payload: TaskLogPayload = {
        assignmentId: this.o.assignmentId,
        chunk: ++this.chunk,
        entries,
        ...(this.dropped > 0 ? { dropped: this.dropped } : {}),
      };
      let sent = false;
      try {
        sent = this.o.send(payload);
      } catch (err) {
        this.o.onError?.(err);
      }
      if (sent) this.dropped = 0;
      else this.dropped += entries.length;
    }
  }
}
