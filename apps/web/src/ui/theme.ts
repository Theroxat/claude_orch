import { useState } from 'react';

export type Theme = 'light' | 'dark';
const KEY = 'orch.theme';

function stored(): Theme | null {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : null;
  } catch {
    return null;
  }
}

function system(): Theme {
  if (typeof window.matchMedia !== 'function') return 'light';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/** Applies a theme chosen earlier on this browser; otherwise the system setting wins. */
export function applyStoredTheme() {
  const t = stored();
  if (t) document.documentElement.dataset.theme = t;
}

export function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(() => stored() ?? system());
  const toggle = () => {
    const next: Theme = theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem(KEY, next);
    } catch {
      // storage unavailable: the choice lasts until reload
    }
    setTheme(next);
  };
  return [theme, toggle];
}
