/**
 * Guard for a task repository's compose file (sidecar services). The agent holds the host docker
 * socket, so a compose file that mounts host paths, joins host namespaces or adds privileges is
 * root on the host. Two layers:
 *  1. `scanComposeSources`: raw-text pre-scan, run BEFORE docker reads anything, that follows
 *     `include` / `extends` / `env_file` references and refuses remote or out-of-root ones
 *     (docker itself would read those files while building the model);
 *  2. `checkComposeModel`: audit of the resolved model from `docker compose config --format json`.
 * `sanitizeComposeModel` then strips published ports and adds our labels, and the sanitized model
 * is what actually gets run. There is no YAML library on purpose: the scan is a small
 * indentation-based extractor that fails closed when it cannot understand a reference block.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
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

// ---------------------------------------------------------------------------------------------
// Raw-text scan
// ---------------------------------------------------------------------------------------------

/** What a reference is for: `file` ones are scanned recursively, `dir` / `env` only contained. */
type RefKind = 'file' | 'dir' | 'env';

interface Ref {
  kind: RefKind;
  /** The key it came from (`include`, `extends`, `env_file`), for messages. */
  key: string;
  path: string;
}

const REMOTE = /:\/\/|^(oci:|git@|http)/i;

function unquote(s: string): string {
  const t = s.trim();
  if (t.length >= 2 && (t[0] === '"' || t[0] === "'") && t.endsWith(t[0] as string)) {
    return t.slice(1, -1);
  }
  return t;
}

/** Splits `a, [b, c], {d: e}` at top-level commas. */
function splitFlow(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = '';
  let cur = '';
  for (const ch of s) {
    if (quote) {
      if (ch === quote) quote = '';
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '[' || ch === '{') depth++;
    else if (ch === ']' || ch === '}') depth--;
    if (ch === ',' && depth === 0 && !quote) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out.map((x) => x.trim()).filter((x) => x !== '');
}

/** Maps a reference key to the kind of reference its value is (null = not a path key). */
type KeyKinds = Record<string, RefKind>;

const INCLUDE_KEYS: KeyKinds = { path: 'file', env_file: 'env', project_directory: 'dir' };
const EXTENDS_KEYS: KeyKinds = { file: 'file' };
const ENV_KEYS: KeyKinds = { path: 'env' };

/**
 * Paths found in an inline value: a scalar (when `scalarKind` is set), a flow list, or a flow
 * map whose known keys hold paths. Anything fancier (alias, anchor, tag, block scalar) is a problem.
 */
function inlineRefs(
  value: string,
  keys: KeyKinds,
  scalarKind: RefKind | null,
  key: string,
  out: Ref[],
  problems: string[],
): void {
  const v = value.trim();
  if (v === '') return;
  if (/^[*&!|>]/.test(v)) {
    problems.push(`${key}: unsupported YAML construct "${v}"`);
  } else if (v.startsWith('[') && v.endsWith(']')) {
    for (const item of splitFlow(v.slice(1, -1)))
      inlineRefs(item, keys, scalarKind, key, out, problems);
  } else if (v.startsWith('{') && v.endsWith('}')) {
    for (const pair of splitFlow(v.slice(1, -1))) {
      const m = /^(["']?)([\w.<-]+)\1\s*:\s*(.*)$/.exec(pair);
      if (!m) {
        problems.push(`${key}: cannot parse "${pair}"`);
        continue;
      }
      const kind = keys[m[2] as string];
      if (kind) inlineRefs(m[3] ?? '', keys, kind, key, out, problems);
    }
  } else if (v.startsWith('[') || v.startsWith('{')) {
    problems.push(`${key}: cannot parse "${v}"`);
  } else if (scalarKind) {
    out.push({ kind: scalarKind, key, path: unquote(v) });
  }
}

interface Line {
  indent: number;
  text: string;
}

/** Non-blank, comment-free lines of a YAML text. */
function yamlLines(text: string): Line[] {
  const out: Line[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const noComment = /["']/.test(raw) ? raw : raw.replace(/(^|\s)#.*$/, '');
    const t = noComment.trimEnd();
    if (t.trim() === '' || t.trim() === '---') continue;
    out.push({ indent: t.length - t.trimStart().length, text: t.trim() });
  }
  return out;
}

/**
 * Extracts the references of the block opened by `key:` at line `i`. Returns the index of the
 * first line after the block.
 */
function blockRefs(
  lines: Line[],
  i: number,
  key: string,
  keys: KeyKinds,
  scalarKind: RefKind | null,
  out: Ref[],
  problems: string[],
): number {
  const head = lines[i] as Line;
  const m = /^(?:-\s+)?["']?[\w.-]+["']?\s*:\s*(.*)$/.exec(head.text);
  const inline = m?.[1] ?? '';
  const before = out.length + problems.length;
  if (inline !== '') {
    inlineRefs(inline, keys, scalarKind, key, out, problems);
    return i + 1;
  }
  // Block form: deeper lines, or `- item` lines at the key's own indent.
  let j = i + 1;
  let nested: RefKind | null = null;
  while (j < lines.length) {
    const l = lines[j] as Line;
    const sameIndentItem = l.indent === head.indent && l.text.startsWith('-');
    if (l.indent <= head.indent && !sameIndentItem) break;
    j++;
    const content = l.text.replace(/^-\s*/, '');
    const isItem = l.text.startsWith('-');
    const kv = /^["']?([\w.<-]+)["']?\s*:(?:\s+(.*))?$/.exec(content);
    if (kv) {
      const kind = keys[kv[1] as string];
      if (kv[1] === '<<') problems.push(`${key}: unsupported YAML merge key`);
      else if (kind) {
        const val = kv[2] ?? '';
        if (val === '') nested = kind;
        else inlineRefs(val, keys, kind, key, out, problems);
      }
    } else if (/^[*&!|>]/.test(content)) {
      problems.push(`${key}: unsupported YAML construct "${content}"`);
    } else if (isItem) {
      // A plain `- value` item: a path, unless it is a service-name style scalar we ignore.
      inlineRefs(content, keys, nested ?? scalarKind, key, out, problems);
    } else if (nested) {
      inlineRefs(content, keys, nested, key, out, problems);
    }
  }
  if (key !== 'extends' && out.length + problems.length === before) {
    problems.push(`${key}: cannot understand this block (no path found)`);
  }
  return j;
}

/** References (and parse problems) of a YAML compose text. */
function yamlRefs(text: string): { refs: Ref[]; problems: string[] } {
  const refs: Ref[] = [];
  const problems: string[] = [];
  const lines = yamlLines(text);
  for (let i = 0; i < lines.length; i++) {
    const m = /^(?:-\s+)?["']?(include|extends|env_file)["']?\s*:/.exec((lines[i] as Line).text);
    if (!m) {
      // Flow-style top-level map: `{include: [...], services: {...}}`.
      if (/^\{.*["']?(include|extends|env_file)["']?\s*:/.test((lines[i] as Line).text)) {
        problems.push('flow-style compose document is not supported');
      }
      continue;
    }
    const key = m[1] as string;
    if (key === 'include') {
      // Top-level only; a service attribute with that name is harmless but scanned anyway.
      blockRefs(lines, i, key, INCLUDE_KEYS, 'file', refs, problems);
    } else if (key === 'extends') {
      const inline = /:\s*(.*)$/.exec((lines[i] as Line).text)?.[1] ?? '';
      // `extends: web` (service of the same file) has no path to follow.
      if (inline !== '' && !/^[{[*&!|>]/.test(inline)) continue;
      blockRefs(lines, i, key, EXTENDS_KEYS, null, refs, problems);
    } else {
      blockRefs(lines, i, key, ENV_KEYS, 'env', refs, problems);
    }
  }
  return { refs, problems };
}

/** References of a JSON compose document (parsed structurally). */
function jsonRefs(doc: unknown): { refs: Ref[]; problems: string[] } {
  const refs: Ref[] = [];
  const problems: string[] = [];
  const add = (kind: RefKind, key: string, v: unknown): void => {
    if (typeof v === 'string') refs.push({ kind, key, path: v });
    else problems.push(`${key}: unexpected value`);
  };
  const envFile = (v: unknown): void => {
    for (const item of Array.isArray(v) ? v : [v]) {
      if (isObj(item)) add('env', 'env_file', item.path);
      else add('env', 'env_file', item);
    }
  };
  if (!isObj(doc)) return { refs, problems: ['compose file is not a JSON object'] };
  if (doc.include !== undefined) {
    for (const item of Array.isArray(doc.include) ? doc.include : [doc.include]) {
      if (typeof item === 'string') add('file', 'include', item);
      else if (isObj(item)) {
        for (const p of Array.isArray(item.path) ? item.path : [item.path])
          add('file', 'include', p);
        if (item.env_file !== undefined) envFile(item.env_file);
        if (item.project_directory !== undefined) add('dir', 'include', item.project_directory);
      } else problems.push('include: unexpected value');
    }
  }
  if (isObj(doc.services)) {
    for (const svc of Object.values(doc.services)) {
      if (!isObj(svc)) continue;
      if (isObj(svc.extends) && svc.extends.file !== undefined)
        add('file', 'extends', svc.extends.file);
      if (svc.env_file !== undefined) envFile(svc.env_file);
    }
  }
  return { refs, problems };
}

function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

/**
 * Scans `file` and, recursively, the in-root files it includes or extends. Every referenced
 * path (include, extends file, env_file, project_directory) must resolve inside `root`; remote
 * references and references docker could interpolate are refused. Returns the problems.
 */
export function scanComposeSources(root: string, file: string): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  const shown = (f: string): string => relative(realPathLoose(root), realPathLoose(f)) || f;

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
    let found: { refs: Ref[]; problems: string[] };
    if (/^\s*\{/.test(text)) {
      try {
        found = jsonRefs(JSON.parse(text));
      } catch {
        found = yamlRefs(text);
      }
    } else found = yamlRefs(text);
    for (const p of found.problems) problems.push(`${shown(f)}: ${p}`);
    const base = dirname(real);
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
      }
    }
  };

  scan(isAbsolute(file) ? file : resolve(root, file));
  return problems;
}

// ---------------------------------------------------------------------------------------------
// Resolved model
// ---------------------------------------------------------------------------------------------

const UNSAFE_SECURITY_OPT = /^(apparmor|seccomp|label|systempaths)[=:](unconfined|disable)$/;

function isLocalPath(p: string): boolean {
  return !/:\/\/|^(git@|github\.com[/:]|service:|docker-image:)/i.test(p);
}

function inRoot(root: string, p: string): boolean {
  return isInside(root, isAbsolute(p) ? p : resolve(root, p));
}

function checkVolume(
  name: string,
  v: unknown,
  root: string,
  project: string,
  topVolumes: Json,
  out: string[],
): void {
  const svc = `service "${name}"`;
  if (!isObj(v)) {
    out.push(`${svc}: unexpected volume entry`);
    return;
  }
  const source = typeof v.source === 'string' ? v.source : '';
  switch (v.type) {
    case 'bind':
      if (source === '' || !inRoot(root, source)) {
        out.push(`${svc}: bind mount of "${source}" is outside the repository`);
      }
      break;
    case 'tmpfs':
    case 'image':
      break;
    case 'npipe':
      out.push(`${svc}: npipe mounts are not allowed`);
      break;
    case 'volume': {
      if (source === '') break; // anonymous volume
      const def = topVolumes[source];
      if (!isObj(def)) {
        out.push(`${svc}: volume "${source}" is not defined`);
        break;
      }
      if (def.external) out.push(`${svc}: external volume "${source}" is not allowed`);
      if (typeof def.name !== 'string' || !def.name.startsWith(`${project}_`)) {
        out.push(`${svc}: volume "${source}" must be named ${project}_*`);
      }
      const opts = isObj(def.driver_opts) ? def.driver_opts : {};
      const o = typeof opts.o === 'string' ? opts.o : '';
      if (opts.device !== undefined || /\bbind\b/.test(o)) {
        out.push(`${svc}: volume "${source}" binds a host path through driver_opts`);
      }
      break;
    }
    default:
      out.push(`${svc}: unsupported volume type "${String(v.type)}"`);
  }
}

function checkBuild(name: string, b: unknown, root: string, out: string[]): void {
  const svc = `service "${name}"`;
  if (typeof b === 'string') b = { context: b };
  if (!isObj(b)) return;
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
  const nonEmpty = (x: unknown): boolean =>
    Array.isArray(x) ? x.length > 0 : isObj(x) ? Object.keys(x).length > 0 : Boolean(x);
  if (nonEmpty(b.secrets)) out.push(`${svc}: build secrets are not allowed`);
  if (nonEmpty(b.ssh)) out.push(`${svc}: build ssh forwarding is not allowed`);
  if (nonEmpty(b.entitlements)) out.push(`${svc}: build entitlements are not allowed`);
  if (b.privileged === true) out.push(`${svc}: privileged build is not allowed`);
  if (b.network === 'host') out.push(`${svc}: build network host is not allowed`);
}

function checkService(
  name: string,
  s: Json,
  root: string,
  project: string,
  topVolumes: Json,
  out: string[],
): void {
  const svc = `service "${name}"`;
  if (s.privileged === true) out.push(`${svc}: privileged is not allowed`);
  if (Array.isArray(s.cap_add) && s.cap_add.length > 0) out.push(`${svc}: cap_add is not allowed`);
  if (Array.isArray(s.devices) && s.devices.length > 0) out.push(`${svc}: devices are not allowed`);
  for (const key of ['pid', 'ipc'] as const) {
    const v = s[key];
    if (v === 'host' || (typeof v === 'string' && v.startsWith('container:'))) {
      out.push(`${svc}: ${key} "${String(v)}" is not allowed`);
    }
  }
  for (const key of ['uts', 'userns_mode', 'cgroup'] as const) {
    if (s[key] === 'host') out.push(`${svc}: ${key} host is not allowed`);
  }
  const nm = s.network_mode;
  if (typeof nm === 'string' && (nm === 'host' || nm.startsWith('container:'))) {
    out.push(`${svc}: network_mode "${nm}" is not allowed`);
  }
  for (const opt of strList(s.security_opt)) {
    if (UNSAFE_SECURITY_OPT.test(opt.toLowerCase().replace(/\s+/g, ''))) {
      out.push(`${svc}: security_opt "${opt}" is not allowed`);
    }
  }
  for (const vf of strList(s.volumes_from)) {
    if (vf.startsWith('container:')) out.push(`${svc}: volumes_from "${vf}" is not allowed`);
  }
  if (s.runtime) out.push(`${svc}: runtime is not allowed`);
  if (s.cgroup_parent) out.push(`${svc}: cgroup_parent is not allowed`);
  if (Array.isArray(s.volumes)) {
    for (const v of s.volumes) checkVolume(name, v, root, project, topVolumes, out);
  }
  if (s.env_file !== undefined) {
    for (const item of Array.isArray(s.env_file) ? s.env_file : [s.env_file]) {
      const p = isObj(item) ? item.path : item;
      if (typeof p !== 'string' || !inRoot(root, p)) {
        out.push(`${svc}: env_file "${String(p)}" is outside the repository`);
      }
    }
  }
  if (s.build !== undefined) checkBuild(name, s.build, root, out);
}

/** Audits the resolved compose model; returns the problems (empty = acceptable). */
export function checkComposeModel(model: unknown, root: string, project: string): string[] {
  if (!isObj(model)) return ['unexpected compose config output'];
  const out: string[] = [];
  const topVolumes = isObj(model.volumes) ? model.volumes : {};
  if (model.services !== undefined && !isObj(model.services)) {
    return ['unexpected compose config output (services)'];
  }
  for (const [name, s] of Object.entries(isObj(model.services) ? model.services : {})) {
    if (!isObj(s)) out.push(`service "${name}": unexpected definition`);
    else checkService(name, s, root, project, topVolumes, out);
  }
  for (const kind of ['secrets', 'configs'] as const) {
    const top = model[kind];
    if (!isObj(top)) continue;
    for (const [name, def] of Object.entries(top)) {
      if (isObj(def) && typeof def.file === 'string' && !inRoot(root, def.file)) {
        out.push(`${kind.slice(0, -1)} "${name}": file "${def.file}" is outside the repository`);
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

/** Copy of the model without published ports and with `labels` added to every service. */
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
      s.labels = { ...labelsToObject(s.labels), ...labels };
    }
  }
  return { model: copy, stripped };
}

// ---------------------------------------------------------------------------------------------
// Missing env_file tolerance
// ---------------------------------------------------------------------------------------------

const ENV_EXAMPLES = ['.env.example', '.env.sample', '.env.template'];

/** `env_file` paths per service of a YAML compose text (only what the scanner understands). */
function serviceEnvFiles(text: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const lines = yamlLines(text);
  const top = lines.findIndex((l) => l.indent === 0 && /^services\s*:\s*$/.test(l.text));
  if (top < 0) return out;
  const svcIndent = lines[top + 1]?.indent ?? 0;
  if (svcIndent === 0) return out;
  let name = '';
  for (let i = top + 1; i < lines.length; i++) {
    const l = lines[i] as Line;
    if (l.indent === 0) break;
    if (l.indent === svcIndent) {
      name = /^["']?([\w.-]+)["']?\s*:/.exec(l.text)?.[1] ?? '';
    } else if (name !== '' && /^env_file["']?\s*:/.test(l.text)) {
      const refs: Ref[] = [];
      const problems: string[] = [];
      blockRefs(lines, i, 'env_file', ENV_KEYS, 'env', refs, problems);
      if (problems.length === 0 && refs.length > 0)
        out.set(
          name,
          refs.map((r) => r.path),
        );
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
  if (/^\s*\{/.test(text)) return none;
  const base = dirname(realPathLoose(f));
  const shown = (p: string): string => relative(realPathLoose(root), p) || p;
  const warnings: string[] = [];
  const blocks: string[] = [];
  for (const [svc, paths] of serviceEnvFiles(text)) {
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
