import { test, expect, settle, shot } from './fixtures.mjs';
import { checkDialog, closeDialogWithEscape } from './helpers.mjs';
import { Session } from './lib/api.mjs';

test('pool: members, online/paused, project filter', async ({ newRole }) => {
  const page = await newRole('olivia');
  await page.goto('/pool');
  await settle(page);
  const al = new Session('alice');
  await al.signIn();
  const apiPaused = (await al.get('/api/agents/mine'))
    .filter((a) => a.paused)
    .map((a) => a.machineName);
  const poolPaused = (await page.evaluate(() => fetch('/api/pool').then((r) => r.json()))).members
    .filter((m) => m.paused)
    .map((m) => m.login);
  test.info().annotations.push({
    type: 'diag',
    description: `agents paused (alice api): ${JSON.stringify(apiPaused)}; pool paused: ${JSON.stringify(poolPaused)}`,
  });
  await expect(page.getByRole('article', { name: 'Member alice' })).toBeVisible();
  await expect(page.getByRole('article', { name: 'Member alice' })).toContainText('Paused');
  await expect(page.getByRole('article', { name: 'Member alice' })).toContainText('Online');
});

test('backlog: columns, counts, filter, failed card + Retry, why-not-running', async ({
  newRole,
}) => {
  const page = await newRole('olivia');
  await page.goto('/backlog');
  await settle(page);
  for (const c of ['Proposed', 'To do', 'Blocked', 'In progress', 'In review', 'Done'])
    await expect(page.getByRole('region', { name: c })).toBeVisible();
  const failed = page.getByRole('article', { name: 'Task #6' });
  await expect(failed).toContainText('Needs attention');
  await expect(failed.getByRole('button', { name: 'Retry #6' })).toBeVisible();
  // Retry must only be offered on tasks that failed
  const retryOnPlain = await page
    .getByRole('article', { name: 'Task #1', exact: true })
    .getByRole('button', { name: /Retry/ })
    .count();
  expect.soft(retryOnPlain, 'Retry is shown on a TODO task that never failed (#1)').toBe(0);
  const blockedRetry = await page
    .getByRole('article', { name: 'Task #2', exact: true })
    .getByRole('button', { name: /Retry/ })
    .count();
  expect.soft(blockedRetry, 'Retry is shown on a BLOCKED task (#2)').toBe(0);
  const why = page
    .getByRole('article', { name: 'Task #1', exact: true })
    .getByText("Why isn't this running?");
  await why.click();
  await expect(
    page.getByRole('article', { name: 'Task #1', exact: true }).getByText(/alice/),
  ).toBeVisible();
  await page.getByLabel('Project').selectOption({ label: 'acme/widgets' });
  await expect(page.getByRole('region', { name: 'To do' })).toContainText('UI todo task');
  const importBtn = page.getByRole('button', { name: /Import issues labeled/ });
  expect
    .soft(await importBtn.innerText(), 'import button label shows literal backticks')
    .not.toContain('`');
  await shot(page, 'backlog-olivia-why-open');
});

test('backlog: ?task= highlights, focuses and scrolls to the card; unknown id shows a notice', async ({
  newRole,
}) => {
  const o = new Session('olivia');
  await o.signIn();
  const pid = (await o.get('/api/projects/mine'))[0].id;
  const board = await o.get(`/api/projects/${pid}/tasks`);
  const id = board.IN_REVIEW[0].id;
  const page = await newRole('olivia');
  await page.goto(`/backlog?task=${id}`);
  await settle(page);
  const card = page.getByRole('article', { name: 'Task #4' });
  await expect(card).toHaveAttribute('data-highlighted', 'true');
  expect
    .soft(
      await card.evaluate((el) => el === document.activeElement),
      'highlighted card takes focus',
    )
    .toBe(true);
  await shot(page, 'backlog-highlight-olivia');
  await page.goto('/backlog?task=nope');
  await expect(page.getByText('This task is not on the board')).toBeVisible();
});

test('New task dialog: contract, validation, dispatch modes (pool / members / everyone)', async ({
  newRole,
}) => {
  for (const vp of ['desktop', 'mobile']) {
    const page = await newRole('olivia', { viewport: vp });
    await page.goto('/backlog');
    await settle(page);
    const opener = page.getByRole('button', { name: 'New task' });
    const dlg = await checkDialog(page, 'new-task', opener, { vp });
    await dlg.getByRole('button', { name: 'Create task' }).click();
    await expect(dlg.getByRole('alert')).toContainText('Title is required');
    await dlg.getByLabel('Send to').selectOption('members');
    await dlg.getByLabel('Title').fill('ui test members');
    await dlg.getByRole('button', { name: 'Create task' }).click();
    await expect(dlg.getByRole('alert')).toContainText('Select at least one member');
    await expect(dlg.getByLabel('Send to').locator('option')).toHaveText([
      'Pool',
      'Specific members',
      'Everyone',
    ]);
    if (vp === 'desktop') {
      await dlg.getByRole('group', { name: 'Members' }).getByLabel('alice').check();
      await dlg.getByRole('button', { name: 'Create task' }).click();
      await expect(page.getByText(/#\d+ created/)).toBeVisible();
      await page.getByRole('button', { name: 'New task' }).click();
      await page.getByLabel('Title').fill('ui test everyone');
      await page.getByLabel('Send to').selectOption('broadcast');
      await page.getByRole('button', { name: 'Create task' }).click();
      await expect(page.getByText(/#\d+ created/).last()).toBeVisible();
    } else {
      await closeDialogWithEscape(page, 'new-task', opener);
    }
  }
});

test('member alice: no "Everyone" option; rita proposes a task, owner approves it', async ({
  newRole,
}) => {
  const a = await newRole('alice');
  await a.goto('/backlog');
  await settle(a);
  await a.getByRole('button', { name: 'New task' }).click();
  await expect(a.getByLabel('Send to').locator('option')).toHaveText(['Pool', 'Specific members']);
  await a.keyboard.press('Escape');
  const r = await newRole('rita');
  await r.goto('/backlog');
  await settle(r);
  await r.getByRole('button', { name: 'New task' }).click();
  await expect(r.getByText('created as Proposed')).toBeVisible();
  await r.getByLabel('Title').fill('ui proposed by rita');
  await r.getByRole('button', { name: 'Create task' }).click();
  await expect(r.getByText(/#\d+ created/)).toBeVisible();
  const o = await newRole('olivia');
  await o.goto('/backlog');
  await settle(o);
  const card = o.getByRole('article').filter({ hasText: 'ui proposed by rita' });
  await card.getByRole('button', { name: /Approve #/ }).click();
  await expect(o.getByText(/approved and moved to To do/)).toBeVisible();
  // retry on the failed one
  await o.getByRole('button', { name: 'Retry #6' }).click();
  await settle(o);
  await shot(o, 'backlog-after-retry');
});
