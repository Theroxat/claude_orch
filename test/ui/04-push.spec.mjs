// Web Push: the push worker is served revalidated and without CSP trouble, and the Notifications
// card offers the Browser channel (the stack runs over plain http, so the browser says it cannot).
import { test, expect, settle, watch, SHOTS } from './fixtures.mjs';

test('push-sw.js is served as JavaScript and always revalidated', async ({ newRole }) => {
  const page = await newRole(null);
  const res = await page.request.get('/push-sw.js');
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toMatch(/javascript/);
  expect(res.headers()['cache-control']).toBe('no-cache');
});

test('notification settings list the Browser channel, disabled where push is unavailable', async ({
  newRole,
}) => {
  const page = await newRole('olivia');
  const issues = watch(page); // CSP violations, console errors, failed requests
  await page.goto('/my-server#notifications');
  if (page.url().endsWith('/welcome')) {
    // First visit of this member (when run on its own): leave the wizard once.
    await page.getByRole('button', { name: 'Exit setup' }).click();
    await page.goto('/my-server#notifications');
  }
  await settle(page);
  const toggle = page.getByRole('checkbox', { name: 'Enable browser notifications' });
  await expect(toggle).toBeVisible();
  await expect(toggle).toBeDisabled(); // http://web is not a secure context, or no VAPID keys
  await expect(page.getByRole('checkbox', { name: 'Task done on Browser' })).toBeDisabled();
  await page.locator('#notifications').screenshot({ path: `${SHOTS}/pwa-push-settings.png` });
  expect(issues).toEqual([]);
});
