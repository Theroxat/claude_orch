/**
 * Pure parts of the agent self-update (`agent.update` / `orch update`): image validation, own
 * compose project discovery from the container labels, `.env` rewrite and the exact docker argv
 * of the helper containers. Everything here is unit tested; `updater.ts` runs it.
 *
 * Safety model: the agent only ever pulls `<its configured repository>:<release version>` and only
 * ever runs `docker compose up -d <its own service>` for its own compose project. Nothing in the
 * server message reaches a shell: values are checked against strict patterns and passed as argv.
 */
import { isAbsolute, posix } from 'node:path';
import { IMAGE_REPO_RE, RELEASE_VERSION_RE } from '@orch/shared';

export type UpdateErrorCode =
  | 'invalid_image'
  | 'busy'
  | 'in_progress'
  | 'not_compose'
  | 'unsupported_layout'
  | 'template_unsupported'
  | 'pull_failed'
  | 'env_write_failed'
  | 'helper_failed'
  | 'not_applied'
  | 'no_target'
  | 'unsupported';

export class UpdateError extends Error {
  override name = 'UpdateError';
  constructor(
    readonly code: UpdateErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Checks that `image` is exactly `<allowedRepo>:<targetVersion>`, with a release version and a
 * plain repository reference. Returns the image; throws UpdateError('invalid_image') otherwise.
 */
export function validateUpdateImage(
  image: string,
  targetVersion: string,
  allowedRepo: string,
): string {
  if (!IMAGE_REPO_RE.test(allowedRepo)) {
    throw new UpdateError('invalid_image', `The configured image repository is invalid.`);
  }
  if (!RELEASE_VERSION_RE.test(targetVersion)) {
    throw new UpdateError('invalid_image', `"${targetVersion.slice(0, 64)}" is not a release.`);
  }
  if (image !== `${allowedRepo}:${targetVersion}`) {
    throw new UpdateError(
      'invalid_image',
      `Refusing image ${image.slice(0, 200)}: only ${allowedRepo}:<version> is allowed.`,
    );
  }
  return image;
}

/** What the agent learns about its own container from `docker inspect`. */
export interface SelfContainer {
  /** Image id (sha256:...) of the running container: always present locally, used as helper. */
  imageId: string;
  project: string;
  service: string;
  workingDir: string;
  configFiles: string[];
  /** The `.env` compose reads (`<workingDir>/.env`, or the env file label when it is one file). */
  envFile: string;
  /** Host source of the `/host-claude` mount, when present (kept as is by the restart). */
  hostClaudeDir: string | null;
}

const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const IMAGE_ID_RE = /^sha256:[a-f0-9]{64}$/;
const hasControlChar = (s: string) => [...s].some((ch) => ch.charCodeAt(0) < 0x20);

/** Host paths we accept in argv: absolute, no control characters, no comma, no `..`. */
function checkPath(p: string, what: string): string {
  if (
    !isAbsolute(p) ||
    hasControlChar(p) ||
    p.includes(',') ||
    p.split('/').includes('..') ||
    posix.normalize(p) !== p
  ) {
    throw new UpdateError('unsupported_layout', `Unsupported ${what}: ${p.slice(0, 200)}`);
  }
  return p;
}

function inside(dir: string, p: string): boolean {
  return p === dir || p.startsWith(dir.endsWith('/') ? dir : `${dir}/`);
}

/**
 * Parses `docker inspect --type container <self>` (a JSON array) and reads the compose labels:
 * `com.docker.compose.project`, `.project.config_files` (comma-separated), `.project.working_dir`,
 * `.service` and, when present, `.project.environment_file`.
 */
export function parseSelfInspect(json: string): SelfContainer {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    throw new UpdateError('not_compose', 'Could not read the agent container (docker inspect).');
  }
  const c = (Array.isArray(data) ? data[0] : data) as
    | {
        Image?: unknown;
        Config?: { Labels?: Record<string, unknown> | null };
        Mounts?: { Source?: unknown; Destination?: unknown }[] | null;
      }
    | undefined;
  const labels = c?.Config?.Labels ?? {};
  const label = (k: string) => {
    const v = labels[`com.docker.compose.${k}`];
    return typeof v === 'string' ? v.trim() : '';
  };
  const project = label('project');
  const workingDir = label('project.working_dir');
  const files = label('project.config_files');
  if (!project || !workingDir || !files) {
    throw new UpdateError(
      'not_compose',
      'This agent was not started with docker compose; update it manually.',
    );
  }
  if (!NAME_RE.test(project)) {
    throw new UpdateError('unsupported_layout', `Unsupported compose project name: ${project}`);
  }
  const service = label('service') || 'agent';
  if (!NAME_RE.test(service)) {
    throw new UpdateError('unsupported_layout', `Unsupported compose service name: ${service}`);
  }
  const imageId = typeof c?.Image === 'string' ? c.Image : '';
  if (!IMAGE_ID_RE.test(imageId)) {
    throw new UpdateError('not_compose', 'Could not read the image id of the agent container.');
  }
  checkPath(workingDir, 'compose working directory');
  const configFiles = files
    .split(',')
    .map((f) => f.trim())
    .filter(Boolean)
    .map((f) => checkPath(f, 'compose file'));
  for (const f of configFiles) {
    if (!inside(workingDir, f)) {
      throw new UpdateError(
        'unsupported_layout',
        `The compose file ${f} is outside ${workingDir}; update the agent manually.`,
      );
    }
  }
  const envLabel = label('project.environment_file');
  const envFiles = envLabel ? envLabel.split(',').map((f) => f.trim()) : [];
  let envFile = posix.join(workingDir, '.env');
  if (envFiles.length === 1 && envFiles[0]) envFile = checkPath(envFiles[0], 'env file');
  if (!inside(workingDir, envFile)) {
    throw new UpdateError(
      'unsupported_layout',
      `The env file ${envFile} is outside ${workingDir}.`,
    );
  }
  const claude = (c?.Mounts ?? []).find((m) => m.Destination === '/host-claude');
  let hostClaudeDir: string | null = null;
  if (typeof claude?.Source === 'string') {
    try {
      hostClaudeDir = checkPath(claude.Source, 'Claude directory');
    } catch {
      hostClaudeDir = null;
    }
  }
  return { imageId, project, service, workingDir, configFiles, envFile, hostClaudeDir };
}

export type ImageEnvKey = 'ORCH_AGENT_TAG' | 'ORCH_AGENT_IMAGE';

/**
 * Which `.env` variable selects the agent image in this compose template: ORCH_AGENT_TAG when
 * the template interpolates it (current template), else ORCH_AGENT_IMAGE (a full image ref).
 */
export function chooseImageKey(composeText: string): ImageEnvKey {
  if (/\$\{ORCH_AGENT_TAG[:}?-]/.test(composeText)) return 'ORCH_AGENT_TAG';
  if (/\$\{ORCH_AGENT_IMAGE[:}?-]/.test(composeText)) return 'ORCH_AGENT_IMAGE';
  throw new UpdateError(
    'template_unsupported',
    'The compose file does not use ORCH_AGENT_TAG or ORCH_AGENT_IMAGE; update the agent manually.',
  );
}

/** The `.env` value to write for `key`. */
export function imageEnvValue(key: ImageEnvKey, repo: string, version: string): string {
  return key === 'ORCH_AGENT_TAG' ? version : `${repo}:${version}`;
}

/**
 * Sets `key=value` in a dotenv text: replaces every existing assignment of `key` (also
 * `export key=`), or appends one. Every other line is kept byte for byte.
 */
export function setEnvValue(text: string, key: string, value: string): string {
  if (!/^[A-Z_][A-Z0-9_]*$/.test(key) || /[\r\n]/.test(value)) {
    throw new UpdateError('env_write_failed', 'Invalid .env assignment.');
  }
  const re = new RegExp(`^(\\s*(?:export\\s+)?)${key}\\s*=.*$`);
  const lines = text.split('\n');
  let found = false;
  const out = lines.map((line) => {
    const m = re.exec(line.replace(/\r$/, ''));
    if (!m) return line;
    found = true;
    return `${m[1] ?? ''}${key}=${value}${line.endsWith('\r') ? '\r' : ''}`;
  });
  if (found) return out.join('\n');
  const base = text === '' || text.endsWith('\n') ? text : `${text}\n`;
  return `${base}${key}=${value}\n`;
}

/** Backup of the `.env` taken before the rewrite; the helper restores it if `up` fails. */
export const ENV_BACKUP_SUFFIX = '.orch-update.bak';

const HOST_SOCKET = '/var/run/docker.sock';

/** `docker run` argv prefix of a short-lived container from the agent's own image. */
function runPrefix(self: SelfContainer, extra: string[]): string[] {
  return [
    'run',
    '--rm',
    ...extra,
    '--label',
    'orch.update-helper=1',
    '-v',
    `${self.workingDir}:${self.workingDir}`,
    '--entrypoint',
    'sh',
  ];
}

/** Reads one host file of the install dir: `docker run ... sh -c 'cat -- "$1"' <file>`. */
export function readFileArgs(self: SelfContainer, file: string): string[] {
  return [
    ...runPrefix(self, ['--network', 'none']),
    self.imageId,
    '-c',
    'cat -- "$1"',
    'orch-update-read',
    file,
  ];
}

/**
 * Rewrites the `.env` in place from stdin (owner and mode are kept) after copying it to the
 * backup: `docker run -i ... sh -c 'cp -p ... && cat > "$1"' <envFile>`.
 */
export function writeEnvArgs(self: SelfContainer): string[] {
  return [
    ...runPrefix(self, ['-i', '--network', 'none']),
    self.imageId,
    '-c',
    `cp -p -- "$1" "$1${ENV_BACKUP_SUFFIX}" && cat > "$1"`,
    'orch-update-env',
    self.envFile,
  ];
}

/** Puts the `.env` backup back (the restart could not be handed off). */
export function restoreEnvArgs(self: SelfContainer): string[] {
  return [
    ...runPrefix(self, ['--network', 'none']),
    self.imageId,
    '-c',
    `cat -- "$1${ENV_BACKUP_SUFFIX}" > "$1" && rm -f -- "$1${ENV_BACKUP_SUFFIX}"`,
    'orch-update-restore',
    self.envFile,
  ];
}

/**
 * The restart script run by the helper container. Arguments: delay, project, working dir,
 * service, env file, then the compose files. It waits so the agent can report `restarting`,
 * runs `docker compose up -d` for the agent service only, and on failure restores the `.env`
 * backup and brings the previous version back up.
 */
export const HELPER_SCRIPT = [
  'set -u',
  'delay=$1 project=$2 wd=$3 service=$4 envf=$5',
  'shift 5',
  'n=$#',
  'while [ "$n" -gt 0 ]; do set -- "$@" -f "$1"; shift; n=$((n-1)); done',
  'sleep "$delay"',
  'if docker compose -p "$project" --project-directory "$wd" "$@" up -d --no-deps "$service"; then',
  `  rm -f -- "$envf${ENV_BACKUP_SUFFIX}"`,
  '  exit 0',
  'fi',
  `if [ -f "$envf${ENV_BACKUP_SUFFIX}" ]; then`,
  `  cat -- "$envf${ENV_BACKUP_SUFFIX}" > "$envf" && rm -f -- "$envf${ENV_BACKUP_SUFFIX}"`,
  '  docker compose -p "$project" --project-directory "$wd" "$@" up -d --no-deps "$service"',
  'fi',
  'exit 1',
].join('\n');

/**
 * `docker run -d` argv of the detached helper: the agent's own (current) image, the host docker
 * socket and the install dir mounted at the SAME absolute path, so relative paths in the compose
 * file resolve exactly as on the host. It outlives the agent container it recreates.
 */
export function helperRunArgs(
  self: SelfContainer,
  name: string,
  delaySec: number,
  env: Record<string, string> = {},
): string[] {
  if (!NAME_RE.test(name)) throw new UpdateError('helper_failed', 'Invalid helper name.');
  const envArgs = Object.entries(env).flatMap(([k, v]) => {
    if (!/^ORCH_[A-Z0-9_]+$/.test(k) || hasControlChar(v)) {
      throw new UpdateError('helper_failed', 'Invalid helper environment.');
    }
    return ['-e', `${k}=${v}`];
  });
  return [
    'run',
    '-d',
    '--rm',
    '--name',
    name,
    '--label',
    'orch.update-helper=1',
    '-v',
    `${HOST_SOCKET}:${HOST_SOCKET}`,
    '-v',
    `${self.workingDir}:${self.workingDir}`,
    '-w',
    self.workingDir,
    ...envArgs,
    '--entrypoint',
    'sh',
    self.imageId,
    '-c',
    HELPER_SCRIPT,
    'orch-update-helper',
    String(Math.max(0, Math.floor(delaySec))),
    self.project,
    self.workingDir,
    self.service,
    self.envFile,
    ...self.configFiles,
  ];
}
