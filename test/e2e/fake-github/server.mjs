import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const sh = promisify(execFile);
const PORT = Number(process.env.PORT || 8080);
const APP_ID = String(process.env.FAKE_GH_APP_ID || '1001');
const KEY_PATH = process.env.FAKE_GH_PRIVATE_KEY_PATH;
const WEBHOOK_URL = process.env.FAKE_GH_WEBHOOK_URL;
const WEBHOOK_SECRET = process.env.FAKE_GH_WEBHOOK_SECRET || '';
const PUBLIC_URL = (process.env.FAKE_GH_PUBLIC_URL || `http://localhost:${PORT}`).replace(
  /\/$/,
  '',
);
const CLIENT_ID = process.env.FAKE_GH_CLIENT_ID;
const CLIENT_SECRET = process.env.FAKE_GH_CLIENT_SECRET;
const GIT_ROOT = '/srv/git';
const BARE = `${GIT_ROOT}/acme/widgets.git`;
const INSTALL_ID = 777;
const REPO_ID = 4242;

const publicKey = KEY_PATH ? crypto.createPublicKey(fs.readFileSync(KEY_PATH)) : null;

const USERS = {
  olivia: { id: 501, role: 'admin' },
  alice: { id: 502, role: 'write' },
  bob: { id: 503, role: 'write' },
  rita: { id: 504, role: 'read' },
};
const cap = (s) => s[0].toUpperCase() + s.slice(1);
const userObj = (login) => ({
  id: USERS[login].id,
  login,
  name: cap(login),
  avatar_url: `${PUBLIC_URL}/avatars/${login}`,
  type: 'User',
});

const state = {
  issues: new Map(),
  pulls: new Map(),
  tokens: new Map(),
  deliveries: [],
  pushes: [],
  nextNumber: 1,
  nextId: 9000,
};
const oauthCodes = new Map();
const userTokens = new Map();
const refreshTokens = new Map();
const rnd = (n = 20) => crypto.randomBytes(n).toString('hex');

const nowIso = () => new Date().toISOString();
const repoObj = () => ({
  id: REPO_ID,
  name: 'widgets',
  full_name: 'acme/widgets',
  private: true,
  default_branch: 'main',
  owner: { login: 'acme', type: 'Organization' },
  html_url: `${PUBLIC_URL}/acme/widgets`,
});

async function git(args, opts = {}) {
  const { stdout } = await sh('git', args, { maxBuffer: 64 * 1024 * 1024, ...opts });
  return stdout;
}
async function branches() {
  const out = await git([
    '-C',
    BARE,
    'for-each-ref',
    '--format=%(refname:short) %(objectname)',
    'refs/heads',
  ]);
  const r = {};
  for (const l of out.split('\n').filter(Boolean)) {
    const [n, s] = l.split(' ');
    r[n] = s;
  }
  return r;
}
async function revParse(b) {
  try {
    return (await git(['-C', BARE, 'rev-parse', '--verify', `refs/heads/${b}`])).trim();
  } catch {
    return null;
  }
}

// ---------- webhooks ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function deliver(event, payload) {
  const raw = JSON.stringify(payload);
  const sig = 'sha256=' + crypto.createHmac('sha256', WEBHOOK_SECRET).update(raw).digest('hex');
  const rec = { at: nowIso(), event, action: payload.action, status: null, body: null };
  state.deliveries.push(rec);
  let lastErr;
  const deliveryId = crypto.randomUUID(); // same id on retries, like GitHub redeliveries
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(WEBHOOK_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-GitHub-Event': event,
          'X-GitHub-Delivery': deliveryId,
          'X-Hub-Signature-256': sig,
          'User-Agent': 'GitHub-Hookshot/fake',
        },
        body: raw,
      });
      const text = (await r.text()).slice(0, 500);
      rec.status = r.status;
      rec.body = text;
      return { status: r.status, body: text };
    } catch (e) {
      lastErr = e;
      await sleep(1000);
    }
  }
  rec.status = 0;
  rec.body = `delivery failed: ${lastErr?.message || lastErr}`.slice(0, 500);
  return { status: 0, body: rec.body };
}
function prPayload(action, pr) {
  return {
    action,
    number: pr.number,
    pull_request: {
      number: pr.number,
      html_url: pr.html_url,
      state: pr.state,
      draft: pr.draft,
      merged: pr.merged,
      merge_commit_sha: pr.merge_commit_sha,
      title: pr.title,
      head: { ref: pr.head.ref, sha: pr.head.sha },
      base: { ref: pr.base.ref, sha: pr.base.sha },
    },
    repository: { id: REPO_ID, full_name: 'acme/widgets', name: 'widgets', default_branch: 'main' },
    installation: { id: INSTALL_ID },
    sender: { id: 501, login: 'olivia' },
  };
}

// ---------- helpers ----------
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
function parseBody(buf, ct = '') {
  const s = buf.toString('utf8');
  if (!s) return {};
  try {
    return JSON.parse(s);
  } catch {
    /* fallthrough */
  }
  if (ct.includes('urlencoded') || !ct.includes('json'))
    return Object.fromEntries(new URLSearchParams(s));
  return {};
}
function send(res, status, obj, headers = {}) {
  const b = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(b),
    ...headers,
  });
  res.end(b);
}
const notFound = (res) => send(res, 404, { message: 'Not Found' });
function bearer(req) {
  const m = /^(?:token|bearer)\s+(\S+)$/i.exec(req.headers.authorization || '');
  return m ? m[1] : null;
}
function verifyJwt(tok) {
  try {
    const [h, p, s] = tok.split('.');
    if (!h || !p || !s) return false;
    const hdr = JSON.parse(Buffer.from(h, 'base64url').toString());
    if (hdr.alg !== 'RS256' || !publicKey) return false;
    const ok = crypto.verify(
      'RSA-SHA256',
      Buffer.from(`${h}.${p}`),
      publicKey,
      Buffer.from(s, 'base64url'),
    );
    if (!ok) return false;
    const c = JSON.parse(Buffer.from(p, 'base64url').toString());
    if (String(c.iss) !== APP_ID) return false;
    if (typeof c.exp !== 'number' || c.exp + 60 < Date.now() / 1000) return false;
    return true;
  } catch {
    return false;
  }
}
const LV = { read: 1, write: 2, admin: 3 };
const has = (tk, perm, level) => (LV[tk.permissions[perm]] || 0) >= LV[level];
const covers = (tk) => tk.repositories.some((r) => r.name === 'widgets');
function userFromReq(req) {
  const t = bearer(req);
  const u = t && userTokens.get(t);
  return u && u.expires > Date.now() ? u.login : null;
}
function issueView(i) {
  return { ...i, labels: i.labels.map((name) => ({ name })) };
}
function labelNames(arr) {
  return (arr || []).map((l) => (typeof l === 'string' ? l : l?.name)).filter(Boolean);
}
function newIssue({ title, body, labels }, extra = {}) {
  const number = state.nextNumber++;
  const i = {
    id: state.nextId++,
    node_id: `I_${number}`,
    number,
    html_url: `${PUBLIC_URL}/acme/widgets/issues/${number}`,
    title: title ?? '',
    body: body ?? null,
    state: 'open',
    state_reason: null,
    labels: labelNames(labels),
    user: { login: 'orch-e2e[bot]' },
    created_at: nowIso(),
    updated_at: nowIso(),
    ...extra,
  };
  state.issues.set(number, i);
  return i;
}

// ---------- git smart http ----------
function parseBasic(req) {
  const m = /^basic\s+(\S+)$/i.exec(req.headers.authorization || '');
  if (!m) return null;
  const d = Buffer.from(m[1], 'base64').toString();
  const idx = d.indexOf(':');
  return idx < 0 ? null : d.slice(idx + 1);
}
async function handleGit(req, res, url, rest) {
  let need; // 'read' | 'write'
  if (rest === '/git-upload-pack') need = 'read';
  else if (rest === '/git-receive-pack') need = 'write';
  else if (rest === '/info/refs') {
    const svc = url.searchParams.get('service');
    if (svc === 'git-upload-pack') need = 'read';
    else if (svc === 'git-receive-pack') need = 'write';
    else return notFound(res);
  } else return notFound(res);
  const tk = state.tokens.get(parseBasic(req));
  if (!tk) {
    res.writeHead(401, {
      'WWW-Authenticate': 'Basic realm="fake-github"',
      'Content-Type': 'text/plain',
    });
    return res.end('Unauthorized');
  }
  const ok =
    covers(tk) && (need === 'write' ? has(tk, 'contents', 'write') : has(tk, 'contents', 'read'));
  if (!ok) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    return res.end('Forbidden');
  }
  const body = await readBody(req);
  const env = {
    PATH: process.env.PATH,
    HOME: '/root',
    GIT_PROJECT_ROOT: GIT_ROOT,
    GIT_HTTP_EXPORT_ALL: '1',
    PATH_INFO: url.pathname,
    QUERY_STRING: url.search.replace(/^\?/, ''),
    REQUEST_METHOD: req.method,
    REMOTE_USER: 'x-access-token',
    REMOTE_ADDR: req.socket.remoteAddress || '127.0.0.1',
    GATEWAY_INTERFACE: 'CGI/1.1',
  };
  if (req.headers['content-type']) env.CONTENT_TYPE = req.headers['content-type'];
  if (req.method === 'POST' || body.length) env.CONTENT_LENGTH = String(body.length);
  if (req.headers['content-encoding']) env.HTTP_CONTENT_ENCODING = req.headers['content-encoding'];
  if (req.headers['git-protocol']) env.GIT_PROTOCOL = req.headers['git-protocol'];
  const child = spawn('git', ['http-backend'], { env });
  child.stdin.on('error', () => {});
  child.stdin.end(body);
  let buf = Buffer.alloc(0),
    headersDone = false,
    status = 200;
  child.stdout.on('data', (chunk) => {
    if (headersDone) {
      res.write(chunk);
      return;
    }
    buf = Buffer.concat([buf, chunk]);
    let idx = buf.indexOf('\r\n\r\n'),
      sep = 4;
    const idx2 = buf.indexOf('\n\n');
    if (idx < 0 || (idx2 >= 0 && idx2 < idx)) {
      idx = idx2;
      sep = 2;
    }
    if (idx < 0) return;
    const head = buf.subarray(0, idx).toString('utf8');
    const headers = {};
    for (const line of head.split(/\r?\n/)) {
      const c = line.indexOf(':');
      if (c < 0) continue;
      const k = line.slice(0, c).trim(),
        v = line.slice(c + 1).trim();
      if (k.toLowerCase() === 'status') status = parseInt(v, 10) || 200;
      else headers[k] = v;
    }
    res.writeHead(status, headers);
    headersDone = true;
    const remain = buf.subarray(idx + sep);
    if (remain.length) res.write(remain);
  });
  child.stderr.on('data', () => {});
  child.on('error', () => {
    if (!res.headersSent) res.writeHead(500);
    res.end();
  });
  child.on('close', async (code) => {
    if (!headersDone) res.writeHead(500);
    res.end();
    if (need === 'write' && rest === '/git-receive-pack' && status < 400 && code === 0) {
      try {
        state.pushes.push({ at: nowIso(), refsAfter: await branches() });
      } catch {
        /* ignore */
      }
    }
  });
}

// ---------- merge ----------
async function doMerge(pr) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-'));
  try {
    await git(['clone', '-q', BARE, tmp]);
    const id = ['-c', 'user.name=Fake GitHub', '-c', 'user.email=noreply@fake-github.local'];
    await git(['-C', tmp, ...id, 'checkout', '-q', '-B', pr.base.ref, `origin/${pr.base.ref}`]);
    try {
      await git([
        '-C',
        tmp,
        ...id,
        'merge',
        '--no-ff',
        '-m',
        `Merge pull request #${pr.number} from acme/${pr.head.ref}`,
        `origin/${pr.head.ref}`,
      ]);
    } catch {
      return { conflict: true };
    }
    const sha = (await git(['-C', tmp, 'rev-parse', 'HEAD'])).trim();
    await git([
      '-C',
      tmp,
      ...id,
      'push',
      '-q',
      'origin',
      `${pr.base.ref}:refs/heads/${pr.base.ref}`,
    ]);
    return { sha };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** Merges an open PR in git and marks it merged. */
async function mergePull(pr) {
  if (pr.merged || pr.state !== 'open')
    return { status: 405, message: 'Pull Request is not mergeable' };
  const m = await doMerge(pr);
  if (m.conflict) return { status: 409, message: 'Merge conflict' };
  pr.merged = true;
  pr.state = 'closed';
  pr.merge_commit_sha = m.sha;
  pr.base.sha = m.sha;
  const iss = state.issues.get(pr.number);
  if (iss) iss.state = 'closed';
  return { status: 200, sha: m.sha };
}

// ---------- router ----------
async function route(req, res) {
  const url = new URL(req.url, 'http://x');
  const method = req.method;
  const seg = url.pathname
    .split('/')
    .filter(Boolean)
    .map((s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    });
  const p = '/' + seg.join('/');

  if (p === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('ok');
  }

  if (p === '/_e2e/state' && method === 'GET') {
    return send(res, 200, {
      issues: [...state.issues.values()].map(issueView),
      pulls: [...state.pulls.values()],
      tokens: [...state.tokens.values()].map((t) => ({
        repositories: t.repositories,
        permissions: t.permissions,
        createdAt: t.createdAt,
      })),
      deliveries: state.deliveries,
      pushes: state.pushes,
      branches: await branches(),
    });
  }
  // Test control: the repo owner clicks "Merge" (no token). Waits for the webhook delivery.
  const em = /^\/_e2e\/pulls\/(\d+)\/merge$/.exec(p);
  if (em && method === 'POST') {
    const pr = state.pulls.get(Number(em[1]));
    if (!pr) return notFound(res);
    const m = await mergePull(pr);
    if (m.status !== 200) return send(res, m.status, { message: m.message });
    const delivery = await deliver('pull_request', prPayload('closed', pr));
    return send(res, 200, { merged: true, sha: m.sha, delivery });
  }
  if (p === '/_e2e/files' && method === 'GET') {
    const ref = url.searchParams.get('ref') || 'main';
    if (!/^[A-Za-z0-9._/-]+$/.test(ref)) return send(res, 400, { message: 'bad ref' });
    try {
      const out = await git(['-C', BARE, 'ls-tree', '-r', '--name-only', `refs/heads/${ref}`]);
      return send(res, 200, out.split('\n').filter(Boolean));
    } catch {
      return notFound(res);
    }
  }
  if (p === '/_e2e/webhook' && method === 'POST') {
    const b = parseBody(await readBody(req), req.headers['content-type']);
    return send(res, 200, await deliver(b.event, b.payload ?? {}));
  }

  // git smart http
  const gm = /^\/acme\/widgets\.git(\/.*)$/.exec(p);
  if (gm) return handleGit(req, res, url, gm[1]);

  // OAuth
  if (p === '/login/oauth/authorize' && method === 'GET') {
    const login = url.searchParams.get('login');
    const ru = url.searchParams.get('redirect_uri');
    if (!login || !USERS[login] || !ru)
      return send(res, 400, { message: 'unknown login or missing redirect_uri' });
    const code = rnd(10);
    oauthCodes.set(code, login);
    const loc = new URL(ru);
    loc.searchParams.set('code', code);
    const st = url.searchParams.get('state');
    if (st !== null) loc.searchParams.set('state', st);
    res.writeHead(302, { Location: loc.toString() });
    return res.end();
  }
  if (p === '/login/oauth/access_token' && method === 'POST') {
    const b = parseBody(await readBody(req), req.headers['content-type']);
    if (b.client_id !== CLIENT_ID || b.client_secret !== CLIENT_SECRET)
      return send(res, 200, {
        error: 'incorrect_client_credentials',
        error_description: 'The client_id and/or client_secret passed are incorrect.',
      });
    let login;
    if (b.grant_type === 'refresh_token') {
      login = refreshTokens.get(b.refresh_token);
      if (!login) return send(res, 200, { error: 'bad_refresh_token' });
      refreshTokens.delete(b.refresh_token);
    } else {
      login = oauthCodes.get(b.code);
      if (!login) return send(res, 200, { error: 'bad_verification_code' });
      oauthCodes.delete(b.code);
    }
    const at = 'ghu_' + rnd(18),
      rt = 'ghr_' + rnd(24);
    userTokens.set(at, { login, expires: Date.now() + 28800 * 1000 });
    refreshTokens.set(rt, login);
    return send(res, 200, {
      access_token: at,
      refresh_token: rt,
      expires_in: 28800,
      refresh_token_expires_in: 15897600,
      token_type: 'bearer',
      scope: '',
    });
  }
  if (p === '/user' && method === 'GET') {
    const l = userFromReq(req);
    return l ? send(res, 200, userObj(l)) : send(res, 401, { message: 'Bad credentials' });
  }
  if (p.startsWith('/user/installations')) {
    const l = userFromReq(req);
    if (!l) return send(res, 401, { message: 'Bad credentials' });
    if (p === '/user/installations' && method === 'GET')
      return send(res, 200, {
        total_count: 1,
        installations: [
          {
            id: INSTALL_ID,
            account: { login: 'acme', type: 'Organization' },
            app_id: Number(APP_ID) || APP_ID,
            target_type: 'Organization',
          },
        ],
      });
    if (p === `/user/installations/${INSTALL_ID}/repositories` && method === 'GET') {
      const r = USERS[l].role;
      return send(res, 200, {
        total_count: 1,
        repositories: [
          {
            ...repoObj(),
            permissions: {
              admin: r === 'admin',
              maintain: r === 'admin',
              push: r !== 'read',
              triage: true,
              pull: true,
            },
          },
        ],
      });
    }
    return notFound(res);
  }

  // App auth
  if (p === '/app' && method === 'GET') {
    const t = bearer(req);
    if (!t || !verifyJwt(t))
      return send(res, 401, { message: 'A JSON web token could not be decoded' });
    return send(res, 200, { id: Number(APP_ID) || APP_ID, slug: 'orch-e2e', name: 'orch e2e' });
  }
  if (p === `/app/installations/${INSTALL_ID}/access_tokens` && method === 'POST') {
    const t = bearer(req);
    if (!t || !verifyJwt(t))
      return send(res, 401, { message: 'A JSON web token could not be decoded' });
    const b = parseBody(await readBody(req), req.headers['content-type']);
    let repos = [{ id: REPO_ID, name: 'widgets', full_name: 'acme/widgets' }];
    if (Array.isArray(b.repositories) && !b.repositories.includes('widgets')) repos = [];
    if (Array.isArray(b.repository_ids) && !b.repository_ids.includes(REPO_ID)) repos = [];
    const permissions =
      b.permissions && Object.keys(b.permissions).length
        ? { metadata: 'read', ...b.permissions }
        : { contents: 'write', issues: 'write', pull_requests: 'write', metadata: 'read' };
    const token = 'ghs_' + rnd(18);
    state.tokens.set(token, {
      repositories: repos,
      permissions,
      createdAt: nowIso(),
      expires: Date.now() + 3600e3,
    });
    return send(res, 201, {
      token,
      expires_at: new Date(Date.now() + 3600e3).toISOString(),
      permissions,
      repository_selection: 'selected',
      repositories: repos,
    });
  }

  // Installation-token REST
  if (seg[0] === 'repos' && seg[1] === 'acme' && seg[2] === 'widgets') {
    const t = bearer(req);
    const tk = t && state.tokens.get(t);
    if (!tk) return send(res, 401, { message: 'Bad credentials' });
    const forbid = () => send(res, 403, { message: 'Resource not accessible by integration' });
    if (!covers(tk)) return forbid();
    const rest = seg.slice(3);
    const r0 = rest[0];
    const need = (perm, lvl) => has(tk, perm, lvl);
    const readBodyJson = async () => parseBody(await readBody(req), req.headers['content-type']);

    if (!r0 && method === 'GET') return send(res, 200, repoObj());

    if (r0 === 'collaborators' && rest[2] === 'permission' && method === 'GET') {
      const u = USERS[rest[1]];
      if (!u) return notFound(res);
      return send(res, 200, {
        permission: u.role,
        role_name: u.role,
        user: { login: rest[1], id: u.id },
      });
    }

    if (r0 === 'issues') {
      if (rest.length === 1 && method === 'POST') {
        if (!need('issues', 'write')) return forbid();
        const b = await readBodyJson();
        return send(res, 201, issueView(newIssue(b)));
      }
      if (rest.length === 1 && method === 'GET') {
        if (!need('issues', 'read')) return forbid();
        const labels = (url.searchParams.get('labels') || '').split(',').filter(Boolean);
        const st = url.searchParams.get('state') || 'open';
        const page = Number(url.searchParams.get('page') || 1);
        const per = Number(url.searchParams.get('per_page') || 30);
        let list = [...state.issues.values()].filter(
          (i) => (st === 'all' || i.state === st) && labels.every((l) => i.labels.includes(l)),
        );
        list = list.slice((page - 1) * per, page * per);
        return send(res, 200, list.map(issueView));
      }
      const n = Number(rest[1]);
      const i = state.issues.get(n);
      if (rest.length === 2 && (method === 'GET' || method === 'PATCH')) {
        if (!need('issues', method === 'GET' ? 'read' : 'write')) return forbid();
        if (!i) return notFound(res);
        if (method === 'PATCH') {
          const b = await readBodyJson();
          for (const k of ['title', 'body', 'state', 'state_reason']) if (k in b) i[k] = b[k];
          if ('labels' in b) i.labels = labelNames(b.labels);
          i.updated_at = nowIso();
        }
        return send(res, 200, issueView(i));
      }
      if (rest.length === 3 && rest[2] === 'labels' && method === 'POST') {
        if (!need('issues', 'write')) return forbid();
        if (!i) return notFound(res);
        const b = await readBodyJson();
        for (const l of labelNames(Array.isArray(b) ? b : b.labels))
          if (!i.labels.includes(l)) i.labels.push(l);
        return send(
          res,
          200,
          i.labels.map((name) => ({ name })),
        );
      }
    }

    if (r0 === 'pulls') {
      if (rest.length === 1 && method === 'POST') {
        if (!need('pull_requests', 'write')) return forbid();
        const b = await readBodyJson();
        const headRef = String(b.head || '').replace(/^[^:]+:/, '');
        const hs = await revParse(headRef),
          bs = await revParse(String(b.base || ''));
        const errors = [];
        if (!hs) errors.push({ resource: 'PullRequest', field: 'head', code: 'invalid' });
        if (!bs) errors.push({ resource: 'PullRequest', field: 'base', code: 'invalid' });
        if (errors.length) return send(res, 422, { message: 'Validation Failed', errors });
        const iss = newIssue(b, { pull_request: {} });
        const number = iss.number;
        const pr = {
          id: state.nextId++,
          number,
          html_url: `${PUBLIC_URL}/acme/widgets/pull/${number}`,
          state: 'open',
          draft: !!b.draft,
          merged: false,
          merge_commit_sha: null,
          title: b.title ?? '',
          body: b.body ?? null,
          head: { ref: headRef, sha: hs, label: `acme:${headRef}` },
          base: { ref: b.base, sha: bs },
        };
        state.pulls.set(number, pr);
        iss.html_url = pr.html_url;
        send(res, 201, pr);
        deliver('pull_request', prPayload('opened', pr)).catch(() => {});
        return;
      }
      if (rest.length === 1 && method === 'GET') {
        if (!need('pull_requests', 'read')) return forbid();
        const st = url.searchParams.get('state') || 'open';
        return send(
          res,
          200,
          [...state.pulls.values()].filter((x) => st === 'all' || x.state === st),
        );
      }
      const pr = state.pulls.get(Number(rest[1]));
      if (rest.length === 2 && method === 'GET') {
        if (!need('pull_requests', 'read')) return forbid();
        return pr ? send(res, 200, pr) : notFound(res);
      }
      if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
        if (!need('contents', 'write')) return forbid();
        if (!pr) return notFound(res);
        const m = await mergePull(pr);
        if (m.status !== 200) return send(res, m.status, { message: m.message });
        send(res, 200, { merged: true, sha: m.sha, message: 'Pull Request successfully merged' });
        deliver('pull_request', prPayload('closed', pr)).catch(() => {});
        return;
      }
    }

    if (r0 === 'git') {
      // Octokit sends the ref URL-encoded (heads%2Fmain): split it again after decoding.
      const refPath = rest.slice(2).join('/').split('/');
      if (rest[1] === 'ref' && refPath[0] === 'heads' && method === 'GET') {
        if (!need('contents', 'read')) return forbid();
        const b = refPath.slice(1).join('/');
        const sha = b && (await revParse(b));
        return sha
          ? send(res, 200, { ref: `refs/heads/${b}`, object: { sha, type: 'commit' } })
          : notFound(res);
      }
      if (rest[1] === 'refs' && rest.length === 2 && method === 'POST') {
        if (!need('contents', 'write')) return forbid();
        const b = await readBodyJson();
        const m = /^refs\/heads\/(.+)$/.exec(b.ref || '');
        if (!m || !/^[0-9a-f]{40}$/.test(b.sha || ''))
          return send(res, 422, { message: 'Validation Failed' });
        if (await revParse(m[1])) return send(res, 422, { message: 'Reference already exists' });
        try {
          await git(['-C', BARE, 'update-ref', b.ref, b.sha]);
        } catch {
          return send(res, 422, { message: 'Object does not exist' });
        }
        return send(res, 201, { ref: b.ref, object: { sha: b.sha, type: 'commit' } });
      }
    }
  }
  return notFound(res);
}

const server = http.createServer((req, res) => {
  res.on('finish', () => {
    console.log(`${req.method} ${(req.url || '').split('?')[0]} ${res.statusCode}`);
  });
  route(req, res).catch((e) => {
    console.error('error', e?.message);
    if (!res.headersSent) send(res, 500, { message: 'Internal error' });
    else res.end();
  });
});

await sh('sh', ['/app/seed.sh']);
server.listen(PORT, () => console.log(`fake-github listening on ${PORT}`));
