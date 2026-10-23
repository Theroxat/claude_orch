/**
 * Browser side of Web Push. The push service worker lives on its own scope so it never competes
 * with another service worker (the app's PWA worker controls "/"): a registration is all a push
 * subscription needs, and no page is ever controlled by it.
 */
export const PUSH_SW_URL = '/push-sw.js';
export const PUSH_SW_SCOPE = '/push-sw-scope/';

export function pushSupported(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    'serviceWorker' in navigator &&
    typeof window !== 'undefined' &&
    'PushManager' in window &&
    'Notification' in window
  );
}

export type Permission = 'granted' | 'denied' | 'default';
export const notificationPermission = (): Permission =>
  'Notification' in window ? Notification.permission : 'denied';

/** The VAPID key as `applicationServerKey` wants it (the key is base64url). */
export function keyBytes(b64url: string): Uint8Array<ArrayBuffer> {
  const pad = '='.repeat((4 - (b64url.length % 4)) % 4);
  const raw = atob((b64url + pad).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

async function activated(reg: ServiceWorkerRegistration): Promise<ServiceWorkerRegistration> {
  if (reg.active) return reg;
  const worker = reg.installing ?? reg.waiting;
  if (!worker) throw new Error('The push service worker did not install');
  await new Promise<void>((resolve, reject) => {
    worker.addEventListener('statechange', () => {
      if (worker.state === 'activated') resolve();
      if (worker.state === 'redundant') reject(new Error('The push service worker failed'));
    });
  });
  return reg;
}

/** This browser's current subscription, or null (also when it was never registered). */
export async function currentSubscription(): Promise<PushSubscription | null> {
  const reg = await navigator.serviceWorker.getRegistration(PUSH_SW_SCOPE);
  return (await reg?.pushManager.getSubscription()) ?? null;
}

/** Registers the push worker and subscribes this browser. Permission must already be granted. */
export async function subscribeBrowser(publicKey: string): Promise<PushSubscription> {
  const reg = await activated(
    await navigator.serviceWorker.register(PUSH_SW_URL, { scope: PUSH_SW_SCOPE }),
  );
  const options = { userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) };
  try {
    return await reg.pushManager.subscribe(options);
  } catch (err) {
    // A subscription made with another VAPID key (the server's keys changed) blocks a new one.
    const stale = await reg.pushManager.getSubscription();
    if (!stale) throw err;
    await stale.unsubscribe();
    return reg.pushManager.subscribe(options);
  }
}
