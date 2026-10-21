/**
 * Child process runner used by the real git, docker and screen adapters. Arguments are always
 * passed as argv (never through a shell). Children get a sanitized environment: the agent's own
 * ORCH_* settings (including its credential) and any Claude token are stripped, and only the
 * variables passed explicitly for that one call are added.
 */
import { spawn } from 'node:child_process';
import { redact } from '../log';

export interface RunOptions {
  cwd?: string;
  /** Extra environment for this one child only (kept in memory, never persisted). */
  env?: Record<string, string>;
  input?: string;
  timeoutMs?: number;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface CommandRunner {
  run(cmd: string, args: readonly string[], opts?: RunOptions): Promise<RunResult>;
}

export class CommandError extends Error {
  override name = 'CommandError';
  constructor(
    readonly cmd: string,
    readonly code: number,
    readonly stderr: string,
  ) {
    super(
      redact(
        `${cmd} failed (exit ${code})${stderr.trim() ? `: ${stderr.trim().slice(-800)}` : ''}`,
      ),
    );
  }
}

const STRIPPED = /^(ORCH_|CLAUDE_CODE_OAUTH_TOKEN$|GIT_ASKPASS$|GIT_CONFIG_)/;

/** process.env without agent secrets/settings, plus `extra`. */
export function childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!STRIPPED.test(k)) env[k] = v;
  return { ...env, ...extra };
}

export const spawnRunner: CommandRunner = {
  run(cmd, args, opts = {}) {
    return new Promise((resolve, reject) => {
      const child = spawn(cmd, args, {
        cwd: opts.cwd,
        env: childEnv(opts.env),
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      let timer: NodeJS.Timeout | undefined;
      if (opts.timeoutMs) timer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs);
      child.stdout.setEncoding('utf8').on('data', (c: string) => (stdout += c));
      child.stderr.setEncoding('utf8').on('data', (c: string) => {
        stderr += c;
        if (stderr.length > 64_000) stderr = stderr.slice(-32_000);
      });
      child.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        resolve({ code: code ?? (signal ? 128 : 1), stdout, stderr });
      });
      child.stdin.on('error', () => undefined);
      child.stdin.end(opts.input ?? '');
    });
  },
};

/** Runs and throws CommandError on a non-zero exit. */
export async function runOk(
  runner: CommandRunner,
  cmd: string,
  args: readonly string[],
  opts?: RunOptions,
): Promise<string> {
  const r = await runner.run(cmd, args, opts);
  if (r.code !== 0) throw new CommandError(`${cmd} ${args[0] ?? ''}`.trim(), r.code, r.stderr);
  return r.stdout;
}
