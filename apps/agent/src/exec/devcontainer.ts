/**
 * Dev environment selection (PLAN 5.2): `.devcontainer/devcontainer.json` (or `.devcontainer.json`)
 * -> root `Dockerfile` -> the default image. Only simple devcontainer keys are honored; the rest
 * are ignored with a warning. This is not a sanitizer: `sandbox.ts` always builds the container
 * spec itself, so nothing here can add mounts, capabilities or privileges.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { realPathLoose, resolveInside } from './paths';

export type PostCreateCommand = string | string[] | Record<string, string | string[]>;

interface DevEnvCommon {
  containerEnv: Record<string, string>;
  postCreateCommand: PostCreateCommand | null;
  /** Absolute path inside the container where the clone is mounted. */
  workspaceFolder: string;
  warnings: string[];
}

export type DevEnv =
  | (DevEnvCommon & { kind: 'image'; source: 'devcontainer' | 'default'; image: string })
  | (DevEnvCommon & {
      kind: 'build';
      source: 'devcontainer' | 'dockerfile';
      /** Absolute host paths, both inside the clone. */
      dockerfile: string;
      context: string;
      args: Record<string, string>;
    });

export const DEFAULT_WORKSPACE = '/workspace';

const HONORED = new Set([
  'name',
  'image',
  'build',
  'containerEnv',
  'remoteUser',
  'postCreateCommand',
  'workspaceFolder',
  'dockerFile',
  'context',
]);

/** Strips // and /* *\/ comments and trailing commas (JSONC), outside strings. */
export function stripJsonc(text: string): string {
  let out = '';
  let i = 0;
  let inStr = false;
  while (i < text.length) {
    const c = text[i] as string;
    const n = text[i + 1];
    if (inStr) {
      out += c;
      if (c === '\\') {
        out += n ?? '';
        i += 2;
        continue;
      }
      if (c === '"') inStr = false;
      i++;
    } else if (c === '"') {
      inStr = true;
      out += c;
      i++;
    } else if (c === '/' && n === '/') {
      while (i < text.length && text[i] !== '\n') i++;
    } else if (c === '/' && n === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i += 2;
    } else {
      out += c;
      i++;
    }
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

export class DevEnvError extends Error {
  override name = 'DevEnvError';
}

const isFile = (p: string) => existsSync(p) && statSync(p).isFile();

/**
 * Resolves `p` against `base` and returns its real path, refusing anything outside `root` (the
 * clone), including through symlinks.
 */
function inside(root: string, base: string, p: string, what: string): string {
  const real = resolveInside(root, base, p);
  if (real === null) {
    throw new DevEnvError(`devcontainer ${what} "${p}" points outside the repository`);
  }
  return real;
}

/** `rel` inside the clone when it is a regular file whose real path stays in the clone. */
function repoFile(clone: string, rel: string, what: string): string | null {
  const f = join(clone, rel);
  if (!isFile(f)) return null;
  const real = resolveInside(clone, clone, rel);
  if (real === null) throw new DevEnvError(`${what} "${rel}" is a symlink out of the repository`);
  return real;
}

const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

function stringRecord(v: unknown, what: string, warnings: string[]): Record<string, string> {
  if (v === undefined || v === null) return {};
  if (typeof v !== 'object' || Array.isArray(v)) {
    warnings.push(`devcontainer ${what} is not an object, ignored`);
    return {};
  }
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (!ENV_KEY.test(k)) {
      warnings.push(`devcontainer ${what}.${k}: invalid name, ignored`);
      continue;
    }
    if (typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean') {
      out[k] = String(val);
    } else warnings.push(`devcontainer ${what}.${k}: not a scalar, ignored`);
  }
  return out;
}

function postCreate(v: unknown, warnings: string[]): PostCreateCommand | null {
  if (v === undefined || v === null) return null;
  if (typeof v === 'string') return v;
  const isArgv = (a: unknown): a is string[] =>
    Array.isArray(a) && a.length > 0 && a.every((x) => typeof x === 'string');
  if (isArgv(v)) return v;
  if (typeof v === 'object' && !Array.isArray(v)) {
    const out: Record<string, string | string[]> = {};
    for (const [k, c] of Object.entries(v as Record<string, unknown>)) {
      if (typeof c === 'string' || isArgv(c)) out[k] = c;
    }
    return out;
  }
  warnings.push('devcontainer postCreateCommand has an unsupported form, ignored');
  return null;
}

function workspaceFolder(v: unknown, warnings: string[]): string {
  if (v === undefined) return DEFAULT_WORKSPACE;
  if (typeof v === 'string' && /^\/[A-Za-z0-9._/-]+$/.test(v) && v !== '/' && !v.includes('..')) {
    return v.replace(/\/+$/, '');
  }
  warnings.push(
    `devcontainer workspaceFolder ${JSON.stringify(v)} is not supported, using /workspace`,
  );
  return DEFAULT_WORKSPACE;
}

/** Reads and interprets a devcontainer.json file located at `file` inside `clone`. */
export function fromDevcontainer(clone: string, file: string): DevEnv {
  let cfg: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(stripJsonc(readFileSync(file, 'utf8')));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error();
    cfg = parsed as Record<string, unknown>;
  } catch {
    throw new DevEnvError(`${relative(clone, file)} is not valid JSON`);
  }
  const warnings: string[] = [];
  for (const k of Object.keys(cfg)) {
    if (!HONORED.has(k)) warnings.push(`devcontainer key "${k}" is not supported in v1, ignored`);
  }
  if (cfg['remoteUser'] !== undefined) {
    warnings.push('devcontainer remoteUser is ignored: tasks run as your own non-root uid');
  }
  const common: DevEnvCommon = {
    containerEnv: stringRecord(cfg['containerEnv'], 'containerEnv', warnings),
    postCreateCommand: postCreate(cfg['postCreateCommand'], warnings),
    workspaceFolder: workspaceFolder(cfg['workspaceFolder'], warnings),
    warnings,
  };
  const base = dirname(file);
  const build = cfg['build'] as Record<string, unknown> | undefined;
  // Legacy top-level `dockerFile` / `context` keys are accepted too.
  const dockerfileRel =
    (build && typeof build['dockerfile'] === 'string' ? build['dockerfile'] : undefined) ??
    (typeof cfg['dockerFile'] === 'string' ? cfg['dockerFile'] : undefined);
  if (dockerfileRel !== undefined) {
    const contextRel =
      (build && typeof build['context'] === 'string' ? build['context'] : undefined) ??
      (typeof cfg['context'] === 'string' ? cfg['context'] : '.');
    const dockerfile = inside(clone, base, dockerfileRel, 'build.dockerfile');
    if (!isFile(dockerfile)) {
      throw new DevEnvError(`devcontainer build.dockerfile "${dockerfileRel}" does not exist`);
    }
    return {
      ...common,
      kind: 'build',
      source: 'devcontainer',
      dockerfile,
      context: inside(clone, base, contextRel, 'build.context'),
      args: stringRecord(build?.['args'], 'build.args', warnings),
    };
  }
  if (typeof cfg['image'] === 'string' && cfg['image'].trim() !== '') {
    return { ...common, kind: 'image', source: 'devcontainer', image: cfg['image'].trim() };
  }
  throw new DevEnvError('devcontainer.json has neither "image" nor "build.dockerfile"');
}

/** PLAN 5.2 precedence. `defaultImage` is used when the repo defines nothing. */
export function selectDevEnv(clone: string, defaultImage: string): DevEnv {
  for (const rel of ['.devcontainer/devcontainer.json', '.devcontainer.json']) {
    const f = repoFile(clone, rel, 'devcontainer');
    if (f) return fromDevcontainer(clone, f);
  }
  const dockerfile = repoFile(clone, 'Dockerfile', 'Dockerfile');
  if (dockerfile) {
    return {
      kind: 'build',
      source: 'dockerfile',
      dockerfile,
      context: realPathLoose(clone),
      args: {},
      containerEnv: {},
      postCreateCommand: null,
      workspaceFolder: DEFAULT_WORKSPACE,
      warnings: [],
    };
  }
  return {
    kind: 'image',
    source: 'default',
    image: defaultImage,
    containerEnv: {},
    postCreateCommand: null,
    workspaceFolder: DEFAULT_WORKSPACE,
    warnings: [],
  };
}

/** The repo's compose file for sidecars, if any (its real path, refused if it leaves the clone). */
export function findComposeFile(clone: string): string | null {
  for (const name of ['compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml']) {
    const f = repoFile(clone, name, 'compose file');
    if (f) return f;
  }
  return null;
}

/** postCreateCommand -> list of argv to run in order. */
export function postCreateArgvs(cmd: PostCreateCommand | null): string[][] {
  if (cmd === null) return [];
  if (typeof cmd === 'string') return [['sh', '-c', cmd]];
  if (Array.isArray(cmd)) return [cmd];
  return Object.values(cmd).map((c) => (typeof c === 'string' ? ['sh', '-c', c] : c));
}
