/**
 * `orch login` (PLAN 5.4): runs `claude setup-token` so the member creates a long-lived OAuth
 * token for their own subscription, then stores the pasted token in
 * `${ORCH_SECRETS_DIR}/claude-token` (0600, atomic). The token is never printed or logged.
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

export interface LoginOptions {
  secretsDir: string;
  claudeBin: string;
  /** Read the token from stdin (non-interactive) instead of prompting. */
  tokenFromStdin: boolean;
  /** Skip running `claude setup-token` (token already generated elsewhere). */
  skipSetup: boolean;
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

function runSetupToken(bin: string, interactive: boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    // In --token-stdin mode stdin carries the token, so the child must not read it.
    const child = spawn(bin, ['setup-token'], {
      stdio: [interactive ? 'inherit' : 'ignore', 'inherit', 'inherit'],
    });
    child.on('error', (err: NodeJS.ErrnoException) =>
      reject(
        new LoginError(
          err.code === 'ENOENT'
            ? `Claude Code CLI not found (${bin}). Set ORCH_CLAUDE_BIN or install Claude Code.`
            : `Could not run ${bin} setup-token: ${err.message}`,
        ),
      ),
    );
    child.on('exit', (code, signal) =>
      code === 0
        ? resolve()
        : reject(new LoginError(`claude setup-token failed (${signal ?? `exit ${code}`}).`)),
    );
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
  if (!opts.skipSetup) {
    io.stderr.write(
      'Running `claude setup-token`. Follow the steps to create a long-lived token.\n',
    );
    await runSetupToken(opts.claudeBin, !opts.tokenFromStdin);
  }
  const raw = opts.tokenFromStdin
    ? await readAll(io.stdin)
    : await promptHidden(io, 'Paste the token shown above (input hidden): ');
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
