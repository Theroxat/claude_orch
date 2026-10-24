// Shared fixtures: per-role pages, a watcher for console errors / failed requests / CSP
// violations, axe, layout probes and screenshots.
import { test as base, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { appendFileSync, mkdirSync } from 'node:fs';
import { statePath } from './global-setup.mjs';
import { GH } from './lib/api.mjs';

export { expect };
export const SHOTS = '/shots';
export const VIEWPORTS = {
  desktop: { width: 1280, height: 800 },
  mobile: { width: 390, height: 844 },
};
export const THEMES = ['light', 'dark'];
mkdirSync(SHOTS, { recursive: true });

/** Environment noise of the fake stack, not product behavior (see test/ui/stack.sh). */
const IGNORED_URL = [
  /^https:\/\/avatars\.githubusercontent\.com\//, // real GitHub CDN, not reachable / not seeded
  new RegExp(`^${GH.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/avatars/`), // fake GitHub avatars
];
const EXPECTED_STATUS = new Set([401, 403, 404]);

export function findings(kind, data) {
  appendFileSync('/work/findings.jsonl', JSON.stringify({ kind, ...data }) + '\n');
}

/** Attaches the watcher to a page; `issues` collects everything that should fail a page check. */
export function watch(page) {
  const issues = [];
  const note = (type, text) => issues.push({ type, text: String(text).slice(0, 400) });
  page.on('console', (m) => {
    if (m.type() !== 'error' && m.type() !== 'warning') return;
    const t = m.text();
    if (/Content Security Policy|Refused to/i.test(t)) {
      if (IGNORED_URL.some((re) => re.test(t.match(/https?:\/\/[^\s'"]+/)?.[0] ?? ''))) return;
      return note('csp', t);
    }
    if (m.type() === 'warning') return;
    if (/Failed to load resource/.test(t)) {
      const loc = m.location()?.url ?? '';
      if (IGNORED_URL.some((re) => re.test(loc))) return;
      const code = Number(/status of (\d+)/.exec(t)?.[1]);
      if (EXPECTED_STATUS.has(code)) return;
    }
    note('console', `${t} @ ${m.location()?.url ?? ''}`);
  });
  page.on('pageerror', (e) => note('pageerror', e.message));
  page.on('requestfailed', (r) => {
    const u = r.url();
    if (IGNORED_URL.some((re) => re.test(u))) return;
    const f = r.failure()?.errorText ?? '';
    if (/ERR_ABORTED/.test(f)) return; // navigations / cancelled queries
    note('requestfailed', `${r.method()} ${u} ${f}`);
  });
  page.on('response', (r) => {
    const s = r.status();
    if (s < 400 || EXPECTED_STATUS.has(s)) return;
    if (IGNORED_URL.some((re) => re.test(r.url()))) return;
    note('http', `${s} ${r.request().method()} ${r.url()}`);
  });
  return issues;
}

export const test = base.extend({
  /** A page for `role`, themed + sized by `opts` (set with test.use or newRole()). */
  newRole: async ({ browser, baseURL }, use) => {
    const opened = [];
    await use(async (login, { viewport = 'desktop', theme = 'light' } = {}) => {
      const ctx = await browser.newContext({
        baseURL,
        viewport: VIEWPORTS[viewport],
        storageState: login ? statePath(login) : undefined,
        permissions: ['clipboard-read', 'clipboard-write'],
      });
      await ctx.addInitScript((t) => {
        try {
          if (!localStorage.getItem('orch.theme')) localStorage.setItem('orch.theme', t);
        } catch {
          /* storage unavailable: keep the default theme */
        }
        window.__csp = [];
        document.addEventListener('securitypolicyviolation', (e) =>
          window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`),
        );
      }, theme);
      const page = await ctx.newPage();
      page.issues = watch(page);
      opened.push(ctx);
      return page;
    });
    for (const c of opened) await c.close();
  },
});

/** Waits until the shell finished its boot animation and queries settled. */
export async function settle(page) {
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await page
    .waitForFunction(() => !document.querySelector('.shell.booting'))
    .catch(() => undefined);
  await page
    .waitForFunction(
      () =>
        ![...document.querySelectorAll('p.hint')].some((e) => /^Loading/.test(e.textContent ?? '')),
      null,
      { timeout: 5000 },
    )
    .catch(() => undefined);
  // Let the entry animations and view transitions (route / wizard step / dialog) finish before
  // axe, screenshots and the focus probe: React runs a step's effects (e.g. moving focus to its
  // title) only once its view transition is over. Infinite ones (spinners) never end: skipped.
  await page
    .waitForFunction(
      () =>
        document
          .getAnimations()
          .every(
            (a) =>
              a.playState !== 'running' || !Number.isFinite(a.effect?.getComputedTiming().endTime),
          ),
      null,
      { timeout: 5000 },
    )
    .catch(() => undefined);
}

export async function shot(page, name) {
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
  return `${SHOTS}/${name}.png`;
}

export async function cspViolations(page) {
  const list = await page.evaluate(() => window.__csp ?? []).catch(() => []);
  return list.filter((v) => !IGNORED_URL.some((re) => re.test(v.split(' ').slice(1).join(' '))));
}

export async function horizontalOverflow(page) {
  return page.evaluate(() => {
    const doc = document.documentElement;
    const out = [];
    if (doc.scrollWidth > doc.clientWidth + 1)
      out.push(`page scrollWidth ${doc.scrollWidth} > ${doc.clientWidth}`);
    const scrollable = (el) => {
      for (let p = el.parentElement; p; p = p.parentElement) {
        const o = getComputedStyle(p).overflowX;
        if (o === 'auto' || o === 'scroll' || o === 'hidden') return true;
      }
      return false;
    };
    for (const el of document.querySelectorAll('body *')) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (r.right > window.innerWidth + 1 && !scrollable(el)) {
        out.push(
          `${el.tagName.toLowerCase()}${el.className && typeof el.className === 'string' ? '.' + el.className.split(/\s+/)[0] : ''} right=${Math.round(r.right)}`,
        );
        if (out.length > 6) break;
      }
    }
    return out;
  });
}

/** Text that leaves its own box or overlaps a sibling (cheap heuristic for broken layouts). */
export async function textOverlaps(page) {
  return page.evaluate(() => {
    const bad = [];
    const els = [
      ...document.querySelectorAll('h1,h2,h3,p,span,a,button,label,strong,code,li'),
    ].filter((e) => {
      const r = e.getBoundingClientRect();
      return (
        r.width > 0 && r.height > 0 && e.childElementCount === 0 && (e.textContent ?? '').trim()
      );
    });
    for (const e of els) {
      if (
        e.scrollWidth > e.clientWidth + 2 &&
        getComputedStyle(e).overflowX === 'visible' &&
        e.clientWidth > 0 &&
        getComputedStyle(e).display !== 'inline'
      ) {
        bad.push(`overflow: ${e.tagName.toLowerCase()} "${e.textContent.trim().slice(0, 40)}"`);
      }
    }
    return bad.slice(0, 8);
  });
}

export async function axe(page, name) {
  const res = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const bad = res.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  for (const v of bad)
    findings('axe', {
      page: name,
      rule: v.id,
      impact: v.impact,
      help: v.help,
      nodes: v.nodes.slice(0, 3).map((n) => n.target.join(' ')),
      count: v.nodes.length,
    });
  return bad;
}

/** First Tab stops: each must show a visible focus indicator. */
export async function focusRing(page, presses = 6) {
  const missing = [];
  await page.evaluate(
    () => document.activeElement instanceof HTMLElement && document.activeElement.blur(),
  );
  for (let i = 0; i < presses; i++) {
    await page.keyboard.press('Tab');
    const r = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return null;
      const cs = getComputedStyle(el);
      const outline = cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0;
      const shadow = cs.boxShadow && cs.boxShadow !== 'none';
      const label = `${el.tagName.toLowerCase()} "${(el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 30)}"`;
      return { ok: outline || shadow, label };
    });
    if (r && !r.ok) missing.push(r.label);
  }
  return missing;
}

/** Real browser sign-in: /login -> GitHub (the fake picks the account from ?login=). */
export async function uiLogin(page, login, from = '/login') {
  // Playwright does not intercept redirect hops, so rewrite the Location of the server's first hop:
  // the fake GitHub signs in whoever ?login= names.
  await page.route(/\/(api\/auth\/github\/login|invite\/)/, async (route) => {
    const res = await route.fetch({ maxRedirects: 0 });
    const loc = new URL(res.headers()['location'], 'http://web');
    if (!loc.pathname.includes('/login/oauth/authorize')) {
      // an intermediate hop (invite -> sign-in): turn it into a fresh navigation we can intercept
      const h = { ...res.headers() };
      delete h.location;
      return route.fulfill({
        status: 200,
        headers: { ...h, 'content-type': 'text/html' },
        body: `<meta http-equiv="refresh" content="0;url=${loc.pathname}${loc.search}">`,
      });
    }
    loc.searchParams.set('login', login);
    await route.fulfill({ response: res, headers: { ...res.headers(), location: loc.toString() } });
  });
  await page.goto(from);
}
