import { test, expect, settle } from './fixtures.mjs';
import { auditPage } from './helpers.mjs';
import { Session } from './lib/api.mjs';

test('rita cannot participate: explanation shown, no form', async ({ newRole }) => {
  const page = await newRole('rita');
  await page.goto('/discover');
  await settle(page);
  const card = page.getByRole('article', { name: 'acme/widgets' });
  await expect(card.getByRole('note')).toContainText('Only people on the allowlist');
  await expect(card.getByRole('button', { name: 'Save' })).toHaveCount(0);
  await auditPage(page, 'discover-cannot-rita');
});

test('rita joins with 25% / auto once the owner opens participation; sees Pending', async ({
  newRole,
}) => {
  const o = new Session('olivia');
  await o.signIn();
  const p = (await o.get('/api/projects/mine'))[0];
  await o.api('PATCH', `/api/projects/${p.id}`, { whoCanParticipate: 'GITHUB' });
  const page = await newRole('rita');
  await page.goto('/discover');
  await settle(page);
  const card = page.getByRole('article', { name: 'acme/widgets' });
  await card.getByLabel('Participate', { exact: true }).check();
  await card.getByLabel(/Budget \(%/).fill('150');
  await expect(card.getByRole('alert')).toBeVisible();
  await card.getByLabel(/Budget \(%/).fill('25');
  await card.getByRole('radio', { name: /Auto/ }).check();
  await card.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Participation in acme/widgets saved')).toBeVisible();
  await expect(card.getByText('Pending owner approval')).toBeVisible();
  await auditPage(page, 'discover-joined-rita');
  await o.api('PATCH', `/api/projects/${p.id}`, { whoCanParticipate: 'ALLOWLIST' });
});

test('alice (active member): slider and number input stay in sync; rejection reason shown to a rejected member', async ({
  newRole,
}) => {
  const page = await newRole('alice');
  await page.goto('/discover');
  await settle(page);
  const card = page.getByRole('article', { name: 'acme/widgets' });
  await expect(card.getByText('Active')).toBeVisible();
  await card.getByLabel('Budget slider').fill('70');
  await expect(card.getByLabel(/Budget \(%/)).toHaveValue('70');
  await card.getByLabel(/Budget \(%/).fill('50');
  await expect(card.getByLabel('Budget slider')).toHaveValue('50');
});
