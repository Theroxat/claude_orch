/**
 * The ONLY place where task container specs are built (PLAN 5.3).
 *
 * Guarantees, asserted by the unit tests:
 *  - exactly one mount: the task clone's worktree (rw) at the workspace folder. Its real git dir
 *    is agent-private (`git.ts`); the worktree only holds a throwaway copy. No docker socket, no host
 *    home, no /data, no mirrors, no other task. The Claude binary is copied in (`docker cp`)
 *    instead of being mounted.
 *  - a non-root `--user uid:gid`, `--cap-drop ALL`, `no-new-privileges`, no `--privileged`,
 *    pids/memory/cpu limits by size, `/tmp` as tmpfs, a per-task network, no published ports.
 *  - the Claude token is passed by NAME only (`-e CLAUDE_CODE_OAUTH_TOKEN`); its value comes from
 *    the docker CLI child's environment, so it never appears in argv, logs or files.
 */
import { isAbsolute, normalize } from 'node:path';
import type { TaskSize } from '@orch/shared';

export const CLAUDE_TOKEN_ENV = 'CLAUDE_CODE_OAUTH_TOKEN';
/** Claude config dir inside the container (on the /tmp tmpfs, never in the clone). */
export const TASK_CLAUDE_CONFIG_DIR = '/tmp/.claude';

export const SIZE_LIMITS: Record<TaskSize, { memory: string; cpus: string; pids: number }> = {
  S: { memory: '4g', cpus: '2', pids: 2048 },
  M: { memory: '6g', cpus: '4', pids: 4096 },
  L: { memory: '8g', cpus: '4', pids: 4096 },
};

export interface SandboxSpec {
  name: string;
  image: string;
  /** Absolute host path of the task clone. */
  clonePath: string;
  workspaceFolder: string;
  uid: number;
  gid: number;
  network: string;
  size: TaskSize;
  labels: Record<string, string>;
  /** From devcontainer containerEnv. Reserved names are dropped. */
  containerEnv: Record<string, string>;
}

export class SandboxError extends Error {
  override name = 'SandboxError';
}

const FORBIDDEN_SOURCES = [
  '/',
  '/var/run/docker.sock',
  '/run/docker.sock',
  '/var/run',
  '/run',
  '/data',
  '/secrets',
  '/root',
  '/home',
  '/etc',
];
const RESERVED_ENV = new Set([
  CLAUDE_TOKEN_ENV,
  'CLAUDE_CONFIG_DIR',
  'HOME',
  'DOCKER_HOST',
  'ANTHROPIC_API_KEY',
]);

/** Env the sandbox always sets (values are not secret). */
export const SANDBOX_ENV: Record<string, string> = {
  HOME: '/tmp',
  CLAUDE_CONFIG_DIR: TASK_CLAUDE_CONFIG_DIR,
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  DISABLE_TELEMETRY: '1',
  DISABLE_AUTOUPDATER: '1',
};

function checkSpec(s: SandboxSpec): void {
  if (!Number.isInteger(s.uid) || s.uid <= 0 || !Number.isInteger(s.gid) || s.gid < 0) {
    throw new SandboxError(`Task containers must run as a non-root uid (got ${s.uid}:${s.gid})`);
  }
  const src = normalize(s.clonePath).replace(/\/+$/, '');
  if (
    !isAbsolute(src) ||
    src.includes(',') ||
    FORBIDDEN_SOURCES.includes(src) ||
    src.includes('docker.sock')
  ) {
    throw new SandboxError(`Refusing to mount ${s.clonePath} into a task container`);
  }
  if (!/^\/[A-Za-z0-9._/-]+$/.test(s.workspaceFolder) || s.workspaceFolder.includes('..')) {
    throw new SandboxError(`Invalid workspace folder ${s.workspaceFolder}`);
  }
  if (s.image.startsWith('-') || s.name.startsWith('-') || s.network.startsWith('-')) {
    throw new SandboxError('Invalid image, name or network');
  }
}

/** Arguments for `docker create` (everything after the subcommand). */
export function buildCreateArgs(s: SandboxSpec): string[] {
  checkSpec(s);
  const lim = SIZE_LIMITS[s.size];
  const args = [
    '--name',
    s.name,
    '--user',
    `${s.uid}:${s.gid}`,
    '--network',
    s.network,
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--pids-limit',
    String(lim.pids),
    '--memory',
    lim.memory,
    '--cpus',
    lim.cpus,
    '--tmpfs',
    '/tmp:rw,exec,nosuid,nodev,mode=1777,size=2g',
    '--mount',
    `type=bind,source=${normalize(s.clonePath)},target=${s.workspaceFolder}`,
    '--workdir',
    s.workspaceFolder,
    '--init',
  ];
  for (const [k, v] of Object.entries(s.labels)) args.push('--label', `${k}=${v}`);
  for (const [k, v] of Object.entries(s.containerEnv)) {
    if (!RESERVED_ENV.has(k)) args.push('-e', `${k}=${v}`);
  }
  for (const [k, v] of Object.entries(SANDBOX_ENV)) args.push('-e', `${k}=${v}`);
  // Name only: docker reads the value from its own environment.
  args.push('-e', CLAUDE_TOKEN_ENV);
  // Keep the container alive; the member's Claude session runs through `docker exec`.
  args.push('--entrypoint', 'sleep', s.image, 'infinity');
  return args;
}
