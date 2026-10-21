// Tiny HTTP helpers shared by the seed script and the specs (Node 20+, fetch). Real GitHub OAuth
// sign-in against the fake GitHub (test/e2e/fake-github), as in test/e2e/runner/scenario.mjs.
import { createHash, randomBytes } from 'node:crypto';

export const BASE = process.env.ORCH_UI_BASE ?? 'http://web';
export const GH = process.env.ORCH_UI_GH ?? 'http://fake-github:8080';

export class Session {
  constructor(login) {
    this.login = login;
    this.cookies = new Map();
  }
  cookieHeader() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }
  async raw(method, path, body, headers = {}) {
    const res = await fetch(path.startsWith('http') ? path : `${BASE}${path}`, {
      method,
      redirect: 'manual',
      headers: {
        ...(this.cookies.size ? { cookie: this.cookieHeader() } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        origin: BASE,
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const [kv] = c.split(';');
      const i = kv.indexOf('=');
      const k = kv.slice(0, i).trim();
      const v = kv.slice(i + 1).trim();
      if (v === '') this.cookies.delete(k);
      else this.cookies.set(k, v);
    }
    return res;
  }
  async api(method, path, body, expect = [200, 201, 204]) {
    const res = await this.raw(method, path, body);
    const text = await res.text();
    let json;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    if (!expect.includes(res.status))
      throw new Error(
        `${this.login}: ${method} ${path} -> ${res.status} ${String(text).slice(0, 300)}`,
      );
    return json;
  }
  get = (p) => this.api('GET', p);
  post = (p, b = {}) => this.api('POST', p, b);
  async signIn() {
    const r1 = await this.raw('GET', '/api/auth/github/login');
    const authorize = new URL(r1.headers.get('location'));
    authorize.searchParams.set('login', this.login);
    const r2 = await fetch(authorize, { redirect: 'manual' });
    const cb = new URL(r2.headers.get('location'));
    const r3 = await this.raw('GET', `${cb.pathname}${cb.search}`);
    if (r3.status !== 302 || !this.cookies.has('orch_session'))
      throw new Error(`sign-in of ${this.login} failed (${r3.status})`);
    return this.get('/api/me');
  }
}

const b64u = (b) => b.toString('base64url');
/** Registers an OAuth client (like Claude Code) and returns what /api/oauth/authorize needs. */
export async function oauthRequest(
  name = 'Claude Code (uitest)',
  redirect = 'http://127.0.0.1:33418/callback',
) {
  const reg = await fetch(`${BASE}/api/oauth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: name,
      redirect_uris: [redirect],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }),
  });
  if (reg.status >= 300) throw new Error(`oauth register -> ${reg.status}`);
  const client = await reg.json();
  const verifier = b64u(randomBytes(32));
  const challenge = b64u(createHash('sha256').update(verifier).digest());
  const params = new URLSearchParams({
    client_id: client.client_id,
    redirect_uri: redirect,
    response_type: 'code',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'uitest-state',
    resource: `${BASE}/mcp`,
  });
  return { client, verifier, redirect, params, authorizeUrl: `/api/oauth/authorize?${params}` };
}
