import { describe, expect, it, vi } from 'vitest';
import { reloadOnStaleChunk } from './register';

function setup(initial: string | null) {
  let handler: ((e: Event) => void) | undefined;
  const reload = vi.fn();
  const target = {
    addEventListener: (_: string, h: (e: Event) => void) => {
      handler = h;
    },
    location: { reload },
  } as unknown as Window;
  const data = new Map<string, string>(initial ? [['orch:chunk-reload', initial]] : []);
  const store = {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
  };
  reloadOnStaleChunk(target, store);
  return {
    reload,
    fire: () => {
      const e = new Event('vite:preloadError', { cancelable: true });
      handler?.(e);
      return e;
    },
  };
}

describe('stale chunk recovery', () => {
  it('reloads once and prevents the error', () => {
    const { fire, reload } = setup(null);
    expect(fire().defaultPrevented).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
  });
  it('does not loop when it just reloaded', () => {
    const { fire, reload } = setup(String(Date.now()));
    expect(fire().defaultPrevented).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });
});
