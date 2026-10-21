/**
 * REAL Claude login check (v0.5.2): runs one tiny `claude -p` request with the stored token in a
 * throwaway container built like a task container (same hardening, same env, binary copied in),
 * then classifies the outcome. The token is passed by NAME only (`-e CLAUDE_CODE_OAUTH_TOKEN`),
 * its value lives in the docker CLI child's environment; it never appears in argv, logs, files or
 * the result (`detail` is redacted and the token value is masked explicitly as well).
 */
import { randomBytes } from 'node:crypto';
import { accessSync, constants as fsConstants, readFileSync, statSync } from 'node:fs';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import type { ClaudeAuthErrorClass, ClaudeAuthPayload } from '@orch/shared';
import { hashClaudeToken } from './claude-auth';
import type { DockerOps } from './exec/docker';
import { AGENT_LABEL } from './exec/naming';
import type { CommandRunner } from './exec/runner';
import { CLAUDE_TOKEN_ENV, sandboxEnvArgs } from './exec/sandbox';
import { errorMessage, redact } from './log';

/** Label carried by every check container (cleanup finds leftovers with it). */
export const CHECK_LABEL = 'orch.check';
export const CHECK_LABEL_VALUE = 'claude-auth';
export const CHECK_TIMEOUT_MS = 90_000;
export const CHECK_PROMPT = 'reply with: ok';

export interface ClaudeCheckConfig {
  agentId: string;
  /** Image of the throwaway container (the default task image). */
  image: string;
  /** Absolute path of the Claude binary (copied in at the same path). */
  claudeBin: string;
  uid: number;
  gid: number;
  timeoutMs?: number;
}

export interface ClaudeCheckDeps {
  docker: Pick<DockerOps, 'create' | 'copyIn' | 'start' | 'remove' | 'pull'>;
  /** Runs `docker exec` with a timeout. */
  runner: CommandRunner;
  dockerBin?: string;
  /** Reads the token file (trimmed) at use time; null when missing or empty. */
  readClaudeToken: () => string | null;
  now?: () => Date;
}

export interface ClaudeCheckOutcome {
  payload: ClaudeAuthPayload;
  /** sha256 of the token the check ran with; null when there was none. */
  tokenHash: string | null;
}

export const CLAUDE_TOKEN_FILE = 'claude-token';

/** Reads `${secretsDir}/claude-token` at use time (trimmed; never cached, never logged). */
export function readTokenFile(secretsDir: string): string | null {
  try {
    const t = readFileSync(join(secretsDir, CLAUDE_TOKEN_FILE), 'utf8').trim();
    return t === '' ? null : t;
  } catch {
    return null;
  }
}

/** Cheap fingerprint (mtime + size) of the token file, null when missing. */
export function tokenFileStat(secretsDir: string): string | null {
  try {
    const st = statSync(join(secretsDir, CLAUDE_TOKEN_FILE));
    return `${st.mtimeMs}:${st.size}:${st.ino}`;
  } catch {
    return null;
  }
}

/** sha256 of the trimmed token file content, null when missing or empty. */
export function tokenFileHash(secretsDir: string): string | null {
  const t = readTokenFile(secretsDir);
  return t ? hashClaudeToken(t) : null;
}

/** Removes leftover check containers of this agent. */
export async function cleanupCheckContainers(
  docker: Pick<DockerOps, 'listLabeled' | 'remove'>,
  agentId: string,
): Promise<void> {
  const list = await docker.listLabeled('container', CHECK_LABEL, agentId);
  for (const c of list) await docker.remove(c.name).catch(() => undefined);
}

/**
 * Absolute path of an executable: `bin` itself when absolute, resolved against the cwd when it
 * holds a slash, else looked up on `pathEnv` like a shell does. Null when not found.
 */
export function resolveExecutable(
  bin: string,
  pathEnv: string = process.env.PATH ?? '',
): string | null {
  const isExec = (p: string) => {
    try {
      if (!statSync(p).isFile()) return false;
      accessSync(p, fsConstants.X_OK);
      return true;
    } catch {
      return false;
    }
  };
  if (isAbsolute(bin)) return isExec(bin) ? bin : null;
  if (bin.includes('/')) {
    const p = resolve(bin);
    return isExec(p) ? p : null;
  }
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir || !isAbsolute(dir)) continue;
    const p = join(dir, bin);
    if (isExec(p)) return p;
  }
  return null;
}

export const checkContainerName = () => `orch-claude-check-${randomBytes(6).toString('hex')}`;

/** `docker create` arguments of the check container (no mount, default bridge network). */
export function buildCheckCreateArgs(name: string, cfg: ClaudeCheckConfig): string[] {
  if (!Number.isInteger(cfg.uid) || cfg.uid <= 0 || !Number.isInteger(cfg.gid) || cfg.gid < 0) {
    throw new Error(`The check container must run as a non-root uid (got ${cfg.uid}:${cfg.gid})`);
  }
  if (cfg.image.startsWith('-') || name.startsWith('-')) throw new Error('Invalid image or name');
  return [
    '--name',
    name,
    '--user',
    `${cfg.uid}:${cfg.gid}`,
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--pids-limit',
    '512',
    '--memory',
    '1g',
    '--cpus',
    '1',
    '--tmpfs',
    '/tmp:rw,exec,nosuid,nodev,mode=1777,size=256m',
    '--workdir',
    '/tmp',
    '--init',
    '--label',
    `${AGENT_LABEL}=${cfg.agentId}`,
    '--label',
    `${CHECK_LABEL}=${CHECK_LABEL_VALUE}`,
    ...sandboxEnvArgs(),
    '--entrypoint',
    'sleep',
    cfg.image,
    'infinity',
  ];
}

/** argv run inside the container (constant prompt, so argv is fine). */
export const checkArgv = (claudeBin: string) => [
  claudeBin,
  '-p',
  CHECK_PROMPT,
  '--max-turns',
  '1',
  '--model',
  'haiku',
  '--output-format',
  'json',
];

export interface RawCheckResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}

const UNAUTHORIZED = [
  /OAuth access token is invalid/i,
  /Failed to authenticate/i,
  /Invalid API key/i,
  /invalid x-api-key/i,
  /OAuth token has expired/i,
  /\brevoked\b/i,
  /authentication_error/i,
  /(?:API Error|status(?: code)?|HTTP(?:\/[\d.]+)?)[:\s]*401\b/i,
  /Please run \/login/i,
];
// Only an answer from the Claude API itself proves the token was accepted (a generic "rate
// limit" / "limit reached" could come from anywhere, e.g. a registry).
const RATE_LIMITED = [
  /(?:API Error|status(?: code)?|HTTP(?:\/[\d.]+)?)[:\s]*429\b/i,
  /rate_limit_error/i,
  /usage limit/i,
];
const NETWORK = [
  /ENOTFOUND/,
  /ECONNREFUSED/,
  /ECONNRESET/,
  /EAI_AGAIN/,
  /ETIMEDOUT/,
  /getaddrinfo/i,
  /Connection error/i,
  /fetch failed/i,
  /network/i,
];

interface ResultJson {
  is_error?: boolean;
  subtype?: string;
  result?: string;
}

function parseResult(stdout: string): ResultJson | null {
  const text = stdout.trim();
  if (!text) return null;
  // `--output-format json` prints one object; tolerate noise before it.
  for (const candidate of [text, text.slice(text.lastIndexOf('\n{') + 1)]) {
    try {
      const v = JSON.parse(candidate) as unknown;
      if (v && typeof v === 'object' && !Array.isArray(v)) return v as ResultJson;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

/** Short, redacted tail for `detail` (<= 300 chars). */
export function checkDetail(text: string, token?: string | null): string | undefined {
  let t = text;
  if (token) t = t.split(token).join('[REDACTED]');
  t = redact(t).replace(/\s+/g, ' ').trim();
  if (!t) return undefined;
  return t.length > 300 ? `…${t.slice(-299)}` : t;
}

/** Docker failures that point at the registry or the network (pull, DNS, connection). */
const DOCKER_NETWORK = [
  ...NETWORK,
  /toomanyrequests/i,
  /pull rate limit/i,
  /no such host/i,
  /dial tcp/i,
  /i\/o timeout/i,
  /TLS handshake/i,
  /connection refused/i,
  /Temporary failure in name resolution/i,
  /Cannot connect to the Docker daemon/i,
];

/**
 * Classifies a failure of a docker step (create, pull, copy, start) that ran before Claude was
 * called: it says nothing about the token, so it is always inconclusive (valid: false).
 */
export function classifyDockerFailure(
  step: 'create' | 'pull' | 'copy' | 'start' | 'exec',
  message: string,
): { valid: false; errorClass: ClaudeAuthErrorClass; text: string } {
  const text = `docker ${step} failed: ${message}`;
  const network = step === 'pull' || DOCKER_NETWORK.some((re) => re.test(message));
  return { valid: false, errorClass: network ? 'network' : 'error', text };
}

/** Classifies the output of the `docker exec ... claude -p` step (and only that). */
export function classifyCheck(r: RawCheckResult): {
  valid: boolean;
  errorClass?: ClaudeAuthErrorClass;
  text: string;
} {
  const json = parseResult(r.stdout);
  const resultText = typeof json?.result === 'string' ? json.result : '';
  const text = [resultText || (json ? '' : r.stdout), r.stderr].filter((s) => s.trim()).join(' ');
  if (r.code === 0 && json && json.is_error !== true && json.subtype !== 'error') {
    return { valid: true, text };
  }
  if (r.timedOut) return { valid: false, errorClass: 'timeout', text: text || 'timed out' };
  const all = `${text} ${r.stdout}`;
  if (UNAUTHORIZED.some((re) => re.test(all))) {
    return { valid: false, errorClass: 'unauthorized', text };
  }
  // A rate limit means the token was accepted.
  if (RATE_LIMITED.some((re) => re.test(all))) {
    return { valid: true, errorClass: 'rate_limited', text };
  }
  if (NETWORK.some((re) => re.test(all))) return { valid: false, errorClass: 'network', text };
  return { valid: false, errorClass: 'error', text: text || `exit ${r.code}` };
}

/** Runs the check. Never throws: docker failures come back as `error` (or `network`), never valid. */
export async function checkClaudeAuth(
  cfg: ClaudeCheckConfig,
  deps: ClaudeCheckDeps,
): Promise<ClaudeCheckOutcome> {
  const now = deps.now ?? (() => new Date());
  const token = deps.readClaudeToken();
  if (!token) {
    return {
      payload: {
        valid: false,
        checkedAt: now().toISOString(),
        errorClass: 'no_token',
        detail: 'No Claude token. Run "orch login".',
      },
      tokenHash: null,
    };
  }
  const tokenHash = hashClaudeToken(token);
  const timeoutMs = cfg.timeoutMs ?? CHECK_TIMEOUT_MS;
  const name = checkContainerName();
  let c: ReturnType<typeof classifyCheck>;
  let step: Parameters<typeof classifyDockerFailure>[0] = 'create';
  try {
    const args = buildCheckCreateArgs(name, cfg);
    const env = { [CLAUDE_TOKEN_ENV]: token };
    try {
      await deps.docker.create(args, env);
    } catch (err) {
      if (!/No such image|not found|pull access denied/i.test(errorMessage(err))) throw err;
      step = 'pull';
      await deps.docker.pull(cfg.image);
      step = 'create';
      await deps.docker.create(args, env);
    }
    step = 'copy';
    await deps.docker.copyIn(name, cfg.claudeBin);
    step = 'start';
    await deps.docker.start(name);
    step = 'exec';
    const started = Date.now();
    const r = await deps.runner.run(
      deps.dockerBin ?? 'docker',
      ['exec', name, ...checkArgv(cfg.claudeBin)],
      {
        timeoutMs,
      },
    );
    // Only the output of Claude itself is classified (it may prove the token valid).
    c = classifyCheck({ ...r, timedOut: r.code !== 0 && Date.now() - started >= timeoutMs - 50 });
  } catch (err) {
    // A docker step failed before (or instead of) Claude answering: inconclusive.
    c = classifyDockerFailure(step, errorMessage(err));
  } finally {
    await deps.docker.remove(name).catch(() => undefined);
  }
  const detail = c.valid && !c.errorClass ? undefined : checkDetail(c.text, token);
  return {
    payload: {
      valid: c.valid,
      checkedAt: now().toISOString(),
      ...(c.errorClass ? { errorClass: c.errorClass } : {}),
      ...(detail ? { detail } : {}),
    },
    tokenHash,
  };
}

/** Human line for `orch doctor` / `orch login`. */
export function checkLine(p: ClaudeAuthPayload): string {
  if (p.valid && p.errorClass === 'rate_limited') {
    return '✓ Claude login verified (the account is rate limited right now)';
  }
  if (p.valid) return '✓ Claude login verified';
  if (p.errorClass === 'unauthorized') {
    return '✗ Claude rejected this token (401). Run `orch login` again.';
  }
  if (p.errorClass === 'no_token') return '✗ No Claude token stored. Run `orch login`.';
  return `? Could not verify the Claude login (${p.errorClass ?? 'error'}): ${p.detail ?? 'no detail'}`;
}
