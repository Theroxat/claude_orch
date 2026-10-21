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
        await settle(page);
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
