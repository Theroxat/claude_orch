/**
 * `orch login` (PLAN 5.4): runs `claude setup-token` so the member creates a long-lived OAuth
 * token for their own subscription, then captures the token it prints (read from a pty; failing that, asked as a hidden paste) and
 * stores it in `${ORCH_SECRETS_DIR}/claude-token` (0600, atomic). orch itself never prints or
 * logs the token (only `claude setup-token` shows it, on the member's own terminal).
 */
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { writeFileAtomic } from '../fsutil';

export interface LoginIo {
  stdin: Readable & { isTTY?: boolean; setRawMode?: (raw: boolean) => unknown };
  stdout: Writable;
  stderr: Writable;
}

/** Runs `claude setup-token`; returns its raw output, or null when it could not be captured. */
export type SetupRunner = (bin: string, io: LoginIo) => Promise<string | null>;

export interface LoginOptions {
  secretsDir: string;
  claudeBin: string;
  /** Read the token from stdin (non-interactive) instead of prompting. */
  tokenFromStdin: boolean;
  /** Skip running `claude setup-token` (token already generated elsewhere). */
  skipSetup: boolean;
  /** Test hook: replaces the real `claude setup-token` run. */
  setupRunner?: SetupRunner;
}

export class LoginError extends Error {
  override name = 'LoginError';
}

export const TOKEN_FILE = 'claude-token';

export function validateToken(raw: string): string {
  const token = raw.trim();
  if (token === '') throw new LoginError('No token given.');
  if (/\s/.test(token)) throw new LoginError('The token must not contain whitespace.');
  if (token.length < 20) throw new LoginError('The token looks too short.');
  return token;
}

const missingCli = (bin: string, err: NodeJS.ErrnoException) =>
  new LoginError(
    err.code === 'ENOENT'
      ? `Claude Code CLI not found (${bin}). Set ORCH_CLAUDE_BIN or install Claude Code.`
      : `Could not run ${bin} setup-token: ${err.message}`,
  );

const exitError = (code: number | null, signal: NodeJS.Signals | null) =>
  new LoginError(`claude setup-token failed (${signal ?? `exit ${code}`}).`);

/** Runs `claude setup-token` with the terminal inherited; nothing is captured. */
function runSetupToken(bin: string, interactive: boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    // In --token-stdin mode stdin carries the token, so the child must not read it.
    const child = spawn(bin, ['setup-token'], {
      stdio: [interactive ? 'inherit' : 'ignore', 'inherit', 'inherit'],
    });
    child.on('error', (err: NodeJS.ErrnoException) => reject(missingCli(bin, err)));
    child.on('exit', (code, signal) => (code === 0 ? resolve() : reject(exitError(code, signal))));
  });
}

// eslint-disable-next-line no-control-regex -- matching terminal escape sequences is the point
const ANSI = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[@-Z\\-_])/g;
const TOKEN_START = /sk-ant-[A-Za-z0-9_-]*/;
const TOKEN_CHARS = /^[A-Za-z0-9_-]+$/;

/**
 * Finds the OAuth token printed by `claude setup-token` in its raw terminal output (ANSI codes,
 * CRLF, and a token wrapped over several lines are handled). Returns null when none is found.
 */
export function extractToken(output: string): string | null {
  const lines = output.replace(ANSI, '').replace(/\r/g, '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = TOKEN_START.exec(lines[i] ?? '');
    if (!m) continue;
    let token = m[0];
    // A token that ends its line may continue on the next ones (terminal wrapping).
    if ((lines[i] ?? '').trimEnd().endsWith(token)) {
      for (let j = i + 1; j < lines.length; j++) {
        const next = (lines[j] ?? '').trim();
        if (!TOKEN_CHARS.test(next)) break;
        token += next;
      }
    }
    return token.length >= 20 ? token : null;
  }
  return null;
}

/** Quote for /bin/sh. */
const shq = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;

/**
 * Runs `claude setup-token` inside a pty (util-linux `script`) so its interactive UI works, shows
 * everything to the member and captures the output to find the token. Resolves with the captured
 * output, or null when `script` is unavailable (the caller then runs without capture).
 */
function runSetupTokenCaptured(bin: string, io: LoginIo): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const out = io.stdout as Writable & { columns?: number; rows?: number };
    const size = out.columns && out.rows ? `stty cols ${out.columns} rows ${out.rows}; ` : '';
    const child = spawn(
      'script',
      ['-q', '-e', '-c', `${size}exec ${shq(bin)} setup-token`, '/dev/null'],
      { stdio: [io.stdin.isTTY === true ? 'inherit' : 'ignore', 'pipe', 'inherit'] },
    );
    let captured = '';
    child.stdout.on('data', (chunk: Buffer) => {
      captured = (captured + chunk.toString('utf8')).slice(-65_536);
      io.stdout.write(chunk);
    });
    child.on('error', (err: NodeJS.ErrnoException) =>
      err.code === 'ENOENT' ? resolve(null) : reject(missingCli(bin, err)),
    );
    child.on('exit', (code, signal) => {
      // `script -e` returns the child's exit code; 127 means the shell could not find the binary.
      if (code === 127)
        return reject(missingCli(bin, Object.assign(new Error(), { code: 'ENOENT' })));
      return code === 0 ? resolve(captured) : reject(exitError(code, signal));
    });
  });
}

function readAll(stdin: Readable): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    stdin.setEncoding('utf8');
    stdin.on('data', (c: string) => {
      data += c;
      if (data.length > 16_384) reject(new LoginError('Input too long.'));
    });
    stdin.on('end', () => resolve(data));
    stdin.on('error', reject);
  });
}

/** Reads one line without echoing it when stdin is a TTY. */
function promptHidden(io: LoginIo, question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    io.stderr.write(question);
    const tty = io.stdin.isTTY === true && typeof io.stdin.setRawMode === 'function';
    if (tty) io.stdin.setRawMode?.(true);
    io.stdin.setEncoding('utf8');
    let line = '';
    const finish = (err?: Error) => {
      io.stdin.off('data', onData);
      io.stdin.off('end', onEnd);
      if (tty) io.stdin.setRawMode?.(false);
      io.stdin.pause();
      io.stderr.write('\n');
      if (err) reject(err);
      else resolve(line);
    };
    const onEnd = () => finish();
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\u0003') return finish(new LoginError('Cancelled.'));
        if (ch === '\r' || ch === '\n') return finish();
        if (ch === '\u007f' || ch === '\b') line = line.slice(0, -1);
        else line += ch;
      }
    };
    io.stdin.on('data', onData);
    io.stdin.on('end', onEnd);
    io.stdin.resume();
  });
}

export async function login(opts: LoginOptions, io: LoginIo): Promise<string> {
  let raw: string | null = null;
  if (opts.tokenFromStdin) {
    if (!opts.skipSetup) {
      io.stderr.write('Running `claude setup-token`. Follow the steps to create a token.\n');
      await runSetupToken(opts.claudeBin, false);
    }
    raw = await readAll(io.stdin);
  } else {
    if (!opts.skipSetup) {
      io.stderr.write(
        'Running `claude setup-token`. Open the URL, sign in and paste the code back here.\n',
      );
      const output = opts.setupRunner
        ? await opts.setupRunner(opts.claudeBin, io)
        : ((await runSetupTokenCaptured(opts.claudeBin, io)) ??
          (await runSetupToken(opts.claudeBin, true).then(() => null)));
      const found = output === null ? null : extractToken(output);
      if (found) raw = found;
      else
        io.stderr.write(
          output === null ? '' : 'Could not read the token automatically; paste it below.\n',
        );
    }
    raw ??= await promptHidden(io, 'Paste the token shown above (input hidden): ');
  }
  const token = validateToken(raw);
  if (!token.startsWith('sk-ant-')) {
    io.stderr.write(
      'Warning: the token does not look like a Claude OAuth token (sk-ant-oat01-...).\n',
    );
  }
  const path = join(opts.secretsDir, TOKEN_FILE);
  writeFileAtomic(path, `${token}\n`, 0o600);
  return path;
}
