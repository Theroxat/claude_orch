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
 * `sanitizeComposeModel` then strips published ports and restart policies and adds our labels,
 * and the sanitized model is what actually gets run.
 */
import { existsSync, lstatSync, readFileSync, statSync } from 'node:fs';
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
  'cap_drop',
  'command',
  'configs',
  'container_name', // removed by sanitize
  'cpu_count',
  'cpu_percent',
  'cpu_period',
  'cpu_quota',
  'cpu_shares',
  'cpus',
  'cpuset',
  'depends_on',
  'develop', // removed by sanitize (only `compose watch` reads it)
  'dns',
  'dns_opt',
  'dns_search',
  'domainname',
  'entrypoint',
  'environment',
  'expose',
  'extra_hosts',
  'group_add',
  'healthcheck',
  'hostname',
  'image',
  'init',
  'labels',
  'links',
  'mac_address',
  'mem_limit',
  'mem_reservation',
  'mem_swappiness',
  'memswap_limit',
  'oom_score_adj',
  'pids_limit',
  'platform',
  'ports', // removed by sanitize
  'profiles',
  'pull_policy',
  'read_only',
  'restart', // removed by sanitize
  'scale',
  'secrets',
  'shm_size',
  'stdin_open',
  'stop_grace_period',
  'stop_signal',
  'sysctls',
  'tmpfs',
  'tty',
  'ulimits',
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
  'cap_add',
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
  'cgroup',
  'deploy',
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

interface Ctx {
  root: string;
  project: string;
  topVolumes: Json;
  services: Set<string>;
  taskNetwork: string | undefined;
}

function checkVolume(svc: string, v: unknown, ctx: Ctx, out: string[]): void {
  if (!isObj(v)) {
    out.push(`${svc}: unexpected volume entry`);
    return;
  }
  unknownKeys(`${svc}: volume`, v, VOLUME_ENTRY_KEYS, out);
  const source = typeof v.source === 'string' ? v.source : '';
  switch (v.type) {
    case 'bind':
      if (source === '' || !inRoot(ctx.root, source)) {
        out.push(`${svc}: bind mount of "${source}" is outside the repository`);
      }
      break;
    case 'tmpfs':
    case 'image':
      break;
    case 'volume': {
      if (source === '') break; // anonymous volume
      if (!isObj(ctx.topVolumes[source])) out.push(`${svc}: volume "${source}" is not defined`);
      break;
    }
    default:
      out.push(`${svc}: volume type "${String(v.type)}" is not allowed`);
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
  const local = isLocalPath(context);
  if (local && !inRoot(root, context))
    out.push(`${svc}: build context "${context}" is outside the repository`);
  if (local && typeof b.dockerfile === 'string') {
    const df = resolve(root, context, b.dockerfile);
    if (!isInside(root, df))
      out.push(`${svc}: dockerfile "${b.dockerfile}" is outside the repository`);
  }
  const extra = b.additional_contexts;
  const values = isObj(extra)
    ? Object.values(extra).filter((x): x is string => typeof x === 'string')
    : strList(extra).map((s) => s.slice(s.indexOf('=') + 1));
  for (const c of values) {
    if (isLocalPath(c) && !inRoot(root, c)) {
      out.push(`${svc}: additional build context "${c}" is outside the repository`);
    }
  }
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

function checkDeploy(svc: string, d: unknown, out: string[]): void {
  if (d === null || d === undefined) return;
  if (!isObj(d)) {
    out.push(`${svc}: unexpected deploy definition`);
    return;
  }
  unknownKeys(`${svc}: deploy`, d, DEPLOY_KEYS, out);
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
  const services = isObj(model.services) ? model.services : {};
  const topVolumes = isObj(model.volumes) ? model.volumes : {};
  const topNetworks = isObj(model.networks) ? model.networks : {};
  const ctx: Ctx = {
    root,
    project,
    topVolumes,
    services: new Set(Object.keys(services)),
    taskNetwork,
  };
  for (const [name, s] of Object.entries(services)) {
    if (!isObj(s)) out.push(`service "${name}": unexpected definition`);
    else checkService(name, s, ctx, topNetworks, out);
  }
  checkTopNetworks(topNetworks, project, out);
  checkTopVolumes(topVolumes, project, out);
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
      if (typeof def.file === 'string' && !inRoot(root, def.file)) {
        out.push(`${label} "${name}": file "${def.file}" is outside the repository`);
      }
    }
  }
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
      s.labels = { ...labelsToObject(s.labels), ...labels };
    }
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
