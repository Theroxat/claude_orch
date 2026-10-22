import { registerSW } from 'virtual:pwa-register';

const CHECK_EVERY_MS = 60 * 60 * 1000;

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
