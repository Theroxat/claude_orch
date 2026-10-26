/**
 * Catalog check, run by `pnpm test` (and `pnpm i18n:check`): fails when a locale misses or adds
 * a key, when a translation drops a placeholder or tag, when French typography slips, or when an
 * English key is no longer used anywhere in src/. Run with Node's type stripping (Node >= 22.18).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import en from '../src/i18n/locales/en/index.ts';
import fr from '../src/i18n/locales/fr/index.ts';

type Node = string | { [k: string]: Node };
const SRC = fileURLToPath(new URL('../src', import.meta.url));
const PLURAL_FORMS = new Set(['zero', 'one', 'two', 'few', 'many', 'other']);

const isPlural = (v: Node): v is Record<string, string> =>
  typeof v === 'object' &&
  'other' in v &&
  Object.entries(v).every(([k, x]) => PLURAL_FORMS.has(k) && typeof x === 'string');

/** key → list of strings (one for a message, one per form for a plural). */
function flatten(tree: Node, prefix = '', out = new Map<string, string[]>()) {
  if (typeof tree === 'string') out.set(prefix, [tree]);
  else if (isPlural(tree)) out.set(prefix, Object.values(tree));
  else for (const [k, v] of Object.entries(tree)) flatten(v, prefix ? `${prefix}.${k}` : k, out);
  return out;
}

const tokens = (forms: string[]) =>
  new Set(forms.flatMap((s) => [...s.matchAll(/\{(\w+)\}|<\/?(\w+)>/g)].map((m) => m[0])));

const errors: string[] = [];
const enKeys = flatten(en as Node);
const frKeys = flatten(fr as Node);

for (const [key, forms] of enKeys) {
  const frForms = frKeys.get(key);
  if (!frForms) {
    errors.push(`fr: missing key ${key}`);
    continue;
  }
  const want = tokens(forms);
  const got = tokens(frForms);
  // A plural's singular form may spell the number out ("une tâche"), so {count} is optional.
  for (const tk of want)
    if (!got.has(tk) && tk !== '{count}') errors.push(`fr: ${key} lacks ${tk}`);
  for (const tk of got) if (!want.has(tk)) errors.push(`fr: ${key} has unknown ${tk}`);
  for (const s of frForms) {
    if (/ [:;!?»]|« /.test(s))
      errors.push(`fr: ${key} needs a no-break space (U+00A0) around : ; ! ? « »: "${s}"`);
    if (s.includes("'")) errors.push(`fr: ${key} uses ' instead of the apostrophe ’: "${s}"`);
    if (s.includes('...')) errors.push(`fr: ${key} uses ... instead of …: "${s}"`);
  }
}
for (const key of frKeys.keys()) if (!enKeys.has(key)) errors.push(`fr: unknown key ${key}`);

// Usage: every key must appear as a string literal in src/ (tests and catalogs excluded), or be
// covered by a template literal prefix such as `backlog.status.${s}`.
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return p.endsWith(join('i18n', 'locales')) ? [] : sources(p);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [p] : [];
  });
}
const ns = Object.keys(en).join('|');
const LITERAL = new RegExp(`(['"\`])((?:${ns})\\.[\\w.]*\\w)\\1`, 'g');
const PREFIX = new RegExp(`\`((?:${ns})\\.(?:\\w+\\.)*)\\$\\{`, 'g');
const literals = new Set<string>();
const prefixes = new Set<string>();
for (const file of sources(SRC)) {
  const code = readFileSync(file, 'utf8');
  for (const m of code.matchAll(PREFIX)) prefixes.add(m[1] as string);
  for (const m of code.matchAll(LITERAL)) {
    const s = m[2] as string;
    literals.add(s);
    if (!enKeys.has(s) && ![...enKeys.keys()].some((k) => k.startsWith(`${s}.`)))
      errors.push(`${relative(SRC, file)}: unknown key ${s}`);
  }
}
for (const key of enKeys.keys()) {
  if (literals.has(key) || [...prefixes].some((p) => key.startsWith(p))) continue;
  errors.push(`en: unused key ${key}`);
}

if (errors.length) {
  console.error(`i18n check failed (${errors.length}):\n  ${errors.join('\n  ')}`);
  process.exit(1);
}
console.log(`i18n check passed: ${enKeys.size} messages, locales en and fr.`);
