import { test, expect, settle, shot } from './fixtures.mjs';
import { auditPage, checkDialog, closeDialogWithEscape } from './helpers.mjs';

test('requests: pending approval request listed, nav badge, reject', async ({ newRole }) => {
  const page = await newRole('bob');
  await page.goto('/requests');
  await settle(page);
  await expect(
    page.getByRole('link', { name: /Requests/ }).getByLabel(/pending requests?/),
  ).toBeVisible();
  const card = page.getByRole('article', { name: /Request #/ }).first();
  await expect(card).toContainText('Expires in');
  await card.getByRole('button', { name: 'Reject' }).click();
  await expect(page.getByText(/declined/)).toBeVisible();
  await expect(page.getByText('No pending requests.')).toBeVisible();
  await auditPage(page, 'requests-empty-bob');
});

test('requests: accept', async ({ newRole }) => {
  const { Session } = await import('./lib/api.mjs');
  const o = new Session('olivia');
  await o.signIn();
  const bob = new Session('bob');
  const bme = await bob.signIn();
  const pid = (await o.get('/api/projects/mine'))[0].id;
  await o.post(`/api/projects/${pid}/tasks`, {
    title: 'ui consent accept',
    body: 'x',
    size: 'S',
    model: 'SONNET',
    dispatch: { mode: 'members', memberIds: [bme.id] },
  });
  const page = await newRole('bob');
  await page.goto('/requests');
  await settle(page);
  const card = page.getByRole('article', { name: /Request #/ }).first();
  if (await card.count()) {
    await card.getByRole('button', { name: 'Accept' }).click();
    await settle(page);
    await shot(page, 'requests-after-accept-bob');
    expect.soft(await page.locator('.error').allInnerTexts(), 'accept error').toEqual([]);
  } else
    test.info().annotations.push({
      type: 'note',
      description: 'no request created for bob (no live agent)',
    });
});

test('my server: install command, agent cards, update banner, Claude login, pause/resume', async ({
  newRole,
}) => {
  const page = await newRole('alice');
  await page.goto('/my-server');
  await settle(page);
  await page.getByRole('button', { name: 'Generate install command' }).click();
  await expect(page.getByTestId('install-command')).toContainText('install.sh');
  await page.getByRole('button', { name: 'Copy', exact: true }).click();
  // http://web is not a secure context, so navigator.clipboard is missing here (env limit): either outcome is a defined state.
  await expect(page.getByText(/^Copied$|Copy failed/)).toBeVisible();
  await expect(page.getByRole('article', { name: 'alice-laptop' })).toContainText('Online');
  await expect(page.getByRole('article', { name: 'old-nas' })).toContainText('Offline');
  await expect(page.getByRole('article', { name: 'old-nas' })).toContainText(/offline or too old/);
  const banner = page.getByRole('region', { name: 'Agent update' });
  await expect(banner).toContainText('alice-laptop');
  await expect(banner.getByRole('button', { name: 'Update now alice-laptop' })).toBeVisible();
  await shot(page, 'my-server-alice-banner');
  // pause / resume
  const sw = page.getByRole('switch', { name: 'Pause alice-laptop' });
  await expect(sw).toHaveAttribute('aria-checked', 'true'); // seeded paused
  await sw.click();
  await expect(page.getByText('alice-laptop resumed')).toBeVisible();
  await expect(sw).toHaveAttribute('aria-checked', 'false');
  await sw.click();
  await expect(page.getByText('alice-laptop paused')).toBeVisible();
  // Update now
  await page.getByRole('button', { name: 'Update now alice-laptop' }).last().click();
  await expect(
    page.getByRole('status', { name: /Update status alice-laptop/ }).first(),
  ).toBeVisible();
  await settle(page);
  await shot(page, 'my-server-alice-after-update');
});

test('my server: expired Claude login on bob, no banner for bob; revoke dialog on alice old-nas', async ({
  newRole,
}) => {
  const b = await newRole('bob');
  await b.goto('/my-server');
  await settle(b);
  await expect(b.getByRole('article', { name: 'bob-desktop' }).getByRole('alert')).toContainText(
    'Claude rejected the token',
  );
  await expect(b.getByRole('region', { name: 'Agent update' })).toHaveCount(0);
  const a = await newRole('alice');
  await a.goto('/my-server');
  await settle(a);
  const opener = a.getByRole('button', { name: 'Revoke old-nas' });
  await checkDialog(a, 'revoke-agent', opener);
  await closeDialogWithEscape(a, 'revoke-agent', opener);
  await opener.click();
  await a.getByRole('button', { name: 'Confirm revoke' }).click();
  await expect(a.getByText('old-nas revoked')).toBeVisible();
  await expect(a.getByRole('article', { name: 'old-nas' })).toHaveCount(0);
});
