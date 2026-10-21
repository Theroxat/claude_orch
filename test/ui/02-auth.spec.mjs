// Login, request-access (stranger), invite link, logout, auth gate.
import { test, expect, settle, uiLogin } from './fixtures.mjs';
import { auditPage } from './helpers.mjs';
import { Session } from './lib/api.mjs';

test('login page: all themes/viewports', async ({ newRole }) => {
  for (const [vp, theme] of [
    ['desktop', 'light'],
    ['desktop', 'dark'],
    ['mobile', 'light'],
    ['mobile', 'dark'],
  ]) {
    const page = await newRole(null, { viewport: vp, theme });
    await page.goto('/login');
    await expect(page.getByRole('link', { name: 'Sign in with GitHub' })).toBeVisible();
    await auditPage(page, 'login', { vp, theme });
  }
});

test('auth gate sends anonymous visitors to /login?next=', async ({ newRole }) => {
  const page = await newRole(null);
  await page.goto('/backlog?task=abc');
  await expect(page).toHaveURL(/\/login\?next=%2Fbacklog%3Ftask%3Dabc/);
});

test('alice signs in through the UI (fake GitHub OAuth) and lands on /projects', async ({
  newRole,
}) => {
  const page = await newRole(null);
  await uiLogin(page, 'alice', '/login?next=%2Fbacklog');
  await page.getByRole('link', { name: 'Sign in with GitHub' }).click();
  await expect(page).toHaveURL(/\/backlog$/);
  await expect(page.getByRole('heading', { name: 'Backlog' })).toBeVisible();
});

test('stranger (sam) is refused and can request access; request page quality', async ({
  newRole,
}) => {
  for (const [vp, theme] of [
    ['desktop', 'light'],
    ['mobile', 'dark'],
  ]) {
    const page = await newRole(null, { viewport: vp, theme });
    await uiLogin(page, 'sam');
    await page.getByRole('link', { name: 'Sign in with GitHub' }).click();
    await expect(page.getByText(/sam/).first()).toBeVisible();
    await expect(page.getByRole('button', { name: /Request access|Update request/ })).toBeVisible();
    await auditPage(page, 'request-access', { vp, theme, focus: false });
    if (vp === 'desktop') {
      await page.locator('textarea, input[name=note]').first().fill('Please let me in (ui test)');
      await page.getByRole('button', { name: /Request access|Update request/ }).click();
      await expect(page.getByText(/Request sent/i).first()).toBeVisible();
      await auditPage(page, 'request-sent', { vp, theme, focus: false });
    }
  }
});

test('invite link: valid link signs sam in; revoked/garbage link shows an error page', async ({
  newRole,
}) => {
  const admin = new Session('olivia');
  await admin.signIn();
  const inv = await admin.post('/api/admin/access/invites', {
    multiUse: false,
    expiresInHours: 24,
  });
  const page = await newRole(null);
  await uiLogin(page, 'sam', inv.url.replace(/^https?:\/\/[^/]+/, ''));
  await page.waitForURL(/fake-github|\/projects|\/welcome|\/$/);
  await settle(page);
  expect
    .soft(await page.evaluate(() => location.pathname), 'sam arrives signed in via the invite')
    .toMatch(/^\/(projects|welcome)?$/);
  const bad = await newRole(null);
  await bad.goto('/invite/not-a-real-token');
  await expect(bad.locator('body')).toContainText(/invalid|expired|no longer/i);
  await auditPage(bad, 'invite-invalid', { focus: false });
});

test('logout returns to /login and kills the session', async ({ newRole }) => {
  const page = await newRole(null);
  await uiLogin(page, 'bob');
  await page.getByRole('link', { name: 'Sign in with GitHub' }).click();
  await settle(page);
  if (/\/welcome/.test(page.url())) {
    // finding: the wizard has no Log out button, only "Exit setup"
    test.info().annotations.push({ type: 'note', description: 'wizard shows no Log out' });
    await page.getByRole('button', { name: 'Exit setup' }).click();
    await settle(page);
  }
  await page.getByRole('button', { name: 'Log out' }).click();
  await expect(page).toHaveURL(/\/login/);
  await page.goto('/projects');
  await expect(page).toHaveURL(/\/login/);
});
