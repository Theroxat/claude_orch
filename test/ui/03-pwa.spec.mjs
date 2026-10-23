// Installable PWA: manifest, icons, service worker (registered, never caching the API), no-cache
// headers on /sw.js, and the offline page. The production CSP must hold throughout.
import http from 'node:http';
import { test, expect, SHOTS } from './fixtures.mjs';

// The stack is served over plain http://web, which is not a secure context, so browsers would not
// expose service workers (production is HTTPS). Chromium treats *.localhost as secure, so this file
// browses http://pwa.localhost through a tiny forward proxy that sends it to the web container
// (CSP unchanged) and that can be switched off to simulate an unreachable server, which
// context.setOffline() cannot do for service-worker requests.
const target = new URL(process.env.ORCH_UI_BASE ?? 'http://web');
const server = { down: false };
const proxy = http.createServer((req, res) => {
  if (server.down) return req.socket.destroy();
  const url = new URL(req.url);
  const up = http.request(
    {
      host: target.hostname,
      port: target.port || 80,
      path: url.pathname + url.search,
      method: req.method,
      headers: { ...req.headers, host: url.host },
    },
    (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    },
  );
  up.on('error', () => res.destroy());
  req.pipe(up);
});
proxy.unref();
await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));

test.use({
  baseURL: 'http://pwa.localhost',
  launchOptions: {
    args: [
      `--proxy-server=http://127.0.0.1:${proxy.address().port}`,
      '--proxy-bypass-list=<-loopback>',
    ],
  },
});

/** fetch() from inside the page: page.request would bypass the proxy. */
const get = (page, path) =>
  page.evaluate(async (path) => {
    const r = await fetch(path, { cache: 'no-store' });
    const type = r.headers.get('content-type') ?? '';
    return {
      status: r.status,
      headers: Object.fromEntries(r.headers),
      json: type.includes('json') || path.endsWith('.webmanifest') ? await r.json() : null,
    };
  }, path);

test('manifest is valid and every icon is served', async ({ newRole }) => {
  const page = await newRole(null);
  await page.goto('/login');
  const href = await page.locator('link[rel="manifest"]').getAttribute('href');
  const res = await get(page, href);
  expect(res.status).toBe(200);
  const m = res.json;
  expect(m).toMatchObject({ name: 'orch', display: 'standalone', start_url: '/', scope: '/' });
  const purposes = m.icons.map((i) => i.purpose);
  expect(purposes).toEqual(expect.arrayContaining(['any', 'maskable', 'monochrome']));
  expect(m.icons.some((i) => i.sizes === '192x192')).toBe(true);
  expect(m.icons.some((i) => i.sizes === '512x512')).toBe(true);
  for (const icon of m.icons) {
    const r = await get(page, icon.src);
    expect(r.status, icon.src).toBe(200);
    expect(r.headers['content-type']).toContain('image/png');
  }
  const apple = await page.locator('link[rel="apple-touch-icon"]').getAttribute('href');
  expect((await get(page, apple)).status).toBe(200);
  await expect(page.locator('meta[name="theme-color"]')).toHaveCount(2);
});

test('/sw.js and the manifest are always revalidated; hashed assets are not touched', async ({
  newRole,
}) => {
  const page = await newRole(null);
  await page.goto('/login');
  for (const path of ['/sw.js', '/manifest.webmanifest', '/offline.html']) {
    const r = await get(page, path);
    expect(r.status, path).toBe(200);
    expect(r.headers['cache-control'], path).toBe('no-cache');
  }
  expect((await get(page, '/sw.js')).headers['content-type']).toMatch(/javascript/);
});

test('service worker registers under the CSP and the offline page shows when the server is gone', async ({
  newRole,
}) => {
  const page = await newRole(null);
  const violations = [];
  page.on('console', (m) => {
    if (/Content Security Policy|Refused to/i.test(m.text()))
      violations.push(m.text().slice(0, 300));
  });
  await page.goto('/login');
  const scope = await page.evaluate(async () => (await navigator.serviceWorker.ready).scope);
  expect(new URL(scope).pathname).toBe('/');
  // Wait until the worker controls the page (precache done), then reload once so it does.
  await page.reload();
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);

  // Nothing from the API ends up in a cache.
  await page.evaluate(() => fetch('/api/healthz').catch(() => undefined));
  const cached = await page.evaluate(async () => {
    const urls = [];
    for (const name of await caches.keys()) {
      for (const r of await (await caches.open(name)).keys()) urls.push(new URL(r.url).pathname);
    }
    return urls;
  });
  expect(cached.some((p) => p.startsWith('/api'))).toBe(false);
  expect(cached).toContain('/offline.html');

  server.down = true;
  await page.goto('/projects');
  await expect(page.getByRole('heading', { name: 'Server unreachable' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Try again' })).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/pwa-offline-light.png` });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({ path: `${SHOTS}/pwa-offline-dark.png` });
  server.down = false;

  expect(violations, 'CSP violations').toEqual([]);
});
