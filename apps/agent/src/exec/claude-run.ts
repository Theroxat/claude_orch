/**
 * Auto mode (PLAN 5.6): headless `claude -p` inside the task container through `docker exec`.
 *
 * The prompt goes through stdin (never argv, never the clone). Output is stream-json: every line
 * is appended (redacted) to the run log, and the final `result` event gives the outcome and the
 * per-task usage. Bypassed permissions are acceptable only because of the sandbox (PLAN 5.3).
 */
import { spawn } from 'node:child_process';
import type { TaskSize } from '@orch/shared';
import { childEnv } from './runner';

/** `--max-turns` by task size. */
export const MAX_TURNS: Record<TaskSize, number> = { S: 100, M: 200, L: 300 };

/** Hard timeout by size when the offer carries none (PLAN 10: 30/90/180 min). */
export const DEFAULT_TIMEOUT_SEC: Record<TaskSize, number> = { S: 1800, M: 5400, L: 10800 };

export interface AutoArgvSpec {
  container: string;
  workspaceFolder: string;
  /** Path of the claude binary inside the container (copied in at the same path). */
  claudeBin: string;
  /** Claude CLI model alias (sonnet, opus). */
  model: string;
  size: TaskSize;
}

/** `docker exec -i -w <ws> <container> <claude> -p ...`. No host path, no secret. */
export function buildAutoArgv(s: AutoArgvSpec): string[] {
  return [
    'docker',
    'exec',
    '-i',
    '-w',
    s.workspaceFolder,
    s.container,
    s.claudeBin,
    '-p',
    '--model',
    s.model,
    '--output-format',
    'stream-json',
    '--verbose',
    '--permission-mode',
    'bypassPermissions',
    '--max-turns',
    String(MAX_TURNS[s.size]),
  ];
}

export interface ClaudeResult {
  isError: boolean;
  subtype: string;
  text: string;
  numTurns: number | null;
  usage: { input: number; output: number; cacheWrite: number; cacheRead: number };
  /** Per-model totals (`modelUsage`), when the CLI reports them. */
  byModel: Array<{
    model: string;
    input: number;
    output: number;
    cacheWrite: number;
    cacheRead: number;
  }>;
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

/** Parses one stream-json line; returns the `result` event, or null for anything else. */
export function parseResultEvent(line: string): ClaudeResult | null {
  let ev: unknown;
  try {
    ev = JSON.parse(line);
  } catch {
    return null;
  }
  if (!ev || typeof ev !== 'object') return null;
  const e = ev as Record<string, unknown>;
  if (e.type !== 'result') return null;
  const u = (e.usage && typeof e.usage === 'object' ? e.usage : {}) as Record<string, unknown>;
  const byModel: ClaudeResult['byModel'] = [];
  if (e.modelUsage && typeof e.modelUsage === 'object') {
    for (const [model, v] of Object.entries(e.modelUsage as Record<string, unknown>)) {
      if (!v || typeof v !== 'object') continue;
      const m = v as Record<string, unknown>;
      byModel.push({
        model,
        input: Math.round(num(m.inputTokens)),
        output: Math.round(num(m.outputTokens)),
        cacheWrite: Math.round(num(m.cacheCreationInputTokens)),
        cacheRead: Math.round(num(m.cacheReadInputTokens)),
      });
    }
  }
  return {
    isError: e.is_error === true || (typeof e.subtype === 'string' && e.subtype !== 'success'),
    subtype: typeof e.subtype === 'string' ? e.subtype : 'unknown',
    text: typeof e.result === 'string' ? e.result : '',
    numTurns: typeof e.num_turns === 'number' ? e.num_turns : null,
    usage: {
      input: Math.round(num(u.input_tokens)),
      output: Math.round(num(u.output_tokens)),
      cacheWrite: Math.round(num(u.cache_creation_input_tokens)),
      cacheRead: Math.round(num(u.cache_read_input_tokens)),
    },
    byModel,
  };
}

export interface StreamedUsage {
  /** `message.id`: Claude repeats an assistant message once per content block. */
  id: string;
  model: string;
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

/** Usage of one stream-json `assistant` event, or null for anything else. */
export function parseAssistantUsage(line: string): StreamedUsage | null {
  let ev: unknown;
  try {
    ev = JSON.parse(line);
  } catch {
    return null;
  }
  if (!ev || typeof ev !== 'object') return null;
  const e = ev as Record<string, unknown>;
  if (e.type !== 'assistant' || !e.message || typeof e.message !== 'object') return null;
  const m = e.message as Record<string, unknown>;
  if (typeof m.id !== 'string' || !m.usage || typeof m.usage !== 'object') return null;
  const model = typeof m.model === 'string' ? m.model : 'unknown';
  if (model === '<synthetic>') return null;
  const u = m.usage as Record<string, unknown>;
  return {
    id: m.id,
    model,
    input: Math.round(num(u.input_tokens)),
    output: Math.round(num(u.output_tokens)),
    cacheWrite: Math.round(num(u.cache_creation_input_tokens)),
    cacheRead: Math.round(num(u.cache_read_input_tokens)),
  };
}

const RATE_LIMIT_RE = /usage limit|rate.?limit|limit reached|\b429\b/i;
export const isRateLimited = (text: string): boolean => RATE_LIMIT_RE.test(text);

export interface RunningProcess {
  /** Resolves with the exit code (128 + n when killed by a signal). */
  readonly exit: Promise<number>;
  kill(): void;
}

export interface ProcessOps {
  /** Starts argv (no shell), writes `input` to stdin, reports output line by line. */
  spawnLines(
    argv: string[],
    input: string,
    onStdout: (line: string) => void,
    onStderr: (line: string) => void,
  ): RunningProcess;
}

function lineSplitter(cb: (line: string) => void) {
  let buf = '';
  return {
    push(chunk: string) {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.trim() !== '') cb(line);
      }
      // A runaway line without newline: flush it in pieces.
      if (buf.length > 4 * 1024 * 1024) {
        cb(buf);
        buf = '';
      }
    },
    end() {
      if (buf.trim() !== '') cb(buf);
      buf = '';
    },
  };
}

export const spawnProcessOps: ProcessOps = {
  spawnLines(argv, input, onStdout, onStderr) {
    const [cmd = '', ...args] = argv;
    const child = spawn(cmd, args, { env: childEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
    const out = lineSplitter(onStdout);
    const err = lineSplitter(onStderr);
    child.stdout.setEncoding('utf8').on('data', (c: string) => out.push(c));
    child.stderr.setEncoding('utf8').on('data', (c: string) => err.push(c));
    const exit = new Promise<number>((resolve) => {
      child.on('error', (e) => {
        onStderr(`spawn failed: ${e.message}`);
        resolve(127);
      });
      child.on('close', (code, signal) => {
        out.end();
        err.end();
        resolve(code ?? (signal ? 137 : 1));
      });
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(input);
    return {
      exit,
      kill: () => {
        child.kill('SIGKILL');
      },
    };
  },
};
