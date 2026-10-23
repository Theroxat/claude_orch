import { registerSW } from 'virtual:pwa-register';

const CHECK_EVERY_MS = 60 * 60 * 1000;
const RELOAD_KEY = 'orch:chunk-reload';

/**
 * Registers the service worker. `onUpdate` fires when a new build is installed and waiting;
 * the returned function activates it and reloads the page.
 */
export function registerServiceWorker(onUpdate: () => void): () => void {
  const update = registerSW({
    onNeedRefresh: onUpdate,
    onRegisteredSW(_url, registration) {
      if (registration) setInterval(() => void registration.update(), CHECK_EVERY_MS);
    },
  });
  return () => void update(true);
}

function safeSession(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/**
 * After a deploy, the chunks of the previous build can be gone (the server no longer has them
 * and the new worker dropped them from its precache). A lazy route then fails to load: reload
 * once to pick up the new build instead of leaving a broken page. A guard stops reload loops.
 */
export function reloadOnStaleChunk(
  target: Pick<Window, 'addEventListener' | 'location'> = window,
  store: Pick<Storage, 'getItem' | 'setItem'> | null = safeSession(),
): void {
  target.addEventListener('vite:preloadError', (event) => {
    const last = Number(store?.getItem(RELOAD_KEY) ?? 0);
    if (Date.now() - last < 10_000) return;
    store?.setItem(RELOAD_KEY, String(Date.now()));
    event.preventDefault();
    target.location.reload();
  });
}
