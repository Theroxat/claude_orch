/// <reference lib="webworker" />
// Service worker (vite-plugin-pwa, injectManifest). It exists to make orch installable and to
// show a calm offline page. It never caches API responses, sign-in, MCP or agent traffic.
import { cleanupOutdatedCaches, matchPrecache, precacheAndRoute } from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';
import { NetworkOnly } from 'workbox-strategies';

declare const self: ServiceWorkerGlobalScope;

const OFFLINE_URL = '/offline.html';

// Paths the server answers itself: never intercepted, never cached.
const SERVER_PATHS = [
  /^\/api(\/|$)/,
  /^\/mcp(\/|$)/,
  /^\/agent(\/|$)/,
  /^\/invite(\/|$)/,
  /^\/\.well-known\//,
  /^\/install\.sh$/,
  /^\/healthz$/,
];
const isServerPath = (pathname: string) => SERVER_PATHS.some((re) => re.test(pathname));

// Hashed build assets and the offline page, versioned by the build.
precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

// API, SSE, WebSocket upgrade and OAuth: always the network, no fallback.
registerRoute(
  ({ url }) => url.origin === self.location.origin && isServerPath(url.pathname),
  new NetworkOnly(),
);

// Page loads: always fresh from the network (so a deploy is seen at once); the offline page
// only when the network is unreachable.
const network = new NetworkOnly();
registerRoute(
  new NavigationRoute(
    async ({ request, event }) => {
      try {
        return await network.handle({ request, event: event as ExtendableEvent });
      } catch {
        const offline = await matchPrecache(OFFLINE_URL);
        return offline ?? Response.error();
      }
    },
    { denylist: SERVER_PATHS },
  ),
);

// The page asks for activation after the user accepts the "New version available" toast.
self.addEventListener('message', (event) => {
  if ((event.data as { type?: string } | null)?.type === 'SKIP_WAITING') void self.skipWaiting();
});
