import { expect } from '@playwright/test';
import {
  axe,
  cspViolations,
  findings,
  focusRing,
  horizontalOverflow,
  settle,
  shot,
  textOverlaps,
  VIEWPORTS,
  THEMES,
} from './fixtures.mjs';

/**
 * The standard checks of one rendered page state: no console errors / failed requests / CSP
 * violations, no horizontal scroll, no overflowing text, visible focus, axe serious/critical, and a
 * screenshot. Failures are soft so one run reports every problem.
 */
export async function auditPage(
  page,
  name,
  { vp = 'desktop', theme = 'light', axeToo = true, focus = true } = {},
) {
  await settle(page);
  const tag = `${name}-${vp}-${theme}`;
  const path = await shot(page, tag);
  expect.soft(page.issues.splice(0), `${tag}: console/network/CSP issues`).toEqual([]);
  expect.soft(await cspViolations(page), `${tag}: CSP violations`).toEqual([]);
  const over = await horizontalOverflow(page);
  expect.soft(over, `${tag}: horizontal overflow (${path})`).toEqual([]);
  if (vp === 'mobile') {
    expect.soft(await textOverlaps(page), `${tag}: text overflow (${path})`).toEqual([]);
  }
  if (focus && theme === 'light') {
    expect.soft(await focusRing(page), `${tag}: focus indicator missing`).toEqual([]);
    await page.evaluate(() => window.scrollTo(0, 0));
  }
  if (axeToo) {
    const bad = await axe(page, tag);
    expect
      .soft(
        bad.map((v) => `${v.id}: ${v.nodes.length} node(s)`),
        `${tag}: axe serious/critical`,
      )
      .toEqual([]);
  }
  return path;
}

/** Dialog contract: focus moves in, Tab/Shift+Tab stay inside, Escape closes, focus goes back. */
export async function checkDialog(page, name, openButton, { vp = 'desktop' } = {}) {
  await openButton.focus();
  await openButton.press('Enter');
  const dlg = page.getByRole('dialog');
  await expect(dlg, `${name}: dialog opens`).toBeVisible();
  const inside = () => page.evaluate(() => !!document.activeElement?.closest('[role=dialog]'));
  // focus moves in once the opening animation ends: poll instead of a fixed wait
  await expect.poll(inside, { timeout: 2_000 }).toBe(true).catch(() => undefined);
  expect.soft(await inside(), `${name}: focus moves into the dialog`).toBe(true);
  const stray = [];
  for (let i = 0; i < 14; i++) {
    await page.keyboard.press('Tab');
    if (!(await inside())) stray.push(`Tab#${i + 1}`);
  }
  for (let i = 0; i < 4; i++) {
    await page.keyboard.press('Shift+Tab');
    if (!(await inside())) stray.push(`Shift+Tab#${i + 1}`);
  }
  expect.soft(stray, `${name}: focus escapes the dialog`).toEqual([]);
  if (vp === 'mobile') {
    const box = await dlg.boundingBox();
    const v = VIEWPORTS.mobile;
    expect
      .soft(
        box && box.x >= -1 && box.x + box.width <= v.width + 1,
        `${name}: dialog within mobile width (${JSON.stringify(box)})`,
      )
      .toBe(true);
    expect
      .soft(
        box && box.height <= v.height + 1,
        `${name}: dialog fits mobile height or scrolls (${JSON.stringify(box)})`,
      )
      .toBe(true);
  }
  const tag = `${name}-dialog-${vp}`;
  await shot(page, tag);
  const bad = await axe(page, tag);
  expect
    .soft(
      bad.map((v) => v.id),
      `${tag}: axe serious/critical`,
    )
    .toEqual([]);
  return dlg;
}
export async function closeDialogWithEscape(page, name, opener) {
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog'), `${name}: Escape closes`).toHaveCount(0);
  const isBack = () => opener.evaluate((el) => el === document.activeElement);
  // focus returns once the closing animation ends: poll instead of a fixed wait
  await expect.poll(isBack, { timeout: 2_000 }).toBe(true).catch(() => undefined);
  const back = await isBack();
  const now = await page.evaluate(() => {
    const e = document.activeElement;
    return e
      ? `${e.tagName} ${(e.getAttribute('aria-label') ?? e.textContent ?? '').trim().slice(0, 30)}`
      : 'none';
  });
  expect.soft(back, `${name}: focus returns to the opener (active element: ${now})`).toBe(true);
}
export { findings, settle, shot, THEMES, VIEWPORTS };
