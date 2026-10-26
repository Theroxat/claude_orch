/**
 * Guard for a task repository's compose file (sidecar services). The agent holds the host docker
 * socket, so a compose file that mounts host paths, joins host namespaces or adds privileges is
 * root on the host. Two layers:
 *  1. `scanComposeSources`: run BEFORE docker reads anything. Every compose file is parsed with a
 *     real YAML parser (any parse error fails closed) and its `include` / `extends` / `env_file` /
 *     `label_file` references are followed; remote, interpolated or out-of-root ones are refused,
 *     and so is an implicit `.env` that resolves outside the root (docker itself would read all
 *     of those files while building the model);
 *  2. `checkComposeModel`: audit of the resolved model from `docker compose config --format json`
 *     with ALLOWLISTS: only known-safe keys are accepted per service, build, deploy, network,
 *     volume, secret and config, and every other key is refused by name. A key added by a future
 *     compose version is therefore refused until someone reviews it.
 *     Values are checked too (capabilities, namespaces, mounts, sysctls, ulimits, tmpfs options,
 *     extra_hosts, labels, replicas, ...).
 * `sanitizeComposeModel` then strips published ports and restart policies, drops every
 * capability but a harmless baseline, forces no-new-privileges, caps memory / CPU / pids and
 * adds our labels, and the sanitized model is what actually gets run. The compose CLI itself
 * runs with a minimal environment (`childEnv(..., true)`), so interpolation cannot read agent
 * variables.
 */
import { existsSync, lstatSync, readFileSync, statSync } from 'node:fs';
import { isIP } from 'node:net';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { parseAllDocuments } from 'yaml';
import { errorMessage } from '../log.js';
import { isInside, realPathLoose, resolveInside } from './paths.js';

export class ComposeGuardError extends Error {
  override name = 'ComposeGuardError';
  constructor(readonly problems: string[]) {
    super('Refusing the repository compose file:\n- ' + problems.join('\n- '));
  }
}

type Json = Record<string, unknown>;

function isObj(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function strList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

function asList(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [v];
}

/** null, false, '', [] or {}: a forbidden key may be present with such a value. */
function isEmpty(v: unknown): boolean {
  if (v === undefined || v === null || v === false || v === '') return true;
  if (Array.isArray(v)) return v.length === 0;
  if (isObj(v)) return Object.keys(v).length === 0;
  return false;
}

/** Extension fields (`x-*`) are ignored by compose. */
const isExtension = (k: string): boolean => k.startsWith('x-');

/** Problems for every key of `obj` outside `allowed` (extension fields excepted). */
function unknownKeys(where: string, obj: Json, allowed: ReadonlySet<string>, out: string[]): void {
  for (const k of Object.keys(obj)) {
    if (!allowed.has(k) && !isExtension(k)) out.push(`${where}: "${k}" is not allowed`);
  }
}

// ---------------------------------------------------------------------------------------------
// Source scan
// ---------------------------------------------------------------------------------------------

/** What a reference is for: `file` ones are scanned recursively, `dir` / `env` only contained. */
type RefKind = 'file' | 'dir' | 'env';

interface Ref {
  kind: RefKind;
  /** The key it came from (`include`, `extends`, `env_file`, ...), for messages. */
  key: string;
  path: string;
}

const REMOTE = /:\/\/|^(oci:|git@|http)/i;

/**
 * Parses a compose text (YAML, and so JSON). Fails closed: a syntax error, a duplicate key, an
 * unknown alias or several documents are problems. Merge keys (`<<`) are applied like compose.
 */
export function parseComposeText(text: string): { doc: unknown; problems: string[] } {
  const fail = (m: string) => ({ doc: null, problems: [m] });
  let docs: ReturnType<typeof parseAllDocuments>;
  try {
    docs = parseAllDocuments(text, { merge: true, uniqueKeys: true, prettyErrors: false });
  } catch (err) {
    return fail(`invalid YAML: ${errorMessage(err)}`);
  }
  if (docs.length === 0) return { doc: null, problems: [] };
  if (docs.length > 1) return fail('several YAML documents in one file are not supported');
  const d = docs[0]!;
  if (d.errors.length > 0) {
    return {
      doc: null,
      problems: d.errors.map((e) => `invalid YAML: ${e.message.split('\n')[0]}`),
    };
  }
  try {
    return { doc: d.toJS({ maxAliasCount: 1000 }) as unknown, problems: [] };
  } catch (err) {
    return fail(`invalid YAML: ${errorMessage(err)}`);
  }
}

/** References of a parsed compose document. Unexpected shapes are problems (fail closed). */
function docRefs(doc: unknown): { refs: Ref[]; problems: string[]; includeDirs: string[] } {
  const refs: Ref[] = [];
  const problems: string[] = [];
  const includeDirs: string[] = [];
  const add = (kind: RefKind, key: string, v: unknown): void => {
    if (typeof v === 'string') refs.push({ kind, key, path: v });
    else problems.push(`${key}: expected a path, got ${JSON.stringify(v) ?? typeof v}`);
  };
  const envFiles = (key: string, v: unknown): void => {
    if (v === null || v === undefined) return;
    for (const item of asList(v)) add('env', key, isObj(item) ? item.path : item);
  };
  if (doc === null || doc === undefined) return { refs, problems, includeDirs };
  if (!isObj(doc)) return { refs, problems: ['compose file is not a mapping'], includeDirs };
  if (doc.include !== undefined && doc.include !== null) {
    for (const item of asList(doc.include)) {
      if (typeof item === 'string') add('file', 'include', item);
      else if (isObj(item)) {
        if (item.path === undefined) problems.push('include: entry without path');
        for (const p of asList(item.path)) add('file', 'include', p);
        envFiles('include env_file', item.env_file);
        if (item.project_directory !== undefined && item.project_directory !== null) {
          add('dir', 'include project_directory', item.project_directory);
          if (typeof item.project_directory === 'string') includeDirs.push(item.project_directory);
        }
      } else problems.push(`include: unexpected entry ${JSON.stringify(item)}`);
    }
  }
  if (doc.services !== undefined && doc.services !== null) {
    if (!isObj(doc.services)) problems.push('services: expected a mapping');
    else {
      for (const [name, svc] of Object.entries(doc.services)) {
        if (svc === null) continue;
        if (!isObj(svc)) {
          problems.push(`service "${name}": expected a mapping`);
          continue;
        }
        const ext = svc.extends;
        if (isObj(ext)) {
          if (ext.file !== undefined && ext.file !== null) add('file', 'extends file', ext.file);
        } else if (ext !== undefined && ext !== null && typeof ext !== 'string') {
          problems.push(`service "${name}": unexpected extends`);
        }
        envFiles('env_file', svc.env_file);
        if (svc.label_file !== undefined && svc.label_file !== null) {
          for (const p of asList(svc.label_file)) add('env', 'label_file', p);
        }
      }
    }
  }
  return { refs, problems, includeDirs };
}

function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

/**
 * Scans `file` and, recursively, the in-root files it includes or extends. Every referenced
 * path (include, extends file, env_file, label_file, project_directory) must resolve inside
 * `root`; remote references and references docker could interpolate are refused. The `.env`
 * docker reads implicitly next to each compose file / project directory must also resolve inside
 * `root` (a `.env` symlink to an agent file would be read for interpolation). Returns the problems.
 */
export function scanComposeSources(root: string, file: string): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  const shown = (f: string): string => relative(realPathLoose(root), realPathLoose(f)) || f;

  const envDirs = new Set<string>();
  const dotEnv = (dir: string): void => {
    if (envDirs.has(realPathLoose(dir))) return;
    envDirs.add(realPathLoose(dir));
    const f = join(dir, '.env');
    let present = false;
    try {
      lstatSync(f);
      present = true;
    } catch {
      // absent: nothing to read
    }
    if (present && !isInside(root, f))
      problems.push(`${relative(root, f) || f} resolves outside the repository`);
  };

  const scan = (f: string): void => {
    if (!isInside(root, f)) {
      problems.push(`${f} is outside the repository`);
      return;
    }
    const real = realPathLoose(f);
    if (seen.has(real)) return;
    seen.add(real);
    let text: string;
    try {
      text = stripBom(readFileSync(real, 'utf8'));
    } catch {
      problems.push(`${shown(f)} cannot be read`);
      return;
    }
    const parsed = parseComposeText(text);
    const found = docRefs(parsed.doc);
    for (const p of [...parsed.problems, ...found.problems]) problems.push(`${shown(f)}: ${p}`);
    const base = dirname(real);
    dotEnv(base);
    for (const ref of found.refs) {
      const where = `${shown(f)}: ${ref.key} "${ref.path}"`;
      if (REMOTE.test(ref.path)) {
        problems.push(`${where} is a remote reference`);
      } else if (ref.path.includes('$')) {
        problems.push(`${where} uses variable interpolation`);
      } else if (ref.path === '') {
        problems.push(`${where} is empty`);
      } else {
        const target = resolveInside(root, base, ref.path);
        if (target === null) problems.push(`${where} is outside the repository`);
        else if (ref.kind === 'file' && existsSync(target) && statSync(target).isFile())
          scan(target);
        else if (ref.kind === 'dir') dotEnv(target);
      }
    }
  };

  dotEnv(root);
  scan(isAbsolute(file) ? file : resolve(root, file));
  return problems;
}

// ---------------------------------------------------------------------------------------------
// Resolved model: allowlists
// ---------------------------------------------------------------------------------------------

const set = (...k: string[]): ReadonlySet<string> => new Set(k);

/** Service keys accepted with any value (resource limits, metadata, process settings). */
const SERVICE_FREE = set(
  'attach',
  'cap_drop', // replaced by sanitize (ALL)
  'command',
  'configs',
  'container_name', // removed by sanitize
  'cpu_count', // resource keys: replaced by sanitize (capped `cpus` / `mem_limit` / ...)
  'cpu_percent',
  'cpu_period',
  'cpu_quota',
  'cpu_shares',
  'cpus',
  'cpuset',
  'depends_on',
  'develop', // removed by sanitize (only `compose watch` reads it)
  'dns_opt',
  'dns_search',
  'domainname',
  'entrypoint',
  'environment',
  'expose',
  'group_add',
  'healthcheck',
  'hostname',
  'image',
  'init',
  'links',
  'mac_address',
  'mem_limit',
  'mem_reservation',
  'mem_swappiness',
  'memswap_limit',
  'pids_limit',
  'platform',
  'ports', // removed by sanitize
  'profiles',
  'pull_policy',
  'read_only',
  'restart', // removed by sanitize
  'secrets',
  'shm_size',
  'stdin_open',
  'stop_grace_period', // capped by sanitize
  'stop_signal',
  'tty',
  'user',
  'working_dir',
);

/**
 * Service keys only accepted when empty / false: each one grants host access or privileges
 * (devices, capabilities, runtimes, the docker API socket, GPU passthrough, provider plugins run
 * by the agent's compose CLI, ...).
 */
const SERVICE_EMPTY_ONLY = set(
  'annotations',
  'blkio_config',
  'cgroup_parent',
  'cpu_rt_period',
  'cpu_rt_runtime',
  'credential_spec',
  'device_cgroup_rules',
  'devices',
  'external_links',
  'gpus',
  'isolation',
  'models',
  'oom_kill_disable',
  'privileged',
  'provider',
  'runtime',
  'storage_opt',
  'use_api_socket',
);

/** Service keys with a dedicated check below. */
const SERVICE_CHECKED = set(
  'build',
  'cap_add',
  'cgroup',
  'deploy',
  'dns',
  'extra_hosts',
  'labels',
  'oom_score_adj',
  'scale',
  'sysctls',
  'tmpfs',
  'ulimits',
  'env_file',
  'ipc',
  'label_file',
  'logging',
  'network_mode',
  'networks',
  'pid',
  'post_start',
  'pre_stop',
  'security_opt',
  'userns_mode',
  'uts',
  'volumes',
  'volumes_from',
);

/** `no-new-privileges` (optionally `:true` / `=true` / `:false`) is the only security_opt. */
const SAFE_SECURITY_OPT = /^no-new-privileges([:=](true|false))?$/;

/**
 * Capabilities a sidecar keeps or may add. Every sidecar runs with `cap_drop: [ALL]` and gets
 * back this baseline (Docker's default set without NET_RAW, MKNOD and SETFCAP), which is what
 * the usual images need to `chown` their data directory and drop to their own user. `cap_add`
 * may only name these (or IPC_LOCK, charged to the sidecar's memory cgroup); anything else
 * (SYS_ADMIN, NET_ADMIN, NET_RAW, SYS_PTRACE, SYS_NICE for real-time scheduling, ...) is refused.
 */
export const BASELINE_CAPS: readonly string[] = [
  'AUDIT_WRITE',
  'CHOWN',
  'DAC_OVERRIDE',
  'FOWNER',
  'FSETID',
  'KILL',
  'NET_BIND_SERVICE',
  'SETGID',
  'SETPCAP',
  'SETUID',
  'SYS_CHROOT',
];
const ALLOWED_CAP_ADD: ReadonlySet<string> = new Set([...BASELINE_CAPS, 'IPC_LOCK']);
/**
 * Asked for by common examples but not needed: removed with a warning instead of refused
 * (`SYS_NICE` for MySQL only silences an mbind warning, and would allow real-time scheduling).
 */
const DROPPED_CAP_ADD: ReadonlySet<string> = new Set(['SYS_NICE']);

/** `cap_add` / `cap_drop` entries are case-insensitive, with or without the `CAP_` prefix. */
const capName = (c: unknown): string => String(c).trim().toUpperCase().replace(/^CAP_/, '');

/**
 * Resource caps applied to every sidecar by `sanitizeComposeModel`: a missing limit gets the
 * default, a larger (or unlimited) one is lowered to the cap and reported.
 */
export const SIDECAR_LIMITS = {
  memoryDefault: 2 * 1024 ** 3,
  memoryMax: 4 * 1024 ** 3,
  cpusDefault: 2,
  cpusMax: 4,
  pidsDefault: 1024,
  pidsMax: 4096,
  cpuSharesMax: 1024,
  stopGraceSecMax: 30,
  logMaxSize: '10m',
  logMaxFile: '3',
} as const;
/** At most this many services, and this many replicas (`scale`, `deploy.replicas`) of each. */
export const MAX_SERVICES = 16;
export const MAX_REPLICAS = 3;

/**
 * Namespaced sysctls only (Docker refuses the others too, this names them first). With a
 * private network namespace `net.*` only affects the sidecar.
 */
const SAFE_SYSCTL =
  /^(net\.ipv4\.|net\.ipv6\.|net\.unix\.|net\.core\.somaxconn$|fs\.mqueue\.|kernel\.(msgmax|msgmnb|msgmni|sem|shmall|shmmax|shmmni|shm_rmid_forced)$)/;

/**
 * Ulimits a sidecar may set, with the highest value accepted (null: any value, they only
 * restrict). `rtprio` / `rttime` / `nice` would let it outrank host processes; a non-zero `core`
 * makes the host's core handler write dumps; unknown names are refused.
 */
const ULIMIT_MAX: Readonly<Record<string, number | null>> = {
  as: null,
  core: 0,
  cpu: null,
  data: null,
  fsize: null,
  locks: null,
  memlock: null, // locked pages are charged to the sidecar's memory cgroup
  msgqueue: 64 * 1024 * 1024,
  nofile: 1048576,
  nproc: 65536,
  rss: null,
  sigpending: 1048576,
  stack: null,
};

/** tmpfs mount options accepted (sizes and modes; no `dev`, no propagation, no huge pages). */
const TMPFS_OPTS = set(
  'size',
  'mode',
  'uid',
  'gid',
  'nr_inodes',
  'nr_blocks',
  'noexec',
  'exec',
  'nosuid',
  'suid',
  'nodev',
  'ro',
  'rw',
  'noatime',
  'relatime',
  'nodiratime',
  'strictatime',
);

/**
 * Label prefixes owned by orch and by compose: a repo label must not make a sidecar look like
 * another task's resource (orphan cleanup, `composeRunning` and reconcile select by label).
 */
const RESERVED_LABEL = /^(orch\.|com\.docker\.compose\.)/i;

const LOGGING_OPTS = set(
  'compress',
  'env',
  'env-regex',
  'labels',
  'labels-regex',
  'max-buffer-size',
  'max-file',
  'max-size',
  'mode',
  'tag',
);

const BUILD_FREE = set(
  'additional_contexts', // checked
  'args',
  'cache_from', // checked
  'context', // checked
  'dockerfile', // checked
  'dockerfile_inline',
  'extra_hosts',
  'labels',
  'network', // checked
  'no_cache',
  'platforms',
  'provenance',
  'pull',
  'sbom',
  'shm_size',
  'target',
  'ulimits',
);
/**
 * Build keys only accepted when empty: secrets / ssh / entitlements expose agent credentials,
 * `cache_to` and `tags` write with the member's registry credentials or over their image tags.
 */
const BUILD_EMPTY_ONLY = set(
  'cache_to',
  'entitlements',
  'isolation',
  'privileged',
  'secrets',
  'ssh',
  'tags',
);

const DEPLOY_KEYS = set(
  'endpoint_mode',
  'labels',
  'mode',
  'placement',
  'replicas',
  'resources',
  'restart_policy', // removed by sanitize
  'rollback_config',
  'update_config',
);
const LIMIT_KEYS = set('cpus', 'memory', 'pids');
const RESERVATION_KEYS = set('cpus', 'memory');

const LOGGING_DRIVERS = set('json-file', 'local', 'none');
const HOOK_KEYS = set('command', 'environment', 'user', 'working_dir', 'privileged');
const SERVICE_NETWORK_KEYS = set(
  'aliases',
  'gw_priority',
  'ipv4_address',
  'ipv6_address',
  'link_local_ips',
  'mac_address',
  'priority',
);
const VOLUME_ENTRY_KEYS = set(
  'bind',
  'consistency',
  'image',
  'read_only',
  'source',
  'target',
  'tmpfs',
  'type',
  'volume',
);
const TOP_KEYS = set('name', 'networks', 'secrets', 'configs', 'services', 'volumes', 'version');
const TOP_NETWORK_KEYS = set(
  'attachable',
  'driver',
  'driver_opts',
  'enable_ipv4',
  'enable_ipv6',
  'external',
  'internal',
  'ipam',
  'labels',
  'name',
);
const TOP_VOLUME_KEYS = set('driver', 'driver_opts', 'external', 'labels', 'name');
const TOP_SECRET_KEYS = set('file', 'labels', 'name');
const TOP_CONFIG_KEYS = set('content', 'file', 'labels', 'name');

function isLocalPath(p: string): boolean {
  return !/:\/\/|^(git@|github\.com[/:]|service:|docker-image:)/i.test(p);
}

function inRoot(root: string, p: string): boolean {
  return isInside(root, isAbsolute(p) ? p : resolve(root, p));
}

/** Keys of a labels mapping or `k=v` list. */
function labelKeys(l: unknown): string[] {
  if (isObj(l)) return Object.keys(l);
  return strList(l).map((s) => (s.includes('=') ? s.slice(0, s.indexOf('=')) : s));
}

function checkLabels(where: string, l: unknown, out: string[]): void {
  if (l === undefined || l === null) return;
  if (!isObj(l) && !Array.isArray(l)) {
    out.push(`${where}: unexpected labels`);
    return;
  }
  for (const k of labelKeys(l)) {
    if (RESERVED_LABEL.test(k.trim())) out.push(`${where}: label "${k}" is reserved for orch`);
  }
}

/** `host-gateway` resolves to the host itself: refused (in services and builds). */
function checkExtraHosts(where: string, h: unknown, out: string[]): void {
  if (h === undefined || h === null) return;
  const values = isObj(h)
    ? Object.values(h).flatMap((v) => asList(v).map(String))
    : asList(h).map((e) => String(e).replace(/^[^=:]*[=:]/, ''));
  for (const v of values) {
    if (/host-gateway/i.test(v)) out.push(`${where}: extra_hosts "host-gateway" is not allowed`);
  }
}

function checkUlimits(where: string, u: unknown, out: string[]): void {
  if (u === undefined || u === null) return;
  if (!isObj(u)) {
    out.push(`${where}: unexpected ulimits`);
    return;
  }
  for (const [name, v] of Object.entries(u)) {
    if (!Object.hasOwn(ULIMIT_MAX, name)) {
      out.push(`${where}: ulimit "${name}" is not allowed`);
      continue;
    }
    const max = ULIMIT_MAX[name] ?? null;
    const vals = isObj(v) ? [v.soft, v.hard] : [v];
    for (const x of vals) {
      const n = typeof x === 'number' ? x : Number(x);
      if (!Number.isFinite(n)) out.push(`${where}: ulimit "${name}" has an unexpected value`);
      else if (max !== null && (n < 0 || n > max)) {
        out.push(`${where}: ulimit "${name}" ${n} is above the cap ${max}`);
      }
    }
  }
}

function checkSysctls(where: string, sc: unknown, out: string[]): void {
  if (sc === undefined || sc === null) return;
  const keys = isObj(sc)
    ? Object.keys(sc)
    : Array.isArray(sc)
      ? strList(sc).map((s) => s.split('=')[0] ?? '')
      : null;
  if (keys === null) {
    out.push(`${where}: unexpected sysctls`);
    return;
  }
  for (const k of keys) {
    if (!SAFE_SYSCTL.test(k.trim())) out.push(`${where}: sysctl "${k}" is not allowed`);
  }
}

/** `tmpfs: ["/run:size=10m,mode=1777"]`: only the mount options of TMPFS_OPTS. */
function checkTmpfs(where: string, t: unknown, out: string[]): void {
  if (t === undefined || t === null) return;
  for (const e of asList(t)) {
    if (typeof e !== 'string') {
      out.push(`${where}: unexpected tmpfs entry`);
      continue;
    }
    const colon = e.indexOf(':');
    if (colon < 0) continue;
    for (const opt of e.slice(colon + 1).split(',')) {
      const name = opt.split('=')[0]?.trim() ?? '';
      if (name !== '' && !TMPFS_OPTS.has(name)) {
        out.push(`${where}: tmpfs option "${name}" is not allowed`);
      }
    }
  }
}

/** `cap_add` may only name ALLOWED_CAP_ADD (sanitize drops ALL and adds the baseline back). */
function checkCaps(where: string, s: Json, out: string[]): void {
  for (const c of s.cap_add === undefined || s.cap_add === null ? [] : asList(s.cap_add)) {
    const n = capName(c);
    if (!ALLOWED_CAP_ADD.has(n) && !DROPPED_CAP_ADD.has(n))
      out.push(`${where}: cap_add "${String(c)}" is not allowed`);
  }
}

interface BindMount {
  svc: string;
  /** Absolute source path as `docker compose config` resolved it (symlinks NOT followed). */
  source: string;
  writable: boolean;
}

interface Ctx {
  root: string;
  project: string;
  topVolumes: Json;
  services: Set<string>;
  taskNetwork: string | undefined;
  /** Every service bind mount, to catch one service redirecting another's source (see below). */
  binds: BindMount[];
}

function checkVolume(svc: string, v: unknown, ctx: Ctx, out: string[]): void {
  if (!isObj(v)) {
    out.push(`${svc}: unexpected volume entry`);
    return;
  }
  unknownKeys(`${svc}: volume`, v, VOLUME_ENTRY_KEYS, out);
  const source = typeof v.source === 'string' ? v.source : '';
  const sub = (key: string, allowed: ReadonlySet<string>): Json | null => {
    const o = v[key];
    if (o === undefined || o === null) return null;
    if (!isObj(o)) {
      out.push(`${svc}: unexpected volume ${key} options`);
      return null;
    }
    unknownKeys(`${svc}: volume ${key}`, o, allowed, out);
    return o;
  };
  switch (v.type) {
    case 'bind': {
      if (source === '' || !inRoot(ctx.root, source)) {
        out.push(`${svc}: bind mount of "${source}" is outside the repository`);
      } else {
        // Recorded for the cross-service redirection check (checkBindOverlap): the source is
        // valid now, but another sidecar with a writable mount of a parent could turn it into a
        // symlink before this one mounts.
        ctx.binds.push({
          svc,
          source: isAbsolute(source) ? resolve(source) : resolve(ctx.root, source),
          writable: v.read_only !== true,
        });
      }
      // Shared propagation would carry mounts between the sidecar and the host.
      const b = sub('bind', set('create_host_path', 'propagation', 'selinux'));
      const prop = b?.propagation;
      if (prop !== undefined && prop !== null && prop !== 'private' && prop !== 'rprivate') {
        out.push(`${svc}: bind propagation "${String(prop)}" is not allowed`);
      }
      break;
    }
    case 'tmpfs':
      sub('tmpfs', set('size', 'mode'));
      break;
    case 'image':
      sub('image', set('subpath'));
      break;
    case 'volume': {
      sub('volume', set('nocopy', 'subpath'));
      if (source === '') break; // anonymous volume
      if (!isObj(ctx.topVolumes[source])) out.push(`${svc}: volume "${source}" is not defined`);
      break;
    }
    default:
      out.push(`${svc}: volume type "${String(v.type)}" is not allowed`);
  }
}

/** True when `child` is strictly below `parent` (both absolute, symlinks aside). */
function isStrictAncestor(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/**
 * `docker compose config` resolves a relative bind source to an absolute path but does NOT follow
 * symlinks; the daemon follows them on the host when the container starts. So if one sidecar gets
 * a writable bind of a directory and a *second* sidecar binds a path under it, the first can
 * replace that path with a symlink to anywhere on the host (e.g. `/`, `/etc`) before the second
 * mounts it — a host escape no static source scan can see (the symlink is planted at run time).
 * Refuse any such overlap: a writable bind source that is a strict ancestor of another service's
 * bind source. (Same-service overlaps are safe: a service cannot plant before its own mounts.)
 */
function checkBindOverlap(binds: BindMount[], out: string[]): void {
  for (const a of binds) {
    if (!a.writable) continue;
    for (const b of binds) {
      if (a.svc === b.svc) continue;
      if (isStrictAncestor(a.source, b.source)) {
        out.push(
          `${a.svc}: writable bind mount of "${a.source}" is a parent of ` +
            `${b.svc}'s bind mount "${b.source}" (it could redirect it to the host); ` +
            `use a named volume to share data between services`,
        );
      }
    }
  }
}

/**
 * The same redirection through top-level `secrets.*.file` / `configs.*.file`: the daemon binds
 * that file into every service that uses it, following symlinks on the host. A writable bind of
 * the file, or of a directory containing it, lets a service swap it for a symlink (to `/`,
 * `/etc/shadow`...) before another service (or its own restart) mounts it. Refused for every
 * service, the one using the file included.
 */
function checkTopFileOverlap(
  binds: BindMount[],
  files: Array<{ label: string; path: string }>,
  out: string[],
): void {
  for (const a of binds) {
    if (!a.writable) continue;
    for (const f of files) {
      if (a.source === f.path || isStrictAncestor(a.source, f.path)) {
        out.push(
          `${a.svc}: writable bind mount of "${a.source}" contains ${f.label} file "${f.path}" ` +
            `(it could redirect it to the host); mount it read-only or move the file`,
        );
      }
    }
  }
}

/** A cache source without `type=` is an image reference; otherwise only registry / inline. */
function safeCacheFrom(c: unknown): boolean {
  if (typeof c !== 'string') return false;
  const type = /(?:^|,)\s*type\s*=\s*([^,]*)/i.exec(c)?.[1]?.trim().toLowerCase();
  if (type === undefined) return !c.includes('=');
  return type === 'registry' || type === 'inline';
}

function checkBuild(svc: string, b: unknown, ctx: Ctx, out: string[]): void {
  if (typeof b === 'string') b = { context: b };
  if (!isObj(b)) {
    out.push(`${svc}: unexpected build definition`);
    return;
  }
  for (const [k, v] of Object.entries(b)) {
    if (BUILD_FREE.has(k) || isExtension(k)) continue;
    if (BUILD_EMPTY_ONLY.has(k)) {
      if (!isEmpty(v)) out.push(`${svc}: build ${k} is not allowed`);
    } else out.push(`${svc}: build "${k}" is not allowed`);
  }
  const root = ctx.root;
  const context = typeof b.context === 'string' ? b.context : '.';
  // Remote contexts (git, https) are refused too: the context must be the repository's own files.
  if (!isLocalPath(context)) out.push(`${svc}: remote build context "${context}" is not allowed`);
  else if (!inRoot(root, context))
    out.push(`${svc}: build context "${context}" is outside the repository`);
  if (typeof b.dockerfile === 'string') {
    if (!isLocalPath(b.dockerfile)) {
      out.push(`${svc}: remote dockerfile "${b.dockerfile}" is not allowed`);
    } else if (isLocalPath(context) && !isInside(root, resolve(root, context, b.dockerfile))) {
      out.push(`${svc}: dockerfile "${b.dockerfile}" is outside the repository`);
    }
  }
  const extra = b.additional_contexts;
  const values = isObj(extra)
    ? Object.values(extra).map((x) => String(x))
    : strList(extra).map((s) => s.slice(s.indexOf('=') + 1));
  for (const c of values) {
    // An image or another service of the project; else a directory of the repository.
    if (/^(docker-image|service|target):/i.test(c)) continue;
    if (!isLocalPath(c)) out.push(`${svc}: remote additional build context "${c}" is not allowed`);
    else if (!inRoot(root, c)) {
      out.push(`${svc}: additional build context "${c}" is outside the repository`);
    }
  }
  checkLabels(`${svc}: build labels`, b.labels, out);
  checkExtraHosts(`${svc}: build`, b.extra_hosts, out);
  checkUlimits(`${svc}: build`, b.ulimits, out);
  for (const c of b.cache_from === undefined || b.cache_from === null ? [] : asList(b.cache_from)) {
    if (!safeCacheFrom(c)) out.push(`${svc}: build cache_from "${String(c)}" is not allowed`);
  }
  if (
    b.network !== undefined &&
    b.network !== null &&
    b.network !== 'default' &&
    b.network !== 'none'
  ) {
    out.push(`${svc}: build network "${String(b.network)}" is not allowed`);
  }
}

function checkReplicas(where: string, v: unknown, out: string[]): void {
  if (v === undefined || v === null) return;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > MAX_REPLICAS) {
    out.push(`${where} ${String(v)} is above the cap ${MAX_REPLICAS}`);
  }
}

function checkDeploy(svc: string, d: unknown, out: string[]): void {
  if (d === null || d === undefined) return;
  if (!isObj(d)) {
    out.push(`${svc}: unexpected deploy definition`);
    return;
  }
  unknownKeys(`${svc}: deploy`, d, DEPLOY_KEYS, out);
  checkLabels(`${svc}: deploy labels`, d.labels, out);
  checkReplicas(`${svc}: deploy.replicas`, d.replicas, out);
  const r = d.resources;
  if (r === undefined || r === null) return;
  if (!isObj(r)) {
    out.push(`${svc}: unexpected deploy.resources`);
    return;
  }
  unknownKeys(`${svc}: deploy.resources`, r, set('limits', 'reservations'), out);
  if (isObj(r.limits)) unknownKeys(`${svc}: deploy.resources.limits`, r.limits, LIMIT_KEYS, out);
  if (isObj(r.reservations)) {
    unknownKeys(`${svc}: deploy.resources.reservations`, r.reservations, RESERVATION_KEYS, out);
  }
}

/** `service:<name>` of a service of this project. */
function isProjectService(v: string, ctx: Ctx): boolean {
  return v.startsWith('service:') && ctx.services.has(v.slice('service:'.length));
}

function checkNamespaces(svc: string, s: Json, ctx: Ctx, out: string[]): void {
  const str = (k: string): string | undefined =>
    s[k] === undefined || s[k] === null ? undefined : String(s[k]);
  const allow = (k: string, ok: (v: string) => boolean): void => {
    const v = str(k);
    if (v !== undefined && v !== '' && !ok(v)) out.push(`${svc}: ${k} "${v}" is not allowed`);
  };
  // Every other value names a host or foreign namespace (host, container:<id>, a network name).
  allow('network_mode', (v) => v === 'none' || v === ctx.taskNetwork || isProjectService(v, ctx));
  allow('pid', (v) => isProjectService(v, ctx));
  allow('ipc', (v) => ['private', 'shareable', 'none'].includes(v) || isProjectService(v, ctx));
  allow('uts', () => false);
  allow('userns_mode', () => false);
  allow('cgroup', (v) => v === 'private');
}

function checkServiceNetworks(svc: string, nets: unknown, topNetworks: Json, out: string[]): void {
  if (nets === undefined || nets === null) return;
  const entries: [string, unknown][] = Array.isArray(nets)
    ? nets.map((n) => [String(n), null])
    : isObj(nets)
      ? Object.entries(nets)
      : [];
  if (!Array.isArray(nets) && !isObj(nets)) out.push(`${svc}: unexpected networks`);
  for (const [name, def] of entries) {
    if (name !== 'default' && !isObj(topNetworks[name])) {
      out.push(`${svc}: network "${name}" is not defined`);
    }
    if (def === null || def === undefined) continue;
    if (!isObj(def)) out.push(`${svc}: unexpected network entry "${name}"`);
    else unknownKeys(`${svc}: network "${name}"`, def, SERVICE_NETWORK_KEYS, out);
  }
}

function checkFileList(svc: string, key: string, v: unknown, root: string, out: string[]): void {
  if (v === undefined || v === null) return;
  for (const item of asList(v)) {
    const p = isObj(item) ? item.path : item;
    if (typeof p !== 'string' || !inRoot(root, p)) {
      out.push(`${svc}: ${key} "${String(p)}" is outside the repository`);
    }
  }
}

function checkService(name: string, s: Json, ctx: Ctx, topNetworks: Json, out: string[]): void {
  const svc = `service "${name}"`;
  for (const [k, v] of Object.entries(s)) {
    if (SERVICE_FREE.has(k) || SERVICE_CHECKED.has(k) || isExtension(k)) continue;
    if (SERVICE_EMPTY_ONLY.has(k)) {
      if (!isEmpty(v)) out.push(`${svc}: ${k} is not allowed`);
    } else out.push(`${svc}: "${k}" is not allowed (unknown or unsupported compose key)`);
  }
  checkNamespaces(svc, s, ctx, out);
  checkServiceNetworks(svc, s.networks, topNetworks, out);
  checkCaps(svc, s, out);
  checkLabels(svc, s.labels, out);
  checkExtraHosts(svc, s.extra_hosts, out);
  checkUlimits(svc, s.ulimits, out);
  checkSysctls(svc, s.sysctls, out);
  checkTmpfs(svc, s.tmpfs, out);
  checkReplicas(`${svc}: scale`, s.scale, out);
  for (const d of s.dns === undefined || s.dns === null ? [] : asList(s.dns)) {
    if (isIP(String(d)) === 0) out.push(`${svc}: dns "${String(d)}" is not an IP address`);
  }
  if (s.oom_score_adj !== undefined && s.oom_score_adj !== null) {
    const n = Number(s.oom_score_adj);
    // A negative score makes the host's OOM killer pick the member's processes first.
    if (!Number.isInteger(n) || n < 0 || n > 1000) {
      out.push(`${svc}: oom_score_adj ${String(s.oom_score_adj)} is not allowed (0..1000)`);
    }
  }
  for (const opt of s.security_opt === undefined || s.security_opt === null
    ? []
    : asList(s.security_opt)) {
    const o = typeof opt === 'string' ? opt.toLowerCase().replace(/\s+/g, '') : '';
    if (!SAFE_SECURITY_OPT.test(o))
      out.push(`${svc}: security_opt "${String(opt)}" is not allowed`);
  }
  for (const vf of s.volumes_from === undefined || s.volumes_from === null
    ? []
    : asList(s.volumes_from)) {
    const m = typeof vf === 'string' ? /^(?:service:)?([^:]+)(?::(?:ro|rw))?$/.exec(vf) : null;
    if (!m || !ctx.services.has(m[1] as string)) {
      out.push(
        `${svc}: volumes_from "${String(vf)}" is not allowed (only services of the project)`,
      );
    }
  }
  if (s.volumes !== undefined && s.volumes !== null) {
    if (!Array.isArray(s.volumes)) out.push(`${svc}: unexpected volumes`);
    else for (const v of s.volumes) checkVolume(svc, v, ctx, out);
  }
  checkFileList(svc, 'env_file', s.env_file, ctx.root, out);
  checkFileList(svc, 'label_file', s.label_file, ctx.root, out);
  if (s.build !== undefined && s.build !== null) checkBuild(svc, s.build, ctx, out);
  checkDeploy(svc, s.deploy, out);
  if (s.logging !== undefined && s.logging !== null) {
    if (!isObj(s.logging)) out.push(`${svc}: unexpected logging`);
    else {
      unknownKeys(`${svc}: logging`, s.logging, set('driver', 'options'), out);
      const d = s.logging.driver;
      if (d !== undefined && d !== null && !LOGGING_DRIVERS.has(String(d))) {
        out.push(`${svc}: logging driver "${String(d)}" is not allowed`);
      }
      if (isObj(s.logging.options)) {
        unknownKeys(`${svc}: logging options`, s.logging.options, LOGGING_OPTS, out);
      }
    }
  }
  for (const hook of ['post_start', 'pre_stop'] as const) {
    const hooks = s[hook];
    if (hooks === undefined || hooks === null) continue;
    for (const h of asList(hooks)) {
      if (!isObj(h)) {
        out.push(`${svc}: unexpected ${hook} hook`);
        continue;
      }
      unknownKeys(`${svc}: ${hook}`, h, HOOK_KEYS, out);
      if (!isEmpty(h.privileged)) out.push(`${svc}: privileged ${hook} hook is not allowed`);
    }
  }
}

function checkTopNetworks(networks: Json, project: string, out: string[]): void {
  // Sidecars only join networks of their own project (the default one is replaced by the task
  // network): an external network would reach other tasks or the member's own containers.
  for (const [name, def] of Object.entries(networks)) {
    if (name === 'default') continue;
    const net = `network "${name}"`;
    if (!isObj(def)) {
      out.push(`${net}: unexpected definition`);
      continue;
    }
    unknownKeys(net, def, TOP_NETWORK_KEYS, out);
    checkLabels(net, def.labels, out);
    if (def.external) out.push(`${net}: external networks are not allowed`);
    else if (typeof def.name !== 'string' || !def.name.startsWith(`${project}_`)) {
      out.push(`${net}: must be named ${project}_*`);
    }
    if (def.driver !== undefined && def.driver !== null && def.driver !== 'bridge') {
      out.push(`${net}: driver "${String(def.driver)}" is not allowed`);
    }
    // e.g. com.docker.network.bridge.name=docker0 attaches to an existing host bridge.
    if (!isEmpty(def.driver_opts)) out.push(`${net}: driver_opts are not allowed`);
    const ipam = def.ipam;
    if (ipam !== undefined && ipam !== null) {
      const plain =
        isObj(ipam) &&
        Object.keys(ipam).every((k) => k === 'driver') &&
        (ipam.driver === undefined || ipam.driver === 'default');
      if (!plain) out.push(`${net}: ipam settings are not allowed`);
    }
  }
}

function checkTopVolumes(volumes: Json, project: string, out: string[]): void {
  for (const [name, def] of Object.entries(volumes)) {
    const vol = `volume "${name}"`;
    if (!isObj(def)) {
      if (def !== null) out.push(`${vol}: unexpected definition`);
      continue;
    }
    unknownKeys(vol, def, TOP_VOLUME_KEYS, out);
    checkLabels(vol, def.labels, out);
    if (def.external) out.push(`${vol}: external volumes are not allowed`);
    if (typeof def.name !== 'string' || !def.name.startsWith(`${project}_`)) {
      out.push(`${vol}: must be named ${project}_*`);
    }
    if (def.driver !== undefined && def.driver !== null && def.driver !== 'local') {
      out.push(`${vol}: driver "${String(def.driver)}" is not allowed`);
    }
    // The local driver mounts `device` with `o` (bind, nfs, ...): any option is a host mount.
    if (!isEmpty(def.driver_opts)) out.push(`${vol}: driver_opts are not allowed`);
  }
}

/**
 * Audits the resolved compose model; returns the problems (empty = acceptable). `taskNetwork` is
 * the network orch creates for the task: a service may name it in `network_mode`.
 */
export function checkComposeModel(
  model: unknown,
  root: string,
  project: string,
  taskNetwork?: string,
): string[] {
  if (!isObj(model)) return ['unexpected compose config output'];
  const out: string[] = [];
  if (model.services !== undefined && !isObj(model.services)) {
    return ['unexpected compose config output (services)'];
  }
  for (const [k, v] of Object.entries(model)) {
    if (TOP_KEYS.has(k) || isExtension(k)) continue;
    if (!isEmpty(v)) out.push(`top-level "${k}" is not allowed`);
  }
  if (model.name !== undefined && model.name !== project) {
    out.push(`project name "${String(model.name)}" is not the task project "${project}"`);
  }
  const services = isObj(model.services) ? model.services : {};
  if (Object.keys(services).length > MAX_SERVICES) {
    out.push(`${Object.keys(services).length} services: at most ${MAX_SERVICES} are allowed`);
  }
  const topVolumes = isObj(model.volumes) ? model.volumes : {};
  const topNetworks = isObj(model.networks) ? model.networks : {};
  const ctx: Ctx = {
    root,
    project,
    topVolumes,
    services: new Set(Object.keys(services)),
    taskNetwork,
    binds: [],
  };
  for (const [name, s] of Object.entries(services)) {
    if (!isObj(s)) out.push(`service "${name}": unexpected definition`);
    else checkService(name, s, ctx, topNetworks, out);
  }
  checkBindOverlap(ctx.binds, out);
  checkTopNetworks(topNetworks, project, out);
  checkTopVolumes(topVolumes, project, out);
  const files: Array<{ label: string; path: string }> = [];
  for (const kind of ['secrets', 'configs'] as const) {
    const top = model[kind];
    if (!isObj(top)) continue;
    const label = kind.slice(0, -1);
    for (const [name, def] of Object.entries(top)) {
      if (!isObj(def)) {
        out.push(`${label} "${name}": unexpected definition`);
        continue;
      }
      // `environment` reads the agent's environment, `external` a swarm object.
      unknownKeys(
        `${label} "${name}"`,
        def,
        kind === 'secrets' ? TOP_SECRET_KEYS : TOP_CONFIG_KEYS,
        out,
      );
      if (typeof def.file === 'string') {
        if (!inRoot(root, def.file)) {
          out.push(`${label} "${name}": file "${def.file}" is outside the repository`);
        }
        files.push({
          label: `${label} "${name}"`,
          path: isAbsolute(def.file) ? resolve(def.file) : resolve(root, def.file),
        });
      }
    }
  }
  checkTopFileOverlap(ctx.binds, files, out);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Sanitizing
// ---------------------------------------------------------------------------------------------

function describePort(p: unknown): string {
  if (!isObj(p)) return String(p);
  const host = typeof p.host_ip === 'string' && p.host_ip !== '' ? `${p.host_ip}:` : '';
  const target = String(p.target ?? '?');
  return p.published === undefined || p.published === ''
    ? target
    : `${host}${String(p.published)}->${target}`;
}

function labelsToObject(l: unknown): Record<string, unknown> {
  if (isObj(l)) return { ...l };
  const out: Record<string, unknown> = {};
  for (const item of strList(l)) {
    const eq = item.indexOf('=');
    if (eq < 0) out[item] = '';
    else out[item.slice(0, eq)] = item.slice(eq + 1);
  }
  return out;
}

/** Bytes of a compose size (`1073741824`, `"512m"`, `"2g"`); null when unset or unreadable. */
export function parseBytes(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*([kmgt]?)i?b?\s*$/i.exec(v);
  if (!m) return null;
  const pow = ['', 'k', 'm', 'g', 't'].indexOf((m[2] ?? '').toLowerCase());
  return Math.floor(Number(m[1]) * 1024 ** pow);
}

/** Seconds of a Go duration (`"1m30s"`, `"500ms"`); null when unreadable. */
export function parseDuration(v: unknown): number | null {
  if (typeof v === 'number') return v / 1e9; // nanoseconds
  if (typeof v !== 'string' || v.trim() === '') return null;
  const unit: Record<string, number> = { h: 3600, m: 60, s: 1, ms: 1e-3, us: 1e-6, ns: 1e-9 };
  let total = 0;
  let rest = v.trim();
  while (rest !== '') {
    const m = /^(\d+(?:\.\d+)?)(h|ms|m|s|us|ns)/.exec(rest);
    if (!m) return null;
    total += Number(m[1]) * (unit[m[2] as string] ?? 0);
    rest = rest.slice(m[0].length);
  }
  return total;
}

/** The first readable number among `vals` (resource limits come in several spellings). */
function firstNumber(...vals: (number | null)[]): number | null {
  for (const v of vals) if (v !== null && Number.isFinite(v)) return v;
  return null;
}

/**
 * Applies orch's hardening to one service of the copy: capabilities (drop ALL, add back the
 * baseline minus what the repo drops, plus its allowed `cap_add`), `no-new-privileges`, capped
 * memory / swap / CPU / pids / cpu_shares / shm, a bounded stop grace period, rotated logs and
 * no environment pass-through from the agent (`environment: [VAR]` without a value).
 */
function hardenService(name: string, s: Json, stripped: string[]): void {
  const L = SIDECAR_LIMITS;
  const drop = new Set(
    (s.cap_drop === undefined || s.cap_drop === null ? [] : asList(s.cap_drop)).map(capName),
  );
  const add = (s.cap_add === undefined || s.cap_add === null ? [] : asList(s.cap_add)).map(capName);
  const ignored = add.filter((c) => DROPPED_CAP_ADD.has(c));
  if (ignored.length > 0) stripped.push(`${name}: cap_add ${ignored.join(', ')} removed`);
  const base = drop.has('ALL') ? [] : BASELINE_CAPS.filter((c) => !drop.has(c));
  s.cap_drop = ['ALL'];
  s.cap_add = [...new Set([...base, ...add.filter((c) => ALLOWED_CAP_ADD.has(c))])].sort();

  const opts = (
    s.security_opt === undefined || s.security_opt === null ? [] : asList(s.security_opt)
  )
    .map(String)
    .filter((o) => !/^no-new-privileges/i.test(o.replace(/\s+/g, '')));
  s.security_opt = [...opts, 'no-new-privileges:true'];

  const deploy = isObj(s.deploy) ? s.deploy : null;
  const res = deploy && isObj(deploy.resources) ? deploy.resources : null;
  const limits = res && isObj(res.limits) ? res.limits : {};
  const clamp = (
    label: string,
    want: number | null,
    def: number,
    max: number,
    show: (n: number) => string = String,
  ): number => {
    if (want === null || want <= 0) return def;
    if (want > max) {
      stripped.push(`${name}: ${label} ${show(want)} lowered to ${show(max)}`);
      return max;
    }
    return want;
  };
  const gib = (b: number): string => `${Math.round((b / 1024 ** 3) * 100) / 100}g`;

  const mem = clamp(
    'memory limit',
    firstNumber(parseBytes(s.mem_limit), parseBytes(limits.memory)),
    L.memoryDefault,
    L.memoryMax,
    gib,
  );
  const quota = Number(s.cpu_quota);
  const period = Number(s.cpu_period) || 100000;
  const cpus = clamp(
    'cpus',
    firstNumber(
      s.cpus === undefined ? null : Number(s.cpus),
      limits.cpus === undefined ? null : Number(limits.cpus),
      quota > 0 ? quota / period : null,
    ),
    L.cpusDefault,
    L.cpusMax,
  );
  const pids = clamp(
    'pids limit',
    firstNumber(
      s.pids_limit === undefined ? null : Number(s.pids_limit),
      limits.pids === undefined ? null : Number(limits.pids),
    ),
    L.pidsDefault,
    L.pidsMax,
  );
  if (deploy) {
    delete deploy.resources; // replaced by the service-level keys below
    for (const [k, v] of Object.entries(deploy)) if (isEmpty(v)) delete deploy[k];
    if (Object.keys(deploy).length === 0) delete s.deploy;
  }
  for (const k of ['cpu_quota', 'cpu_period', 'cpu_count', 'cpu_percent', 'mem_reservation']) {
    delete s[k];
  }
  s.mem_limit = String(mem);
  s.memswap_limit = String(mem); // no swap on top of the memory limit
  s.cpus = cpus;
  s.pids_limit = pids;
  if (s.cpu_shares !== undefined && Number(s.cpu_shares) > L.cpuSharesMax) {
    s.cpu_shares = L.cpuSharesMax;
  }
  const shm = parseBytes(s.shm_size);
  if (shm !== null && shm > mem) s.shm_size = String(mem);

  const grace = s.stop_grace_period === undefined ? null : parseDuration(s.stop_grace_period);
  if (s.stop_grace_period !== undefined && (grace === null || grace > L.stopGraceSecMax)) {
    s.stop_grace_period = `${L.stopGraceSecMax}s`;
  }

  const logging = isObj(s.logging) ? s.logging : {};
  const driver =
    logging.driver === undefined || logging.driver === null ? 'json-file' : logging.driver;
  if (driver !== 'none') {
    s.logging = {
      driver,
      options: {
        ...(isObj(logging.options) ? logging.options : {}),
        'max-size': L.logMaxSize,
        'max-file': L.logMaxFile,
      },
    };
  }

  if (isObj(s.environment)) {
    for (const [k, v] of Object.entries(s.environment)) if (v === null) delete s.environment[k];
  }
}

/**
 * Copy of the model without published ports, fixed container names, restart policies and
 * `develop` sections, with built images tagged per project and `labels` added to every service.
 * Restart policies go so that a stopped sidecar cannot come back while the agent commits.
 */
export function sanitizeComposeModel(
  model: unknown,
  labels: Record<string, string>,
): { model: Record<string, unknown>; stripped: string[] } {
  const copy: unknown = structuredClone(model);
  const stripped: string[] = [];
  if (!isObj(copy)) return { model: {}, stripped };
  if (isObj(copy.services)) {
    for (const [name, s] of Object.entries(copy.services)) {
      if (!isObj(s)) continue;
      if (Array.isArray(s.ports) && s.ports.length > 0) {
        stripped.push(`${name}: published ports ${s.ports.map(describePort).join(', ')} removed`);
      }
      delete s.ports;
      // A fixed container name is global on the daemon: it collides with the member's own stack
      // of the same repo and with a parallel task. Keep it reachable as a network alias.
      if (typeof s.container_name === 'string' && s.container_name !== '') {
        const cn = s.container_name;
        stripped.push(`${name}: container_name "${cn}" removed (kept as a network alias)`);
        if (s.network_mode === undefined) {
          const nets: Record<string, unknown> = isObj(s.networks) ? s.networks : { default: null };
          for (const [k, v] of Object.entries(nets)) {
            const net = isObj(v) ? v : {};
            const aliases = Array.isArray(net.aliases) ? net.aliases : [];
            nets[k] = { ...net, aliases: [...aliases, cn] };
          }
          s.networks = nets;
        }
      }
      delete s.container_name;
      const restart = typeof s.restart === 'string' && s.restart !== 'no';
      const policy = isObj(s.deploy) && s.deploy.restart_policy !== undefined;
      if (restart || policy) stripped.push(`${name}: restart policy removed`);
      delete s.restart;
      if (isObj(s.deploy)) delete s.deploy.restart_policy;
      delete s.develop;
      // `config` already folded env_file into `environment`, but it keeps `label_file`, which
      // `up` would read again from the clone. Drop it: the labels are already resolved below, and
      // a re-read lets a file swapped after validation inject reserved (orch.*) labels.
      delete s.label_file;
      s.labels = { ...labelsToObject(s.labels), ...labels };
      hardenService(name, s, stripped);
    }
    // The default network is replaced by the task network (see the executor's override).
    if (isObj(copy.networks)) delete copy.networks.default;
    // A built service tags its image with `image:`: never overwrite the member's own tag (e.g.
    // the published image of the repo, used by the member's own stack). Without `image:` compose
    // names it `<project>-<service>` and `down --rmi local` removes it. Services that run the
    // built image by its old name follow.
    const project = typeof copy.name === 'string' ? copy.name : '';
    const renamed = new Map<string, string>();
    for (const [name, s] of Object.entries(copy.services)) {
      if (!isObj(s) || s.build === undefined || s.image === undefined) continue;
      const tag = `${project}-${name}`;
      if (typeof s.image === 'string') {
        renamed.set(s.image, tag);
        stripped.push(`${name}: built as "${tag}" instead of "${s.image}"`);
      }
      delete s.image;
    }
    for (const s of Object.values(copy.services)) {
      if (isObj(s) && s.build === undefined && typeof s.image === 'string') {
        s.image = renamed.get(s.image) ?? s.image;
      }
    }
  }
  return { model: copy, stripped };
}

// ---------------------------------------------------------------------------------------------
// Missing env_file tolerance
// ---------------------------------------------------------------------------------------------

const ENV_EXAMPLES = ['.env.example', '.env.sample', '.env.template'];

/** `env_file` paths per service of a parsed compose document (services with odd shapes skipped). */
function serviceEnvFiles(doc: unknown): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (!isObj(doc) || !isObj(doc.services)) return out;
  for (const [name, svc] of Object.entries(doc.services)) {
    if (!isObj(svc) || svc.env_file === undefined || svc.env_file === null) continue;
    const paths = asList(svc.env_file).map((i) => (isObj(i) ? i.path : i));
    if (paths.length > 0 && paths.every((p): p is string => typeof p === 'string')) {
      out.set(name, paths);
    }
  }
  return out;
}

const yamlStr = (s: string): string => JSON.stringify(s);

/**
 * A repository's `.env` is usually gitignored, so a fresh clone lacks the file a service names in
 * `env_file`, and docker refuses to load the model. For each in-clone entry that is missing, this
 * plans a compose override (never a file in the clone): the entry is replaced by a sibling
 * `.env.example` / `.env.sample` / `.env.template` when there is one, else dropped. Entries outside
 * the clone are left alone (the source scan refuses them). Returns the override text (null when
 * nothing is missing) and one warning per missing file.
 */
export function planEnvFileFallbacks(
  root: string,
  file: string,
): { override: string | null; warnings: string[] } {
  const none = { override: null, warnings: [] };
  const f = isAbsolute(file) ? file : resolve(root, file);
  let text: string;
  try {
    text = stripBom(readFileSync(realPathLoose(f), 'utf8'));
  } catch {
    return none;
  }
  const parsed = parseComposeText(text);
  if (parsed.problems.length > 0) return none;
  const base = dirname(realPathLoose(f));
  const shown = (p: string): string => relative(realPathLoose(root), p) || p;
  const warnings: string[] = [];
  const blocks: string[] = [];
  for (const [svc, paths] of serviceEnvFiles(parsed.doc)) {
    const keep: string[] = [];
    let changed = false;
    for (const p of paths) {
      if (REMOTE.test(p) || p.includes('$') || p === '') return none;
      const target = resolveInside(root, base, p);
      if (target === null) {
        keep.push(p); // outside the clone: refused by the source scan
        continue;
      }
      if (existsSync(target)) {
        keep.push(target);
        continue;
      }
      changed = true;
      const dir = dirname(target);
      const example = ENV_EXAMPLES.map((n) => resolveInside(root, dir, n)).find(
        (c): c is string => c !== null && existsSync(c) && statSync(c).isFile(),
      );
      const label = shown(target);
      if (example) {
        keep.push(example);
        warnings.push(
          `env file ${label} not found in the repository; using ${shown(example)} instead.`,
        );
      } else {
        warnings.push(
          `env file ${label} not found in the repository; continuing without it. Commit a .env.example or make it optional.`,
        );
      }
    }
    if (changed) {
      const items = keep.map((k) => `        - path: ${yamlStr(k)}\n          required: false`);
      blocks.push(
        `  ${yamlStr(svc)}:\n    env_file: !override${items.length ? `\n${items.join('\n')}` : ' []'}\n`,
      );
    }
  }
  if (blocks.length === 0) return none;
  return {
    override: `# Written by orch: tolerate env files missing from the clone.\nservices:\n${blocks.join('')}`,
    warnings,
  };
}
