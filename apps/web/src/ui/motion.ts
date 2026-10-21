/**
 * Motion helpers. Animations sit on top of a UI that already works: without `matchMedia`
 * (tests, old browsers) or with "reduce motion" set, changes happen instantly.
 */
export function motionAllowed(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** How long a removed list item stays on screen while it animates out (matches styles.css). */
export const EXIT_MS = 240;
