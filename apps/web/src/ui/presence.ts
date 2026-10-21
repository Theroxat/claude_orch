import { useEffect, useState } from 'react';
import { EXIT_MS, motionAllowed } from './motion';

export type Phase = 'idle' | 'enter' | 'exit';
export type PresenceEntry<T> = { key: string; item: T; phase: Phase };

type State<T> = {
  sig: string | null;
  items: readonly T[];
  entering: ReadonlySet<string>;
  exiting: { key: string; item: T; index: number }[];
};

const SEP = '\u0000';

/**
 * Keeps removed items on screen for a short exit animation and flags newly added ones, so
 * a list can show what changed. Pass `undefined` while the list is loading: the first list
 * appears as is, only later additions and removals animate.
 */
export function usePresence<T>(
  items: readonly T[] | undefined,
  keyOf: (item: T) => string,
): PresenceEntry<T>[] {
  const keys = items ? items.map(keyOf) : null;
  const sig = keys ? keys.join(SEP) : null;
  const [state, setState] = useState<State<T>>(() => ({
    sig,
    items: items ?? [],
    entering: new Set(),
    exiting: [],
  }));

  let current = state;
  if (sig !== state.sig) {
    // State derived from the previous render ("adjusting state when a prop changes").
    const now = new Set(keys ?? []);
    const before = new Set(state.sig === null ? [] : state.sig.split(SEP));
    const animate = motionAllowed() && state.sig !== null && items !== undefined;
    current = {
      sig,
      items: items ?? [],
      entering: animate ? new Set((keys ?? []).filter((k) => !before.has(k))) : new Set(),
      exiting: animate
        ? [
            ...state.exiting.filter((e) => !now.has(e.key)),
            ...state.items
              .map((item, index) => ({ key: keyOf(item), item, index }))
              .filter((e) => !now.has(e.key)),
          ]
        : [],
    };
    setState(current);
  }

  const settled = current.entering.size === 0 && current.exiting.length === 0;
  useEffect(() => {
    if (settled) return;
    const t = setTimeout(
      () => setState((s) => ({ ...s, entering: new Set(), exiting: [] })),
      EXIT_MS,
    );
    return () => clearTimeout(t);
  }, [settled, sig]);

  const out: PresenceEntry<T>[] = (items ?? []).map((item, i) => {
    const key = keys![i]!;
    return { key, item, phase: current.entering.has(key) ? 'enter' : 'idle' };
  });
  for (const e of current.exiting) {
    if (out.some((o) => o.key === e.key)) continue;
    out.splice(Math.min(e.index, out.length), 0, { key: e.key, item: e.item, phase: 'exit' });
  }
  return out;
}

/** Props to spread on the root element of an item rendered from `usePresence`. */
export function presenceProps(phase: Phase) {
  if (phase === 'enter') return { 'data-presence': 'enter' } as const;
  if (phase === 'exit')
    return { 'data-presence': 'exit', 'aria-hidden': true, inert: true } as const;
  return {};
}

/** Counts changes of `value` after the first render, to replay a "changed" animation. */
export function useChangeCount<T>(value: T): number {
  const [s, setS] = useState({ value, count: 0 });
  if (!Object.is(s.value, value)) {
    const next = { value, count: s.count + 1 };
    setS(next);
    return next.count;
  }
  return s.count;
}
