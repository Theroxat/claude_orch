// Every page, as owner (olivia) and member (alice), desktop + phone, light + dark: console, network,
// CSP, horizontal scroll, focus ring, axe serious/critical and a screenshot of each.
import { test, expect, settle } from './fixtures.mjs';
import { auditPage } from './helpers.mjs';

const PAGES = [
  ['projects', '/projects', ['olivia', 'alice']],
  ['discover', '/discover', ['olivia', 'alice']],
  ['pool', '/pool', ['olivia', 'alice']],
  ['requests', '/requests', ['olivia', 'bob']],
  ['backlog', '/backlog', ['olivia', 'alice']],
  ['claude-code', '/claude-code', ['olivia', 'alice']],
  ['my-server', '/my-server', ['olivia', 'alice', 'bob']],
  ['access', '/admin/access', ['olivia', 'alice']],
];
const COMBOS = [
  ['desktop', 'light'],
  ['desktop', 'dark'],
  ['mobile', 'light'],
  ['mobile', 'dark'],
];

for (const [name, path, roles] of PAGES) {
  for (const role of roles) {
    for (const [vp, theme] of COMBOS) {
      test(`${name} as ${role} (${vp}, ${theme})`, async ({ newRole }) => {
        const page = await newRole(role, { viewport: vp, theme });
        await page.goto(path);
        await expect(page.locator('main.page, main').first()).toBeVisible();
        if (name === 'access' && role === 'alice')
          await expect(page.getByText('Admins only.')).toBeVisible();
        await auditPage(page, `${name}-${role}`, { vp, theme });
      });
    }
  }
}

test('unknown route renders something sensible', async ({ newRole }) => {
  const page = await newRole('alice');
  await page.goto('/does-not-exist');
  await settle(page);
  const text = (await page.locator('body').innerText()).trim();
  expect
    .soft(
      text.length,
      'an unknown URL should show a not-found page or redirect, not a blank screen',
    )
    .toBeGreaterThan(40);
  await auditPage(page, 'not-found-alice', { axeToo: false });
});

test('theme toggle persists and flips colors', async ({ newRole }) => {
  const page = await newRole('alice', { theme: 'light' });
  await page.goto('/projects');
  await settle(page);
  const bg = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const before = await bg();
  await page.getByRole('button', { name: 'Switch to dark theme' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  expect(await bg()).not.toBe(before);
  await page.reload();
  await settle(page);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.getByRole('button', { name: 'Switch to light theme' })).toBeVisible();
});

test('language switch: French loads as a lazy chunk under the CSP and persists', async ({
  newRole,
}) => {
  const page = await newRole('alice');
  const csp = [];
  page.on('console', (m) => {
    // The fake GitHub avatars are blocked by img-src (a known caveat of the stack, see stack.sh).
    const text = m.text();
    if (/Content Security Policy|Refused to/i.test(text) && !/img-src/.test(text))
      csp.push(text.slice(0, 300));
  });
  await page.goto('/backlog');
  await settle(page);
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await page.getByRole('button', { name: 'Français' }).click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'fr');
  const nav = page.getByRole('navigation', { name: 'Principale' });
  await expect(nav.getByRole('link', { name: 'Historique' })).toBeVisible();
  await page.reload();
  await settle(page);
  await expect(page.locator('html')).toHaveAttribute('lang', 'fr');
  await expect(page.getByRole('button', { name: 'Se déconnecter' })).toBeVisible();
  await auditPage(page, 'backlog-alice-fr', { vp: 'desktop', theme: 'light' });
  await page.getByRole('button', { name: 'English' }).click();
  await expect(page.getByRole('button', { name: 'Log out' })).toBeVisible();
  expect(csp, 'CSP console messages while switching language').toEqual([]);
});

for (const vp of ['desktop', 'mobile']) {
  test(`French pages fit (${vp})`, async ({ newRole }) => {
    const page = await newRole('olivia', { viewport: vp });
    await page.addInitScript(() => localStorage.setItem('orch.locale', 'fr'));
    for (const [name, path] of PAGES) {
      await page.goto(path);
      await expect(page.locator('html')).toHaveAttribute('lang', 'fr');
      await auditPage(page, `${name}-olivia-fr`, { vp, theme: 'light', axeToo: false });
    }
  });
}
