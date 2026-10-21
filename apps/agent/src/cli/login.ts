/**
 * `orch login` (PLAN 5.4): runs `claude setup-token` so the member creates a long-lived OAuth
 * token for their own subscription, then captures the token it prints (read from a pty and
 * replayed into a terminal emulator; failing that, asked as a hidden paste), checks its shape and
 * stores it in `${ORCH_SECRETS_DIR}/claude-token` (0600, atomic). orch itself never prints or
 * logs the token (only `claude setup-token` shows it, on the member's own terminal).
 */
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { writeFileAtomic } from '../fsutil';
import {
  ANSI,
  checkTokenShape,
  extractToken,
  extractTokenFromTerminal,
  TOKEN_SHAPE,
  type ResizeEvent,
} from './token-capture';

export {
  checkTokenShape,
  extractToken,
  extractTokenFromTerminal,
  TOKEN_SHAPE,
} from './token-capture';

export interface LoginIo {
  stdin: Readable & { isTTY?: boolean; setRawMode?: (raw: boolean) => unknown };
  stdout: Writable;
  stderr: Writable;
}

/** Raw pty output of `claude setup-token` and the terminal size it was rendered for. */
export interface SetupCapture {
  output: string;
  cols: number;
  rows: number;
  /** Terminal size changes during the run (offsets into `output`). */
  resizes?: ResizeEvent[];
}

/**
 * Runs `claude setup-token`; returns its captured output (a bare string is taken as rendered
 * at 80x24), or null when it could not be captured.
 */
export type SetupRunner = (bin: string, io: LoginIo) => Promise<SetupCapture | string | null>;

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
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const MAX_PASTE_TRIES = 3;

/** Validates the token shape; throws a LoginError with the reason (never the token). */
export function validateToken(raw: string): string {
  const res = checkTokenShape(raw);
  if (!res.ok) throw new LoginError(`That does not look like a Claude OAuth token: ${res.reason}.`);
  return res.token;
}

/**
 * Normalizes a token read from stdin: CR removed, trimmed, and a token split over several lines
 * (only token characters on each line) joined back.
 */
export function normalizeStdinToken(raw: string): string {
  const text = raw.replace(ANSI, '').replace(/\r/g, '').trim();
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '');
  return lines.length > 1 && lines.every((l) => /^[A-Za-z0-9_-]+$/.test(l)) ? lines.join('') : text;
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

/** Quote for /bin/sh. */
const shq = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;

type SizedStream = Writable & { columns?: number; rows?: number };
const ttySize = (out: SizedStream) => ({
  cols: out.columns && out.columns > 0 ? out.columns : DEFAULT_COLS,
  rows: out.rows && out.rows > 0 ? out.rows : DEFAULT_ROWS,
});

/**
 * Runs `claude setup-token` inside a pty (util-linux `script`) so its interactive UI works, shows
 * everything to the member and captures the output to find the token. The pty gets an explicit
 * size (the member's terminal, else 80x24) so the output can be replayed into an emulator of the
 * same size; when the member's terminal is resized, `script` resizes the pty to match and the
 * change is recorded for the replay. Resolves with null when `script` is unavailable (the caller
 * then runs without capture).
 */
function runSetupTokenCaptured(bin: string, io: LoginIo): Promise<SetupCapture | null> {
  return new Promise((resolve, reject) => {
    const out = io.stdout as SizedStream;
    const { cols, rows } = ttySize(out);
    const child = spawn(
      'script',
      [
        '-q',
        '-e',
        '-c',
        `stty cols ${cols} rows ${rows}; exec ${shq(bin)} setup-token`,
        '/dev/null',
      ],
      { stdio: [io.stdin.isTTY === true ? 'inherit' : 'ignore', 'pipe', 'inherit'] },
    );
    const decoder = new StringDecoder('utf8');
    const resizes: ResizeEvent[] = [];
    let captured = '';
    const onResize = () => resizes.push({ at: captured.length, ...ttySize(out) });
    out.on('resize', onResize);
    child.stdout.on('data', (chunk: Buffer) => {
      // The UI output is small; the cap only guards against a runaway child.
      if (captured.length < 4_000_000) captured += decoder.write(chunk);
      io.stdout.write(chunk);
    });
    child.on('error', (err: NodeJS.ErrnoException) => {
      out.off('resize', onResize);
      return err.code === 'ENOENT' ? resolve(null) : reject(missingCli(bin, err));
    });
    child.on('exit', (code, signal) => {
      out.off('resize', onResize);
      // `script -e` returns the child's exit code; 127 means the shell could not find the binary.
      if (code === 127)
        return reject(missingCli(bin, Object.assign(new Error(), { code: 'ENOENT' })));
      if (code !== 0) return reject(exitError(code, signal));
      return resolve({ output: captured + decoder.end(), cols, rows, resizes });
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

// Bracketed-paste markers, which the generic ANSI pattern does not cover.
// eslint-disable-next-line no-control-regex -- matching terminal escape sequences is the point
const PASTE_MARKERS = /\u001b\[20[01]~/g;

/** How long a trailing CR/LF waits for more pasted input before it counts as Enter. */
export const PASTE_SETTLE_MS = 80;

/**
 * Reads one answer without echoing it when stdin is a TTY. A token copied from a terminal where
 * it was wrapped arrives as "part1\npart2": a CR/LF followed by more characters in the same chunk
 * is a wrap (ignored). A trailing CR/LF finishes at once when the text already has the token
 * shape; otherwise it waits PASTE_SETTLE_MS for more input (the paste may be split across chunks
 * right after the newline) and finishes only if nothing else arrives. Whitespace, ANSI codes and
 * bracketed-paste markers are removed from the result.
 */
export function promptHidden(io: LoginIo, question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    io.stderr.write(question);
    if (io.stdin.readableEnded) {
      io.stderr.write('\n');
      return resolve('');
    }
    const tty = io.stdin.isTTY === true && typeof io.stdin.setRawMode === 'function';
    if (tty) io.stdin.setRawMode?.(true);
    io.stdin.setEncoding('utf8');
    let line = '';
    let settle: NodeJS.Timeout | undefined;
    const clean = () => line.replace(ANSI, '').replace(/\s+/g, '');
    const finish = (err?: Error) => {
      clearTimeout(settle);
      settle = undefined;
      io.stdin.off('data', onData);
      io.stdin.off('end', onEnd);
      if (tty) io.stdin.setRawMode?.(false);
      io.stdin.pause();
      io.stderr.write('\n');
      if (err) reject(err);
      else resolve(clean());
    };
    const onEnd = () => finish();
    const onData = (raw: string) => {
      // More input after a trailing newline: that newline was a wrap inside the paste.
      clearTimeout(settle);
      settle = undefined;
      const chunk = raw.replace(PASTE_MARKERS, '');
      const chars = [...chunk];
      for (let i = 0; i < chars.length; i++) {
        const ch = chars[i] ?? '';
        if (ch === '\u0003') return finish(new LoginError('Cancelled.'));
        if (ch === '\r' || ch === '\n') {
          if (chars.slice(i + 1).every((c) => c === '\r' || c === '\n')) {
            if (TOKEN_SHAPE.test(clean())) return finish();
            settle = setTimeout(() => finish(), PASTE_SETTLE_MS);
            return;
          }
          continue; // a wrapped line inside a paste
        }
        if (ch === '\u007f' || ch === '\b') line = line.slice(0, -1);
        else line += ch;
      }
    };
    io.stdin.on('data', onData);
    io.stdin.on('end', onEnd);
    io.stdin.resume();
  });
}

/** Asks for the token (input hidden), re-asking with the reason when its shape is wrong. */
async function askToken(io: LoginIo): Promise<string> {
  let reason = 'no token given';
  for (let i = 0; i < MAX_PASTE_TRIES; i++) {
    const res = checkTokenShape(await promptHidden(io, 'Paste the token (input hidden): '));
    if (res.ok) return res.token;
    reason = res.reason;
    if (io.stdin.readableEnded) break;
    io.stderr.write(`That does not look like a Claude OAuth token: ${reason}. Try again.\n`);
  }
  throw new LoginError(`No valid token given (${reason}).`);
}

// CSI cursor-movement sequences (CUP/HVP, CUU/CUD/CUF/CUB, CNL/CPL, CHA, VPA).
// eslint-disable-next-line no-control-regex -- matching terminal escape sequences is the point
export const CURSOR_MOVE = /\u001b\[[0-9;?]*[HfABCDEFGd]/;

/**
 * Finds the token in a captured run: terminal emulation first, plain-text parsing as fallback
 * (only for output without cursor movement).
 */
async function tokenFromCapture(capture: SetupCapture | string): Promise<string | null> {
  const c =
    typeof capture === 'string'
      ? { output: capture, cols: DEFAULT_COLS, rows: DEFAULT_ROWS }
      : capture;
  const emulated = await extractTokenFromTerminal(c.output, c.cols, c.rows, c.resizes);
  if (emulated !== null && checkTokenShape(emulated).ok) return emulated;
  // Stripping ANSI codes from output that moves the cursor silently drops characters (the
  // original bug): the plain-text parser is only trusted on output without cursor movement.
  if (CURSOR_MOVE.test(c.output)) return emulated;
  const plain = extractToken(c.output);
  if (plain !== null && checkTokenShape(plain).ok) return plain;
  return emulated ?? plain;
}

export async function login(opts: LoginOptions, io: LoginIo): Promise<string> {
  let token: string;
  if (opts.tokenFromStdin) {
    if (!opts.skipSetup) {
      io.stderr.write('Running `claude setup-token`. Follow the steps to create a token.\n');
      await runSetupToken(opts.claudeBin, false);
    }
    token = validateToken(normalizeStdinToken(await readAll(io.stdin)));
  } else {
    let found: string | null = null;
    if (!opts.skipSetup) {
      io.stderr.write(
        'Running `claude setup-token`. Open the URL, sign in and paste the code back here.\n',
      );
      const capture = opts.setupRunner
        ? await opts.setupRunner(opts.claudeBin, io)
        : ((await runSetupTokenCaptured(opts.claudeBin, io)) ??
          (await runSetupToken(opts.claudeBin, true).then(() => null)));
      if (capture !== null) {
        const candidate = await tokenFromCapture(capture);
        const res = candidate === null ? null : checkTokenShape(candidate);
        if (res?.ok) found = res.token;
        else
          io.stderr.write(
            `Could not read the token reliably (${res ? res.reason : 'not found in the output'}); paste it below (input hidden).\n`,
          );
      }
    }
    token = found ?? (await askToken(io));
  }
  const path = join(opts.secretsDir, TOKEN_FILE);
  writeFileAtomic(path, `${token}\n`, 0o600);
  return path;
}
