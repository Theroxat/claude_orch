// The production CSP (deploy/server/routes.caddy) must not be violated by the app itself.
import { test, expect, settle } from './fixtures.mjs';

test('no CSP violation on a plain page load (script-src eval)', async ({ newRole }) => {
  const page = await newRole(null);
  const seen = [];
  page.on('console', (m) => {
    if (/Content Security Policy|Refused to/i.test(m.text())) seen.push(m.text().slice(0, 300));
  });
  await page.goto('/login');
  await settle(page);
  const events = await page.evaluate(() => window.__csp);
  expect(events, 'securitypolicyviolation events on /login').toEqual([]);
  expect(seen, 'CSP console messages on /login').toEqual([]);
});
