/**
 * Agent configuration from the environment (zod-validated, fails fast with a readable error).
 *
 * Names match deploy/agent/compose.yaml and the ~/orch/.env written by install.sh.
 * Empty values (compose `${X:-}`) are treated as unset.
 *
 * Usage interval rule: when ORCH_USAGE_INTERVAL_SEC is set explicitly it always wins.
 * Otherwise the server's `welcome.usageSec` / `config.update.usageSec` is used, with 300 s
 * as the value before the first welcome.
 */
import { hostname } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { DEFAULT_AGENT_IMAGE_REPO, IMAGE_REPO_RE } from '@orch/shared';
import type { LogLevel } from './log';
import type { PlanName } from './usage';

export const DEFAULT_USAGE_INTERVAL_SEC = 300;

const optionalString = z.string().min(1).optional();

const EnvSchema = z.object({
  ORCH_SERVER_URL: z
    .string({
      error: (iss) =>
        iss.input === undefined ? 'is required (e.g. https://orch.example.com)' : undefined,
    })
    .url('must be a URL')
    .refine((u) => /^https?:\/\//i.test(u), 'must start with http:// or https://'),
  ORCH_AGENT_CREDENTIAL: optionalString,
  ORCH_AGENT_ID: optionalString,
  ORCH_ENROLL_TOKEN: optionalString,
  ORCH_DATA_DIR: z.string().min(1).default('/data'),
  ORCH_SOCKET_PATH: z.string().min(1).default('/run/orch.sock'),
  ORCH_SECRETS_DIR: z.string().min(1).default('/secrets'),
  ORCH_WORK_DIR: optionalString,
  ORCH_MACHINE_NAME: z.string().trim().min(1).max(100).optional(),
  ORCH_USAGE_INTERVAL_SEC: z.coerce.number().int().min(5).max(86_400).optional(),
  ORCH_CLAUDE_USAGE_ROOT: z.string().min(1).default('/host-claude'),
  /** Explicit 5h limit in weighted tokens; replaces the limit calibrated from history. */
  ORCH_USAGE_LIMIT: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.coerce.number().positive().optional(),
  ),
  ORCH_PLAN: z.enum(['pro', 'max5', 'max20']).default('pro'),
  ORCH_CLAUDE_BIN: z.string().min(1).default('claude'),
  ORCH_MAX_CONCURRENT: z.coerce.number().int().min(1).max(16).default(1),
  ORCH_DEFAULT_IMAGE: z.string().min(1).default('node:22-bookworm'),
  ORCH_GIT_BASE_URL: z.string().url().default('https://github.com'),
  ORCH_TASK_UID: z.coerce.number().int().min(1).optional(),
  ORCH_TASK_GID: z.coerce.number().int().min(0).optional(),
  ORCH_GIT_AUTHOR_NAME: z.string().min(1).default('orch agent'),
  ORCH_GIT_AUTHOR_EMAIL: z.string().min(3).default('orch-agent@users.noreply.github.com'),
  /** Image repository the agent may update itself to (`<repo>:<version>` only). */
  ORCH_AGENT_IMAGE_REPO: z
    .string()
    .regex(
      IMAGE_REPO_RE,
      'must be an image repository without tag (e.g. ghcr.io/theroxat/orch-agent)',
    )
    .default(DEFAULT_AGENT_IMAGE_REPO),
  /** Set by docker to the container id: used to find the own container for self-update. */
  HOSTNAME: optionalString,
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']).default('info'),
});

export interface AgentConfig {
  serverUrl: string;
  wsUrl: string;
  enrollUrl: string;
  credential?: string;
  agentId?: string;
  enrollToken?: string;
  dataDir: string;
  credentialFile: string;
  socketPath: string;
  secretsDir: string;
  workDir?: string;
  machineName: string;
  usageIntervalSec: number;
  /** True when ORCH_USAGE_INTERVAL_SEC was set: the server value is then ignored. */
  usageIntervalExplicit: boolean;
  claudeUsageRoot: string;
  plan: PlanName;
  /** ORCH_USAGE_LIMIT: absolute weighted-token limit per 5h window, or undefined to calibrate. */
  usageLimit?: number;
  claudeBin: string;
  logLevel: LogLevel;
  maxConcurrent: number;
  defaultImage: string;
  gitBaseUrl: string;
  taskUid?: number;
  taskGid?: number;
  gitAuthor: { name: string; email: string };
  imageRepo: string;
  /** Own container id (HOSTNAME), undefined outside a container. */
  selfContainerId?: string;
}

export class ConfigError extends Error {
  override name = 'ConfigError';
}

function dropEmpty(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined && v.trim() !== '') out[k] = v;
  return out;
}

/** Server base URL without credentials, query, hash or trailing slash. */
function baseUrl(url: string): string {
  const u = new URL(url);
  return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
}

export function toWsUrl(serverUrl: string): string {
  return `${baseUrl(serverUrl).replace(/^http/i, 'ws')}/agent/ws`;
}

function toLogLevel(l: z.infer<typeof EnvSchema>['LOG_LEVEL']): LogLevel {
  if (l === 'trace') return 'debug';
  if (l === 'fatal') return 'error';
  return l;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AgentConfig {
  const parsed = EnvSchema.safeParse(dropEmpty(env));
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
    throw new ConfigError(`Invalid agent configuration:\n${lines.join('\n')}`);
  }
  const e = parsed.data;
  const base = baseUrl(e.ORCH_SERVER_URL);
  return {
    serverUrl: base,
    wsUrl: toWsUrl(e.ORCH_SERVER_URL),
    enrollUrl: `${base}/api/agents/enroll`,
    credential: e.ORCH_AGENT_CREDENTIAL,
    agentId: e.ORCH_AGENT_ID,
    enrollToken: e.ORCH_ENROLL_TOKEN,
    dataDir: e.ORCH_DATA_DIR,
    credentialFile: join(e.ORCH_DATA_DIR, 'agent-credential'),
    socketPath: e.ORCH_SOCKET_PATH,
    secretsDir: e.ORCH_SECRETS_DIR,
    workDir: e.ORCH_WORK_DIR,
    machineName: e.ORCH_MACHINE_NAME ?? hostname(),
    usageIntervalSec: e.ORCH_USAGE_INTERVAL_SEC ?? DEFAULT_USAGE_INTERVAL_SEC,
    usageIntervalExplicit: e.ORCH_USAGE_INTERVAL_SEC !== undefined,
    claudeUsageRoot: e.ORCH_CLAUDE_USAGE_ROOT,
    plan: e.ORCH_PLAN,
    usageLimit: e.ORCH_USAGE_LIMIT,
    claudeBin: e.ORCH_CLAUDE_BIN,
    logLevel: toLogLevel(e.LOG_LEVEL),
    maxConcurrent: e.ORCH_MAX_CONCURRENT,
    defaultImage: e.ORCH_DEFAULT_IMAGE,
    gitBaseUrl: e.ORCH_GIT_BASE_URL.replace(/\/+$/, ''),
    taskUid: e.ORCH_TASK_UID,
    taskGid: e.ORCH_TASK_GID,
    gitAuthor: { name: e.ORCH_GIT_AUTHOR_NAME, email: e.ORCH_GIT_AUTHOR_EMAIL },
    imageRepo: e.ORCH_AGENT_IMAGE_REPO,
    selfContainerId: e.HOSTNAME,
  };
}

/** Subset used by the `orch` CLI, which must work without ORCH_SERVER_URL. */
export interface CliConfig {
  socketPath: string;
  secretsDir: string;
  /** Agent data dir (holds the persisted Claude login state reset by `orch login`). */
  dataDir: string;
  claudeBin: string;
}

export function loadCliConfig(env: NodeJS.ProcessEnv = process.env): CliConfig {
  const e = dropEmpty(env);
  return {
    socketPath: e.ORCH_SOCKET_PATH ?? '/run/orch.sock',
    secretsDir: e.ORCH_SECRETS_DIR ?? '/secrets',
    dataDir: e.ORCH_DATA_DIR ?? '/data',
    claudeBin: e.ORCH_CLAUDE_BIN ?? 'claude',
  };
}
