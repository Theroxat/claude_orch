/**
 * Type machinery for the message catalogs. English (`locales/en`) is the source of truth: its
 * literal strings give the key union, the placeholders each message takes and the shape every
 * other locale must match.
 */

/** A message whose wording depends on a number, selected with `Intl.PluralRules`. */
export type Plural = {
  /** Exact zero, when the language would rather say "no tasks" than "0 tasks". */
  zero?: string;
  one?: string;
  two?: string;
  few?: string;
  many?: string;
  other: string;
};

export type Leaf = string | Plural;
export type Tree = { readonly [key: string]: Leaf | Tree };

type IsLeaf<V> = V extends string ? true : V extends { other: string } ? true : false;

/** Same shape as the English catalog, any wording: what another locale must provide. */
export type Catalog<T> = {
  [K in keyof T]: T[K] extends string
    ? string
    : T[K] extends { other: string }
      ? Plural
      : Catalog<T[K]>;
};

/** Dotted paths to every message of a catalog, such as `"ns.group.name"`. */
export type Paths<T, P extends string = ''> = {
  [K in keyof T & string]: IsLeaf<T[K]> extends true ? `${P}${K}` : Paths<T[K], `${P}${K}.`>;
}[keyof T & string];

export type At<T, K extends string> = K extends `${infer H}.${infer R}`
  ? H extends keyof T
    ? At<T[H], R>
    : never
  : K extends keyof T
    ? T[K]
    : never;

/** `"Hi {name}, {count} tasks"` → `"name" | "count"`. */
type Placeholders<S> = S extends `${string}{${infer P}}${infer R}` ? P | Placeholders<R> : never;

type LeafParams<V> = V extends string
  ? Placeholders<V>
  : V extends Plural
    ? Placeholders<V[keyof V]> | 'count'
    : never;

export type ParamValue = string | number;

/**
 * Extra argument `t()` needs for a message: nothing, or an object with its placeholders.
 * Distributes over a union of messages (a key picked at run time), accepting any member's.
 */
export type ArgsFor<V, Value = ParamValue> = V extends unknown
  ? [LeafParams<V>] extends [never]
    ? [params?: Record<string, never>]
    : V extends Plural
      ? [params: { count: number } & Record<Exclude<LeafParams<V>, 'count'>, Value>]
      : [params: Record<LeafParams<V>, Value>]
  : never;
