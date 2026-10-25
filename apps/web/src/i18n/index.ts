import { Fragment, createElement, useSyncExternalStore, type ReactNode } from 'react';
import en from './locales/en/index.ts';
import type { ArgsFor, At, Leaf, ParamValue, Paths, Plural, Tree } from './types.ts';

export type Locale = 'en' | 'fr';
export type Messages = typeof en;
export type MessageKey = Paths<Messages>;
type Args<K extends MessageKey, V = ParamValue> = ArgsFor<At<Messages, K>, V>;

export const DEFAULT_LOCALE: Locale = 'en';
export const LOCALES: readonly Locale[] = ['en', 'fr'];
/** Each language named in itself, for the switcher. */
export const LOCALE_NAMES: Record<Locale, string> = { en: 'English', fr: 'Français' };
/** BCP 47 tags handed to `Intl`. */
const INTL_TAG: Record<Locale, string> = { en: 'en-US', fr: 'fr-FR' };
export const STORAGE_KEY = 'orch.locale';

// English ships in the main bundle; every other locale is a lazy chunk loaded on demand.
const loaders: Record<Exclude<Locale, 'en'>, () => Promise<{ default: Tree }>> = {
  fr: () => import('./locales/fr/index.ts'),
};
const catalogs: Partial<Record<Locale, Tree>> = { en };

let current: Locale = DEFAULT_LOCALE;
const listeners = new Set<() => void>();

const isLocale = (v: unknown): v is Locale => LOCALES.includes(v as Locale);

function stored(): Locale | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return isLocale(v) ? v : null;
  } catch {
    return null;
  }
}

/** Saved choice, then the browser's preferred languages, then English. */
export function detectLocale(): Locale {
  const saved = stored();
  if (saved) return saved;
  const nav = typeof navigator === 'undefined' ? undefined : navigator;
  const wanted = [...(nav?.languages ?? []), nav?.language ?? ''];
  for (const tag of wanted) {
    const base = tag.toLowerCase().split('-')[0];
    if (isLocale(base)) return base;
  }
  return DEFAULT_LOCALE;
}

export function getLocale(): Locale {
  return current;
}

/** The locale's tag for `Intl` formatters (`fr-FR`). */
export function intlLocale(locale: Locale = current): string {
  return INTL_TAG[locale];
}

function apply(locale: Locale) {
  current = locale;
  if (typeof document !== 'undefined') document.documentElement.lang = locale;
  for (const l of listeners) l();
}

/** Loads the catalog if needed, then switches every `useT()` consumer. Not persisted. */
export async function loadLocale(locale: Locale): Promise<void> {
  if (!catalogs[locale] && locale !== 'en') catalogs[locale] = (await loaders[locale]()).default;
  apply(locale);
}

/** The switcher's action: load, switch and remember the choice on this browser. */
export async function setLocale(locale: Locale): Promise<void> {
  await loadLocale(locale);
  try {
    localStorage.setItem(STORAGE_KEY, locale);
  } catch {
    // storage unavailable: the choice lasts until reload
  }
}

/** Startup: picks the locale and loads its catalog before the first render (English on failure). */
export async function initLocale(): Promise<void> {
  try {
    await loadLocale(detectLocale());
  } catch {
    apply(DEFAULT_LOCALE);
  }
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Re-renders the caller when the language changes. */
export function useLocale(): Locale {
  return useSyncExternalStore(subscribe, getLocale, getLocale);
}

function lookup(locale: Locale, key: string): Leaf | undefined {
  let node: Leaf | Tree | undefined = catalogs[locale];
  for (const part of key.split('.')) {
    if (node === undefined || typeof node === 'string') return undefined;
    node = (node as Tree)[part];
  }
  return node as Leaf | undefined;
}

const pluralRules = new Map<Locale, Intl.PluralRules>();
const numberFormats = new Map<Locale, Intl.NumberFormat>();

function pick(locale: Locale, leaf: Plural, count: number): string {
  if (count === 0 && leaf.zero !== undefined) return leaf.zero;
  let rules = pluralRules.get(locale);
  if (!rules) pluralRules.set(locale, (rules = new Intl.PluralRules(INTL_TAG[locale])));
  const category = rules.select(count) as keyof Plural;
  return leaf[category] ?? leaf.other;
}

function formatParam(locale: Locale, v: unknown): unknown {
  if (typeof v !== 'number') return v;
  let f = numberFormats.get(locale);
  if (!f) numberFormats.set(locale, (f = new Intl.NumberFormat(INTL_TAG[locale])));
  return f.format(v);
}

/** The template of a message in a locale, falling back to English, then to the key itself. */
function template(locale: Locale, key: string, params?: Record<string, unknown>): string {
  const leaf = lookup(locale, key) ?? lookup(DEFAULT_LOCALE, key);
  if (leaf === undefined) return key;
  if (typeof leaf === 'string') return leaf;
  return pick(locale, leaf, Number(params?.count ?? 0));
}

const PLACEHOLDER = /\{(\w+)\}/g;

function translate(locale: Locale, key: string, params?: Record<string, unknown>): string {
  const s = template(locale, key, params);
  if (!params) return s;
  return s.replace(PLACEHOLDER, (m, name: string) =>
    name in params ? String(formatParam(locale, params[name])) : m,
  );
}

export type TFunction = <K extends MessageKey>(key: K, ...args: Args<K>) => string;
type Tag = (chunks: ReactNode) => ReactNode;
export type RichFunction = <K extends MessageKey>(
  key: K,
  tags: Record<string, Tag>,
  ...args: Args<K, ReactNode>
) => ReactNode;

/**
 * Like `t`, for messages with markup: `<link>docs</link>` is rendered by `tags.link`, and
 * placeholder values may be elements. Tags do not nest.
 */
function richFor(locale: Locale): RichFunction {
  return (key, tags, ...args) => {
    const params = args[0] as Record<string, unknown> | undefined;
    const s = template(locale, key, params);
    const out: ReactNode[] = [];
    const fill = (text: string) => {
      let last = 0;
      for (const m of text.matchAll(PLACEHOLDER)) {
        out.push(text.slice(last, m.index));
        const name = m[1] as string;
        out.push(
          params && name in params ? (formatParam(locale, params[name]) as ReactNode) : m[0],
        );
        last = (m.index ?? 0) + m[0].length;
      }
      out.push(text.slice(last));
    };
    const TAG = /<(\w+)>(.*?)<\/\1>/gs;
    let last = 0;
    for (const m of s.matchAll(TAG)) {
      fill(s.slice(last, m.index));
      const render = tags[m[1] as string];
      const inner: ReactNode[] = [];
      const before = out.length;
      fill(m[2] as string);
      inner.push(...out.splice(before));
      out.push(render ? render(inner.length === 1 ? inner[0] : inner) : inner);
      last = (m.index ?? 0) + m[0].length;
    }
    fill(s.slice(last));
    return createElement(
      Fragment,
      null,
      ...out.filter((x) => x !== '').map((x, i) => createElement(Fragment, { key: i }, x)),
    );
  };
}

const tCache = new Map<Locale, TFunction>();
const richCache = new Map<Locale, RichFunction>();

function tFor(locale: Locale): TFunction {
  let fn = tCache.get(locale);
  if (!fn)
    tCache.set(
      locale,
      (fn = ((key: string, params?: Record<string, unknown>) =>
        translate(locale, key, params)) as TFunction),
    );
  return fn;
}

function richForCached(locale: Locale): RichFunction {
  let fn = richCache.get(locale);
  if (!fn) richCache.set(locale, (fn = richFor(locale)));
  return fn;
}

/** Translates in the current locale. In components prefer `useT()`, which re-renders on change. */
export const t: TFunction = (key, ...args) =>
  translate(current, key, args[0] as Record<string, unknown> | undefined);

/** `t` and `rich` bound to the active locale; their identity changes with the locale. */
export function useT(): TFunction {
  return tFor(useLocale());
}

export function useRich(): RichFunction {
  return richForCached(useLocale());
}

/** Test helper: back to English, nothing stored. */
export function resetLocale() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
  apply(DEFAULT_LOCALE);
}
