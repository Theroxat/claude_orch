// Signs every role in through the real GitHub OAuth flow (against the fake GitHub) with the same
// HTTP calls the browser makes, and stores the cookies as Playwright storage states. No SPA page is
// loaded here, so the one-time "first visit goes to /welcome" redirect is still unused.
import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { BASE, GH } from './lib/api.mjs';

export const STATE_DIR = '/work/state';
export const statePath = (login) => `${STATE_DIR}/${login}.json`;

export async function apiLogin(context, login) {
  const r1 = await context.request.get(`${BASE}/api/auth/github/login`, { maxRedirects: 0 });
  const authorize = new URL(r1.headers()['location']);
  authorize.searchParams.set('login', login);
  const r2 = await fetch(authorize, { redirect: 'manual' });
  const cb = new URL(r2.headers.get('location'));
  const r3 = await context.request.get(`${BASE}${cb.pathname}${cb.search}`, { maxRedirects: 0 });
  return r3.status();
}

export default async function globalSetup() {
  mkdirSync(STATE_DIR, { recursive: true });
  const browser = await chromium.launch();
  for (const login of ['olivia', 'alice', 'bob', 'rita']) {
    const ctx = await browser.newContext({ baseURL: BASE });
    const status = await apiLogin(ctx, login);
    if (status !== 302) throw new Error(`sign-in of ${login} failed: ${status}`);
    writeFileSync(statePath(login), JSON.stringify(await ctx.storageState()), { mode: 0o600 });
    await ctx.close();
  }
  await browser.close();
  void GH;
}
