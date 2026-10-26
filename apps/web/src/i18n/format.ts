import { intlLocale } from './index.ts';

/**
 * Numbers and dates in the active locale. Call them while rendering a component that uses
 * `useT()` (or `useLocale()`), so a language switch re-renders them.
 */

const cache = new Map<string, Intl.NumberFormat | Intl.DateTimeFormat>();

function cached<F extends Intl.NumberFormat | Intl.DateTimeFormat>(
  kind: 'n' | 'd',
  options: object | undefined,
  make: (tag: string) => F,
): F {
  const tag = intlLocale();
  const id = `${kind}|${tag}|${JSON.stringify(options ?? {})}`;
  let f = cache.get(id) as F | undefined;
  if (!f) cache.set(id, (f = make(tag)));
  return f;
}

/** `12,345` / `12 345`. */
export function formatNumber(n: number, options?: Intl.NumberFormatOptions): string {
  return cached('n', options, (tag) => new Intl.NumberFormat(tag, options)).format(n);
}

/** `Oct 14, 2026` / `14 oct. 2026` by default. */
export function formatDate(
  value: string | number | Date,
  options: Intl.DateTimeFormatOptions = { dateStyle: 'medium' },
): string {
  return cached('d', options, (tag) => new Intl.DateTimeFormat(tag, options)).format(
    new Date(value),
  );
}

/** Date and time: `Oct 14, 2026, 4:05 PM` / `14 oct. 2026, 16:05`. */
export function formatDateTime(
  value: string | number | Date,
  options: Intl.DateTimeFormatOptions = { dateStyle: 'medium', timeStyle: 'short' },
): string {
  return formatDate(value, options);
}

/** `a, b and c` / `a, b et c`. */
export function formatList(items: string[], type: Intl.ListFormatType = 'conjunction'): string {
  return new Intl.ListFormat(intlLocale(), { style: 'long', type }).format(items);
}
