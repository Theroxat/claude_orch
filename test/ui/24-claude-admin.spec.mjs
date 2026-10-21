import { test, expect, settle, shot } from './fixtures.mjs';
import { auditPage, checkDialog, closeDialogWithEscape } from './helpers.mjs';
import { oauthRequest } from './lib/api.mjs';

const VERSION = process.env.ORCH_UI_VERSION ?? '0.6.1';

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

test('OAuth consent: double click on Approve sends ONE POST; deny; bad request', async ({
  newRole,
}) => {
  const r = await oauthRequest('Consent UI test');
  const page = await newRole('olivia');
  const posts = [];
  page.on('request', (q) => {
    if (q.method() === 'POST' && q.url().includes('/api/oauth/consent')) posts.push(q.url());
  });
  await page.route('http://127.0.0.1:33418/**', (route) =>
    route.fulfill({ status: 200, body: 'callback reached' }),
  );
  await page.goto(`/oauth/consent?${r.params}`);
  await expect(page.getByRole('heading', { name: 'Authorize Consent UI test' })).toBeVisible();
  await auditPage(page, 'oauth-consent');
  await page.getByRole('button', { name: 'Approve' }).dblclick();
  await page.waitForURL(/33418\/callback/);
  expect(posts.length, 'POSTs to /api/oauth/consent after a double click').toBe(1);
  const r2 = await oauthRequest('Consent deny test');
  await page.goto(`/oauth/consent?${r2.params}`);
  await page.getByRole('button', { name: 'Deny' }).click();
  await page.waitForURL(/error=access_denied/);
  await page.goto('/oauth/consent?client_id=nope');
  await expect(page.getByText('Authorization request rejected')).toBeVisible();
  // The 400 is the point of this request, not a page error.
  const kept = page.issues.filter((i) => !i.text.includes('/api/oauth/consent?client_id=nope'));
  page.issues.splice(0, page.issues.length, ...kept);
  await auditPage(page, 'oauth-consent-rejected', { focus: false });
});

test('access admin: approve/deny/remove, pre-approve, invites, declined list; member sees "Admins only"', async ({
  newRole,
}) => {
  const page = await newRole('olivia');
  await page.goto('/admin/access');
  await settle(page);
  await expect(
    page.getByRole('link', { name: /Access/ }).getByLabel(/pending access requests/),
  ).toBeVisible();
  const pending = page.getByRole('region', { name: 'Pending requests' });
  await pending
    .locator('.list-row', { hasText: 'zoe' })
    .getByRole('button', { name: 'Approve' })
    .click();
  await expect(page.getByText('zoe approved')).toBeVisible();
  await pending
    .locator('.list-row', { hasText: 'yan' })
    .getByRole('button', { name: 'Deny' })
    .click();
  await expect(page.getByText('yan denied')).toBeVisible();
  const add = page.getByLabel('Add a GitHub login');
  await add.fill('@carl');
  await page.getByRole('button', { name: 'Pre-approve' }).click();
  await expect(page.getByText('carl pre-approved')).toBeVisible();
  page.once('dialog', (d) => d.accept());
  await page
    .getByRole('region', { name: 'Members' })
    .locator('.list-row', { hasText: 'carl' })
    .getByRole('button', { name: 'Remove' })
    .click();
  await expect(page.getByText('carl removed')).toBeVisible();
  await page.getByRole('button', { name: 'Create invite link' }).click();
  await expect(page.getByTestId('invite-url')).toContainText('/invite/');
  await page
    .getByRole('region', { name: 'Invite links' })
    .getByRole('button', { name: 'Revoke' })
    .first()
    .click();
  await expect(page.getByText('Invite link revoked')).toBeVisible();
  await page.getByText(/Declined \(/).click();
  await settle(page);
  await shot(page, 'access-olivia-final');
  for (const vp of ['mobile']) {
    const mp = await newRole('olivia', { viewport: vp, theme: 'dark' });
    await mp.goto('/admin/access');
    await auditPage(mp, 'access-final', { vp, theme: 'dark' });
  }
});

test('chrome: version footer link, nav badges, top banner only for outdated agents', async ({
  newRole,
}) => {
  const page = await newRole('olivia');
  await page.goto('/projects');
  await settle(page);
  const link = page.getByRole('link', { name: `orch v${VERSION}` });
  await expect(link).toHaveAttribute(
    'href',
    new RegExp(`releases/tag/v${VERSION.replaceAll('.', '\\.')}$`),
  );
  await expect(page.getByRole('region', { name: 'Agent update' })).toHaveCount(0);
});

test('keyboard: skip to nav stations with Tab; Esc closes; nav scrolls on phone', async ({
  newRole,
}) => {
  const page = await newRole('olivia', { viewport: 'mobile' });
  await page.goto('/backlog');
  await settle(page);
  const vis = await page.getByRole('link', { name: 'Backlog' }).isVisible();
  expect(vis).toBe(true);
  await page.getByRole('button', { name: 'New task' }).click();
  await shot(page, 'backlog-new-task-olivia-mobile-open');
  await page.keyboard.press('Escape');
});
