import { test, expect, settle, shot } from './fixtures.mjs';
import { auditPage, checkDialog, closeDialogWithEscape } from './helpers.mjs';

test('owner: add-repository dialog (contract, desktop + phone)', async ({ newRole }) => {
  for (const vp of ['desktop', 'mobile']) {
    const page = await newRole('olivia', { viewport: vp });
    await page.goto('/projects');
    await settle(page);
    const opener = page.getByRole('button', { name: 'Add repository' });
    const dlg = await checkDialog(page, 'add-repo', opener, { vp });
    await expect(dlg.getByText('acme/widgets')).toBeVisible();
    await expect(dlg.getByText('Added')).toBeVisible();
    await closeDialogWithEscape(page, 'add-repo', opener);
  }
});

test('empty state + "install the GitHub App" guide (bob has no project)', async ({ newRole }) => {
  const page = await newRole('bob');
  await page.goto('/projects');
  await settle(page);
  await expect(page.getByText('Add your first repository to the pool')).toBeVisible();
  await auditPage(page, 'projects-empty-bob');
  await page.getByRole('button', { name: 'Add your first repository' }).click();
  await expect(page.getByRole('region', { name: 'Install the GitHub App first' })).toBeVisible();
  await shot(page, 'projects-empty-bob-dialog');
  await page.keyboard.press('Escape');
});

test('owner participation: validation, save, becomes Active at once', async ({ newRole }) => {
  const page = await newRole('olivia');
  await page.goto('/projects');
  await settle(page);
  const box = page.getByRole('group', { name: /Participate in my pool/ });
  await box.getByLabel('Participate', { exact: true }).check();
  await box.getByLabel(/Budget \(%/).fill('150');
  await expect(box.getByRole('alert')).toContainText('between 0 and 100');
  await expect(box.getByRole('button', { name: 'Save' })).toBeDisabled();
  await box.getByLabel(/Budget \(%/).fill('40');
  await box.getByRole('radio', { name: /Auto/ }).check();
  await box.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Participation in acme/widgets saved')).toBeVisible();
  await expect(box.getByText('Active')).toBeVisible();
});

test('owner: pending participant reject with reason, undo, approve; rejected undo', async ({
  newRole,
}) => {
  const page = await newRole('olivia');
  await page.goto('/projects');
  await settle(page);
  const card = page.getByRole('article', { name: 'acme/widgets' });
  await expect(card.getByText('dana')).toBeVisible();
  const opener = card.getByRole('button', { name: 'Reject dana' });
  await checkDialog(page, 'reject-dialog', opener);
  await page.getByRole('textbox').fill('x'.repeat(10));
  await page.getByRole('button', { name: 'Confirm reject' }).click();
  await expect(page.getByText('dana rejected')).toBeVisible();
  await expect(card.getByText('Rejected members')).toBeVisible();
  await card.getByRole('button', { name: /Undo rejection of dana: back to pending/ }).click();
  await expect(card.getByRole('button', { name: 'Approve dana' })).toBeVisible();
  await card.getByRole('button', { name: 'Approve dana' }).click();
  await expect(page.getByText('dana approved')).toBeVisible();
  await card.getByRole('button', { name: /Undo rejection of erin: approve/ }).click();
  await expect(page.getByText('erin approved')).toBeVisible();
});

test('owner: project settings (selects, approval checkbox) save + help text', async ({
  newRole,
}) => {
  const page = await newRole('olivia');
  await page.goto('/projects');
  await settle(page);
  const card = page.getByRole('article', { name: 'acme/widgets' });
  await card.getByLabel('Visibility').selectOption('ALL_MEMBERS');
  await expect(page.getByText('acme/widgets settings saved')).toBeVisible();
  await card.getByLabel('Who can participate').selectOption('GITHUB');
  await expect(
    card.getByText('Only people who are collaborators on the GitHub repository'),
  ).toBeVisible();
  await card.getByLabel('Who can submit').selectOption('ALLOWLIST');
  await card.getByRole('checkbox', { name: /Require participant approval/ }).click();
  await expect(card.getByText('Approval is off')).toBeVisible();
  await card.getByRole('checkbox', { name: /Require participant approval/ }).click();
  await expect(card.getByText('Approval is off')).toBeHidden();
  await card.getByLabel('Who can submit').selectOption('GITHUB');
  await card.getByLabel('Visibility').selectOption('COLLABORATORS');
  await card.getByLabel('Who can participate').selectOption('ALLOWLIST');
});

test('owner: Remove asks for confirmation (dismiss keeps the project)', async ({ newRole }) => {
  const page = await newRole('olivia');
  await page.goto('/projects');
  await settle(page);
  let asked = '';
  page.once('dialog', (d) => {
    asked = d.message();
    d.dismiss();
  });
  await page.getByRole('button', { name: 'Remove' }).click();
  expect(asked).toContain('Remove acme/widgets');
  await expect(page.getByRole('article', { name: 'acme/widgets' })).toBeVisible();
});
