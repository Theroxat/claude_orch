// Revoking alice's Claude Code token/app flips one of her onboarding steps back to "incomplete",
// which sends her to /welcome on her next first visit. So this runs after 20-23 (all of alice's
// pages) in the same ordered process, and not next to them in the parallel 24 admin lane.
import { test, expect, settle, shot } from './fixtures.mjs';
import { checkDialog, closeDialogWithEscape } from './helpers.mjs';

test('claude code: OAuth command, PAT create/validate/revoke, connected app revoke', async ({
  newRole,
}) => {
  const page = await newRole('alice');
  await page.goto('/claude-code');
  await settle(page);
  await expect(page.getByTestId('mcp-oauth-command')).toContainText('claude mcp add');
  await expect(page.getByRole('article', { name: 'Token laptop-cli' })).toContainText('Active');
  await expect(page.getByRole('article', { name: 'Token old-token' })).toContainText('Revoked');
  await expect(page.getByRole('article', { name: /App Claude Code/ }).first()).toBeVisible();
  const create = page.getByRole('button', { name: 'Create token' });
  await expect(create).toBeDisabled();
  await page.getByLabel('Token name').fill('ui-token');
  await page.getByLabel(/Expires in days/).fill('7');
  await create.click();
  await expect(page.getByTestId('mcp-command')).toContainText('orch_pat_');
  await expect(page.getByRole('article', { name: 'Token ui-token' })).toBeVisible();
  await shot(page, 'claude-code-token-created');
  const row = page.getByRole('article', { name: 'Token ui-token' });
  const opener = row.getByRole('button', { name: 'Revoke' });
  await checkDialog(page, 'revoke-token', opener);
  await closeDialogWithEscape(page, 'revoke-token', opener);
  await opener.click();
  await page.getByRole('button', { name: 'Confirm revoke' }).click();
  await expect(page.getByText('ui-token token revoked')).toBeVisible();
  const app = page.getByRole('article', { name: /App Claude Code/ }).first();
  await app.getByRole('button', { name: 'Revoke' }).click();
  await page.getByRole('button', { name: 'Confirm revoke' }).click();
  await expect(page.getByText(/access revoked/)).toBeVisible();
});
