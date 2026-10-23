// Stand-in for the `virtual:pwa-register` module under vitest (no service worker in jsdom).
export function registerSW(): (reload?: boolean) => Promise<void> {
  return () => Promise.resolve();
}
