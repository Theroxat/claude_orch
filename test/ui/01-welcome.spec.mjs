// /welcome wizard: first-visit redirect (once), every step, both branches, skip/back/exit.
import { test, expect, settle } from './fixtures.mjs';
import { auditPage } from './helpers.mjs';

const step = (page) => page.locator('.wizard-step');
const heading = (page) => page.getByRole('heading', { level: 1 });

test('olivia (owner): first visit goes to /welcome once; "own repo" branch, every step', async ({
  newRole,
}) => {
  const page = await newRole('olivia');
  await page.goto('/');
  await expect(page).toHaveURL(/\/welcome$/);
  await settle(page);
  await expect(heading(page)).toHaveText('Welcome to orch');
  await expect(page.getByRole('progressbar', { name: 'Setup progress' })).toHaveAttribute(
    'aria-valuenow',
    '1',
  );
  expect
    .soft(
      await page.evaluate(() => document.activeElement?.tagName),
      'wizard title takes focus on open',
    )
    .toBe('H1');
  await auditPage(page, 'welcome-1-welcome');

  // Back is disabled on the first step
  await expect(page.getByRole('button', { name: 'Back' })).toBeDisabled();
  await page.getByRole('button', { name: /add my own repository/ }).click();
  await expect(heading(page)).toHaveText('Add your repository');
  await expect(step(page)).toHaveText('Step 2 of 7');
  await expect(page.getByText('You already have a repository in orch.')).toBeVisible();
  await auditPage(page, 'welcome-2-repo');

  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(heading(page)).toHaveText('Join a project');
  await auditPage(page, 'welcome-3-join');

  await page.getByRole('button', { name: 'Skip for now' }).click();
  await expect(heading(page)).toHaveText('Install your machine');
  await page.getByRole('button', { name: 'Generate install command' }).click();
  await expect(page.getByTestId('install-command')).toContainText('install.sh');
  await expect(page.getByRole('timer')).toContainText('Expires in');
  await auditPage(page, 'welcome-4-machine', { focus: false });

  await page.getByRole('button', { name: 'Skip for now' }).click();
  await expect(heading(page)).toHaveText('Connect Claude on your machine');
  await expect(page.getByText('orch login', { exact: true }).first()).toBeVisible();
  await auditPage(page, 'welcome-5-claude');

  await page.getByRole('button', { name: 'Skip for now' }).click();
  await expect(heading(page)).toHaveText('Connect Claude Code (MCP)');
  await expect(page.getByTestId('mcp-oauth-command')).toContainText('claude mcp add');
  await auditPage(page, 'welcome-6-mcp');

  await page.getByRole('button', { name: 'Skip for now' }).click();
  await expect(heading(page)).toHaveText("You're all set");
  await expect(page.getByRole('link', { name: 'Backlog' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Skip for now' })).toHaveCount(0);
  await auditPage(page, 'welcome-7-done');

  // Back navigation
  await page.getByRole('button', { name: 'Back' }).click();
  await expect(heading(page)).toHaveText('Connect Claude Code (MCP)');
  await page.getByRole('button', { name: 'Back' }).click();
  await page.getByRole('button', { name: 'Back' }).click();
  await page.getByRole('button', { name: 'Back' }).click();
  await page.getByRole('button', { name: 'Back' }).click();
  await page.getByRole('button', { name: 'Back' }).click();
  await expect(heading(page)).toHaveText('Welcome to orch');

  // second visit: no redirect any more
  await page.goto('/');
  await expect(page).toHaveURL(/\/projects$/);
  await page.goto('/welcome');
  await page.getByRole('button', { name: 'Exit setup' }).click();
  await expect(page).toHaveURL(/\/projects$/);
});

test('rita (read-only member): "join a project" branch, cannot-participate explanation', async ({
  newRole,
}) => {
  const page = await newRole('rita');
  await page.goto('/projects');
  await expect(page).toHaveURL(/\/welcome$/); // first visit
  await page.getByRole('button', { name: /joining a teammate/ }).click();
  await expect(heading(page)).toHaveText('Join a project');
  await expect(
    page
      .getByRole('note')
      .filter({ hasText: 'Only people on the allowlist of acme/widgets can join' }),
  ).toBeVisible();
  await auditPage(page, 'welcome-join-branch-join');
  await page.getByRole('button', { name: 'Skip for now' }).click();
  await expect(heading(page)).toHaveText('Add your repository');
  await expect(page.getByRole('region', { name: 'Install the GitHub App first' })).toBeVisible();
  await auditPage(page, 'welcome-join-branch-repo');
  await page.getByRole('button', { name: 'Back' }).click();
  await expect(heading(page)).toHaveText('Join a project');
});

test('wizard on a phone', async ({ newRole }) => {
  const page = await newRole('olivia', { viewport: 'mobile', theme: 'dark' });
  await page.goto('/welcome');
  await auditPage(page, 'welcome-1-welcome', { vp: 'mobile', theme: 'dark' });
  await page.getByRole('button', { name: /add my own repository/ }).click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: 'Skip for now' }).click();
  await page.getByRole('button', { name: 'Generate install command' }).click();
  await auditPage(page, 'welcome-4-machine', { vp: 'mobile', theme: 'dark', focus: false });
});
