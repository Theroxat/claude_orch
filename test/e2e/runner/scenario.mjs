// Real end-to-end scenario for orch (./dev e2e). Runs in the `runner` container of
// compose.e2e.yaml with the host Docker socket. Drives the REST API, the MCP endpoint, the
// agents' CLI (`docker compose exec <agent> orch ...`) and the fake GitHub.
// Nothing here uses a real GitHub or Claude credential.
import { spawnSync } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync } from 'node:fs';

const SERVER = process.env.SERVER_URL ?? 'http://server:3000';
const GH = process.env.FAKE_GH_URL ?? 'http://fake-github:8080';
const REPO = process.env.ORCH_E2E_REPO;
const WORK = { alice: process.env.ORCH_E2E_WORK_ALICE, bob: process.env.ORCH_E2E_WORK_BOB };
const IDS_FILE = process.env.ORCH_E2E_IDS_FILE;
const WEBHOOK_SECRET = process.env.ORCH_E2E_WEBHOOK_SECRET;
// Fake Claude tokens, shaped like real ones (`orch login` enforces the shape). The fake claude
// (test/e2e/fake-claude/claude) accepts a token only when it contains `VALID`.
const fakeToken = (tag) =>
  `sk-ant-oat01-${`FAKE-e2e-${tag}-not-a-real-credential-`.padEnd(90, 'x')}`;
const FAKE_CLAUDE_TOKEN = fakeToken('VALID');
/** Rejected by the login check (401). */
const REJECTED_CLAUDE_TOKEN = fakeToken('expired');
/** Passes the login check, then gets a 401 on a task run (revoked after the check). */
const REVOKED_CLAUDE_TOKEN = fakeToken('VALID-at-check-expired-at-run');
const PROJECT = 'acme/widgets';

// ---------- reporting ----------

const results = [];
let current = null;
const log = (...a) => console.log(`[e2e ${new Date().toISOString().slice(11, 19)}]`, ...a);

async function step(name, fn) {
  current = name;
  log(`STEP ${name}`);
  const t0 = Date.now();
  try {
    await fn();
    results.push({ name, ok: true, ms: Date.now() - t0 });
    log(`PASS ${name}`);
  } catch (e) {
    results.push({ name, ok: false, ms: Date.now() - t0, error: e?.stack ?? String(e) });
    log(`FAIL ${name}: ${e?.stack ?? e}`);
    throw e;
  }
}

function assert(cond, msg, extra) {
  if (!cond) {
    throw new Error(
      `${msg}${extra !== undefined ? `: ${JSON.stringify(extra).slice(0, 1500)}` : ''}`,
    );
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(desc, fn, timeoutMs = 60_000, everyMs = 1000) {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = e?.message ?? String(e);
    }
    await sleep(everyMs);
  }
  throw new Error(`timed out waiting for ${desc} (last: ${JSON.stringify(last)?.slice(0, 800)})`);
}

// ---------- docker / compose ----------

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  if (opts.allowFail) return r;
  if (r.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} failed (${r.status}): ${r.stderr}${r.stdout}`);
  }
  return r;
}
const composeArgs = [
  'compose',
  '-p',
  process.env.ORCH_E2E_PROJECT || 'orch-e2e',
  '-f',
  `${REPO}/compose.e2e.yaml`,
  '--project-directory',
  REPO,
];
const compose = (args, opts) => sh('docker', [...composeArgs, ...args], opts);
const docker = (args, opts) => sh('docker', args, opts);

/** `docker compose exec <agent> orch ...` (the member CLI, over the agent's unix socket). */
function orch(agent, args, opts = {}) {
  const r = compose(['exec', '-T', agent, 'orch', ...args], { ...opts, allowFail: true });
  log(
    `  ${agent}$ orch ${args.join(' ')} -> ${r.status}${r.stdout ? `\n${r.stdout.trimEnd()}` : ''}${r.stderr ? `\n${r.stderr.trimEnd()}` : ''}`,
  );
  if (!opts.allowFail && r.status !== 0)
    throw new Error(`orch ${args.join(' ')} failed on ${agent}`);
  return r;
}

function psql(sql) {
  return compose([
    'exec',
    '-T',
    'postgres',
    'psql',
    '-U',
    'orch',
    '-d',
    'orch',
    '-At',
    '-F',
    '\t',
    '-c',
    sql,
  ])
    .stdout.trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => l.split('\t'));
}

function recordAssignment(id) {
  if (IDS_FILE && id) appendFileSync(IDS_FILE, `${id}\n`);
}

/**
 * Task containers of THIS run on the host daemon for an issue, by label: not the compose sidecars
 * of the fixture repo, not the containers of a parallel run (they mount another work dir).
 */
function taskContainers(issue) {
  const out = docker([
    'ps',
    '-a',
    '--no-trunc',
    '--filter',
    `label=orch.issue=${issue}`,
    '--format',
    '{{.Names}}\t{{.Label "orch.task"}}\t{{.Label "com.docker.compose.project"}}\t{{.Mounts}}',
  ]).stdout;
  return out
    .split('\n')
    .filter(Boolean)
    .map((l) => l.split('\t'))
    .filter(([, , composeProject, mounts]) => !composeProject && mineMounts(mounts))
    .map(([name, assignmentId]) => ({ name, assignmentId }));
}

const mineMounts = (mounts = '') => mounts.includes(WORK.alice) || mounts.includes(WORK.bob);

/** The compose sidecars an agent started for a task (fixture repo docker-compose.yml). */
function sidecars(assignmentId) {
  return docker([
    'ps',
    '-a',
    '--filter',
    `label=orch.task=${assignmentId}`,
    '--filter',
    'label=com.docker.compose.project',
    '--format',
    '{{.Names}}\t{{.State}}',
  ])
    .stdout.split('\n')
    .filter(Boolean)
    .map((l) => l.split('\t'));
}

// ---------- HTTP ----------

class Session {
  constructor(login) {
    this.login = login;
    this.cookies = new Map();
  }
  cookieHeader() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }
  takeCookies(res) {
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const [kv] = c.split(';');
      const i = kv.indexOf('=');
      const k = kv.slice(0, i).trim();
      const v = kv.slice(i + 1).trim();
      if (v === '') this.cookies.delete(k);
      else this.cookies.set(k, v);
    }
  }
  async raw(method, path, body, headers = {}) {
    const res = await fetch(path.startsWith('http') ? path : `${SERVER}${path}`, {
      method,
      redirect: 'manual',
      headers: {
        ...(this.cookies.size ? { cookie: this.cookieHeader() } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    this.takeCookies(res);
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
    if (!expect.includes(res.status)) {
      throw new Error(`${this.login}: ${method} ${path} -> ${res.status} ${text.slice(0, 800)}`);
    }
    return json;
  }
  get(p) {
    return this.api('GET', p);
  }
  post(p, b = {}) {
    return this.api('POST', p, b);
  }

  /** The real GitHub OAuth flow of the server, against the fake GitHub. */
  async signIn() {
    const r1 = await this.raw('GET', '/api/auth/github/login');
    assert(r1.status === 302, 'login should redirect to GitHub', r1.status);
    const authorize = new URL(r1.headers.get('location'));
    assert(
      authorize.origin === new URL(GH).origin,
      'authorize URL must point at GITHUB_WEB_URL',
      authorize.href,
    );
    authorize.searchParams.set('login', this.login); // the fake's "who signs in" switch
    const r2 = await fetch(authorize, { redirect: 'manual' });
    assert(r2.status === 302, 'authorize should redirect back', r2.status);
    const cb = new URL(r2.headers.get('location'));
    const r3 = await this.raw('GET', `${cb.pathname}${cb.search}`);
    assert(r3.status === 302, 'callback should redirect to /', {
      status: r3.status,
      body: await r3.text(),
    });
    assert(this.cookies.has('orch_session'), 'session cookie set');
    this.me = await this.get('/api/me');
    assert(this.me.githubLogin === this.login, 'signed in as the right user', this.me);
    return this.me;
  }
}

async function gh(path, init) {
  const res = await fetch(`${GH}${path}`, init);
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`fake GitHub ${path} -> ${res.status} ${JSON.stringify(json)}`);
  return json;
}
const ghState = () => gh('/_e2e/state');
const mergePr = (n) => gh(`/_e2e/pulls/${n}/merge`, { method: 'POST' });

async function signedWebhook(
  event,
  payload,
  { badSignature = false, deliveryId = randomUUID() } = {},
) {
  const raw = JSON.stringify(payload);
  const sig = `sha256=${createHmac('sha256', badSignature ? 'wrong-secret' : WEBHOOK_SECRET)
    .update(raw)
    .digest('hex')}`;
  const res = await fetch(`${SERVER}/api/github/webhook`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-github-event': event,
      'x-github-delivery': deliveryId,
      'x-hub-signature-256': sig,
    },
    body: raw,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

// ---------- MCP (Streamable HTTP, JSON responses) ----------

async function mcp(pat, method, params, id = 1) {
  const res = await fetch(`${SERVER}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${pat}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2025-06-18',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  const text = await res.text();
  let msg;
  if ((res.headers.get('content-type') ?? '').includes('text/event-stream')) {
    const data = text
      .split('\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5))
      .join('');
    msg = JSON.parse(data);
  } else msg = text ? JSON.parse(text) : null;
  return { status: res.status, msg };
}

async function mcpTool(pat, name, args) {
  await mcp(pat, 'initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'orch-e2e', version: '0' },
  });
  const { status, msg } = await mcp(pat, 'tools/call', { name, arguments: args }, 2);
  assert(status === 200 && msg?.result, `MCP ${name} call failed`, { status, msg });
  const text = msg.result.content?.[0]?.text ?? '';
  const parsed = JSON.parse(text);
  if (msg.result.isError) throw new Error(`MCP ${name} error: ${text}`);
  return parsed;
}

// ---------- domain helpers ----------

const users = {
  olivia: new Session('olivia'),
  alice: new Session('alice'),
  bob: new Session('bob'),
};
let project;
/** The approved stranger from step a2, reused by the rejection step. */
let sam;
const agentIds = {};

async function taskByIssue(n, as = users.olivia) {
  const board = await as.get(`/api/projects/${project.id}/tasks`);
  for (const col of Object.values(board)) {
    if (!Array.isArray(col)) continue;
    const t = col.find((x) => x.issueNumber === n);
    if (t) return t;
  }
  return null;
}

async function createTask(title, extra = {}) {
  const t = await users.olivia.post(`/api/projects/${project.id}/tasks`, {
    title,
    body: `E2E task: ${title}. Add a file proving the run happened.`,
    acceptanceCriteria: ['a new file is committed'],
    size: 'S',
    model: 'SONNET',
    ...extra,
  });
  log(`  created task #${t.issueNumber} (${t.status}) ${title}`);
  return t;
}

function assignmentsOf(taskId) {
  return psql(
    `select a.id, a.kind, a.status, u.login, coalesce(a."execMode"::text,'') from "Assignment" a join "User" u on u.id=a."userId" where a."taskId"='${taskId}' order by a."createdAt"`,
  ).map(([id, kind, status, login, execMode]) => ({ id, kind, status, login, execMode }));
}

/** If bob (approval mode) got a consent request for this task, he declines it via `orch reject`. */
async function bobDeclinesRequests(taskId) {
  for (const a of assignmentsOf(taskId)) {
    if (a.login === 'bob' && a.kind === 'CONSENT_REQUEST' && a.status === 'PENDING') {
      assert(a.kind !== 'AUTO_OFFER', 'bob never gets an auto offer');
      log(`  bob got a consent request ${a.id}: he declines it`);
      orch('bob', ['reject', a.id], { allowFail: true });
    }
  }
}

async function waitStatus(issue, statuses, timeoutMs = 120_000, onTick) {
  return waitFor(
    `task #${issue} in ${statuses.join('|')}`,
    async () => {
      if (onTick) await onTick();
      const t = await taskByIssue(issue);
      if (t && statuses.includes(t.status)) return t;
      throw new Error(`status ${t?.status}`); // reported as the last value on timeout
    },
    timeoutMs,
  );
}

async function agentView(user, name) {
  const list = await users[user].get('/api/agents/mine');
  return list.find((a) => a.machineName === name);
}

// ---------- scenario ----------

async function main() {
  assert(REPO && WORK.alice && WORK.bob && WEBHOOK_SECRET, 'runner environment is incomplete');

  await step('a. sign in (real OAuth flow against the fake GitHub)', async () => {
    for (const s of Object.values(users)) await s.signIn();
    const anon = await fetch(`${SERVER}/api/me`);
    assert(anon.status === 401, 'anonymous /api/me is 401');
  });

  await step('a2. stranger requests access, admin approves, stranger signs in', async () => {
    sam = new Session('sam');
    const r1 = await sam.raw('GET', '/api/auth/github/login');
    const authorize = new URL(r1.headers.get('location'));
    authorize.searchParams.set('login', 'sam');
    const r2 = await fetch(authorize, { redirect: 'manual' });
    const cb = new URL(r2.headers.get('location'));
    const denied = await sam.raw('GET', `${cb.pathname}${cb.search}`);
    const html = await denied.text();
    assert(denied.status === 403, 'stranger is refused', denied.status);
    const token = /name="token" value="([^"]+)"/.exec(html)?.[1];
    assert(token, 'access-request form carries a token');
    assert(!sam.cookies.has('orch_session'), 'no session for the stranger yet');
    const rq = await fetch(`${SERVER}/api/auth/access-request`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: SERVER },
      body: new URLSearchParams({ token, note: 'e2e please' }),
    });
    assert(rq.status < 300 && /Request sent/.test(await rq.text()), 'request sent', rq.status);
    const o = users.olivia;
    const adm = await o.get('/api/admin/access');
    const pending = JSON.stringify(adm.pending ?? adm);
    assert(pending.includes('"sam"') || pending.includes('sam'), 'pending list shows sam', adm);
    const grant = (adm.pending ?? []).find((g) => JSON.stringify(g).includes('sam'));
    assert(grant?.id, 'pending grant has an id', adm);
    await o.post(`/api/admin/access/grants/${grant.id}/approve`);
    const me = await sam.signIn();
    assert(me.githubLogin === 'sam', 'approved stranger signed in', me);
  });

  await step('b1. owner adds the project; members ask to participate; owner approves', async () => {
    const o = users.olivia;
    const repos = await o.get('/api/repos/available');
    const repo = repos.find((r) => r.fullName === PROJECT);
    assert(repo && !repo.alreadyAdded, 'repo listed through the installation', repos);
    project = await o.post('/api/projects', { githubRepoId: repo.githubRepoId });
    assert(project.fullName === PROJECT && project.ownerId === o.me.id, 'project added', project);
    project = await o.api('PATCH', `/api/projects/${project.id}`, {
      requireParticipantApproval: true,
    });
    assert(project.requireParticipantApproval === true, 'approval required');

    const pa = await users.alice.api('PUT', `/api/projects/${project.id}/participation`, {
      participating: true,
      budgetPercent: 50,
      mode: 'auto',
    });
    const pb = await users.bob.api('PUT', `/api/projects/${project.id}/participation`, {
      participating: true,
      budgetPercent: 50,
      mode: 'approval',
    });
    assert(pa.status === 'pending' && pb.status === 'pending', 'both pending', { pa, pb });
    for (const u of [users.alice, users.bob]) {
      const v = await o.post(`/api/projects/${project.id}/participants/${u.me.id}/approve`);
      assert(v.status === 'active', 'approved', v);
    }
  });

  await step(
    'b2. enroll both agents with enrollment tokens, orch login, usage reports arrive',
    async () => {
      const env = { ...process.env };
      for (const [who, name] of [
        ['alice', 'alice-laptop'],
        ['bob', 'bob-desktop'],
      ]) {
        const t = await users[who].post('/api/agents/enrollment-tokens');
        assert(t.token && t.installCommand.includes(t.token), 'enrollment token', Object.keys(t));
        env[`ORCH_E2E_ENROLL_TOKEN_${who.toUpperCase()}`] = t.token;
        compose(['--profile', 'agents', 'up', '-d', '--no-deps', '--no-build', who], { env });
        await waitFor(
          `${who} agent online`,
          async () => {
            const a = await agentView(who, name);
            return a?.connected ? a : null;
          },
          90_000,
        );
        const login = compose(['exec', '-T', who, 'orch', 'login', '--token-stdin', '--no-setup'], {
          input: `${FAKE_CLAUDE_TOKEN}\n`,
          allowFail: true,
        });
        assert(login.status === 0, `orch login on ${who}`, login.stderr);
        assert(
          login.stdout.includes('✓ Claude login verified'),
          `orch login on ${who} verified the token`,
          login.stdout,
        );
        const a = await waitFor(
          `${who} usage report`,
          async () => {
            const v = await agentView(who, name);
            return v?.lastUsage ? v : null;
          },
          60_000,
        );
        agentIds[who] = a.id;
        assert(
          a.lastUsage.estimate === true && a.lastUsage.capacityEstimate > 0,
          'usage estimate',
          a.lastUsage,
        );
        // The enrollment token is single use.
        const replay = await fetch(`${SERVER}/api/agents/enroll`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            token: t.token,
            machine: { hostname: 'x', os: 'linux', arch: 'x64', agentVersion: '0.1.0' },
          }),
        });
        assert(replay.status === 401, 'replayed enrollment token rejected', replay.status);
      }
      const pool = await users.olivia.get(`/api/pool?projectId=${project.id}`);
      const logins = pool.members.map((m) => m.login).sort();
      assert(logins.includes('alice') && logins.includes('bob'), 'pool lists both members', logins);
    },
  );

  await step(
    'c. manual: bob runs orch take -> sandbox -> screen -> orch done -> PR -> merge -> DONE -> cleanup',
    async () => {
      // Alice (auto mode) pauses locally so the dispatcher cannot hand her the task first.
      orch('alice', ['pause']);
      await waitFor(
        'alice paused on the server',
        async () => (await agentView('alice', 'alice-laptop'))?.paused,
      );
      const t = await createTask('Manual change by bob');
      const n = t.issueNumber;
      const take = orch('bob', ['take', `${PROJECT}#${n}`], { allowFail: true });
      assert(take.status === 0, 'orch take succeeded', take.stderr);

      const c = await waitFor(
        'bob task container running',
        async () => {
          const list = taskContainers(n);
          if (list.length !== 1) return null;
          const st = docker(['inspect', '-f', '{{.State.Running}}', list[0].name]).stdout.trim();
          return st === 'true' ? list[0] : null;
        },
        300_000,
        2000,
      );
      recordAssignment(c.assignmentId);
      const insp = JSON.parse(docker(['inspect', c.name]).stdout)[0];
      const mounts = insp.Mounts;
      const clone = `${WORK.bob}/${c.assignmentId}/src`;
      assert(mounts.length === 1, 'exactly one mount', mounts);
      assert(
        mounts[0].Type === 'bind' &&
          mounts[0].Source === clone &&
          mounts[0].Destination === '/workspace' &&
          mounts[0].RW,
        'only the clone mounted rw at /workspace',
        mounts[0],
      );
      assert(!JSON.stringify(mounts).includes('docker.sock'), 'no docker socket mount');
      // Fixture docker-compose.yml: env_file .env (gitignored, absent from the clone) with a
      // .env.example, and a fixed container_name. The sidecar runs; nothing is written in the clone.
      const side = sidecars(c.assignmentId);
      assert(
        side.length === 1 && side[0][1] === 'running' && side[0][0] !== 'widgets-helper',
        'compose sidecar running under a task-scoped name',
        side,
      );
      assert(!existsSync(`${clone}/.env`), 'no .env written in the clone');
      const user = insp.Config.User;
      assert(user && !/^0(:|$)/.test(user) && user !== 'root', 'non-root user', user);
      assert(insp.HostConfig.Privileged === false, 'not privileged');
      assert(
        (insp.HostConfig.CapDrop ?? [])
          .map((x) => x.toUpperCase())
          .some((x) => x === 'ALL' || x === 'CAP_ALL'),
        'cap-drop ALL',
        insp.HostConfig.CapDrop,
      );
      assert(
        (insp.HostConfig.SecurityOpt ?? []).some((x) => x.startsWith('no-new-privileges')),
        'no-new-privileges',
        insp.HostConfig.SecurityOpt,
      );
      assert(Object.keys(insp.NetworkSettings.Ports ?? {}).length === 0, 'no published ports');
      const envNames = insp.Config.Env.map((e) => e.split('=')[0]);
      assert(envNames.includes('CLAUDE_CODE_OAUTH_TOKEN'), 'Claude token passed as env');
      assert(
        !envNames.includes('ORCH_AGENT_CREDENTIAL') && !envNames.includes('DOCKER_HOST'),
        'no agent secrets in env',
      );
      const inside = docker([
        'exec',
        c.name,
        'sh',
        '-c',
        'id -u; [ -e /var/run/docker.sock ] && echo SOCK || echo nosock; grep CapEff /proc/self/status | tr -s "\\t " " "; ls -A /home 2>/dev/null | wc -l; [ -x /opt/e2e/claude ] && echo claude-ok',
      ]).stdout.split('\n');
      log(`  inside the sandbox: ${inside.join(' | ')}`);
      assert(inside[0] !== '0', 'runs as non-root inside', inside[0]);
      assert(inside[1] === 'nosock', 'no docker socket inside');
      assert(/CapEff: 0+$/.test(inside[2].trim()), 'CapEff is 0', inside[2]);
      assert(inside[3] === '0', 'no host home content');
      assert(inside[4] === 'claude-ok', 'claude binary copied in (docker cp)');
      const tokenFiles = docker([
        'exec',
        c.name,
        'sh',
        '-c',
        `grep -rl "${FAKE_CLAUDE_TOKEN}" /workspace 2>/dev/null | wc -l`,
      ]).stdout.trim();
      assert(tokenFiles === '0', 'Claude token not written into the clone');

      const screens = compose(['exec', '-T', 'bob', 'screen', '-ls'], { allowFail: true }).stdout;
      assert(
        new RegExp(`issue-${n}\\b`).test(screens),
        'screen session exists in the agent container',
        screens,
      );
      const tv = await waitStatus(n, ['IN_PROGRESS']);
      assert(tv.assignee?.githubLogin === 'bob', 'assigned to bob', tv.assignee);
      const offers = assignmentsOf(t.id);
      assert(
        offers.every((a) => a.login !== 'alice'),
        'alice (paused) got nothing',
        offers,
      );

      // The member edits the clone inside the sandbox (as Claude would in the screen session).
      docker(['exec', c.name, 'sh', '-c', 'echo "edited by bob in the sandbox" > MANUAL.md']);
      orch('bob', ['status']);
      const done = orch('bob', ['done', `${PROJECT}#${n}`], { allowFail: true });
      assert(done.status === 0, 'orch done succeeded', done.stderr);

      const st = await waitFor('PR on the fake GitHub', async () => {
        const s = await ghState();
        const pr = s.pulls.find((p) => p.head.ref.startsWith(`orch/issue-${n}-`));
        return pr ? { s, pr } : null;
      });
      assert(
        st.s.branches[st.pr.head.ref],
        'task branch pushed to the fake git server',
        Object.keys(st.s.branches),
      );
      assert(
        st.pr.draft === false && st.pr.base.ref === 'main',
        'manual PR is ready for review on main',
        st.pr,
      );
      // Agent tokens: scoped to the one repo, contents only (clone: read, push: write).
      const scoped = st.s.tokens.filter(
        (k) =>
          k.permissions?.contents &&
          Object.keys(k.permissions).every((p) => p === 'contents' || p === 'metadata'),
      );
      const onlyWidgets = (k) =>
        k.repositories?.length === 1 && k.repositories[0].name === 'widgets';
      assert(
        scoped.some((k) => k.permissions.contents === 'read' && onlyWidgets(k)),
        'a contents:read token scoped to the repo was minted for the clone',
        st.s.tokens,
      );
      assert(
        scoped.some((k) => k.permissions.contents === 'write' && onlyWidgets(k)),
        'a contents:write token scoped to the repo was minted for the push',
        st.s.tokens,
      );
      const inReview = await waitStatus(n, ['IN_REVIEW']);
      assert(inReview.prNumber === st.pr.number, 'task knows its PR', inReview);
      await waitFor(
        'task container removed after done',
        async () => taskContainers(n).length === 0,
      );
      assert(existsSync(clone), 'clone kept until merge');

      const m = await mergePr(st.pr.number);
      assert(m.merged && m.delivery.status === 200, 'merge webhook accepted', m);
      await waitStatus(n, ['DONE']);
      await waitFor(
        'cleanup removed the clone',
        async () => !existsSync(`${WORK.bob}/${c.assignmentId}`),
      );
      orch('alice', ['resume']);
    },
  );

  await step('webhooks: bad signature rejected, replay deduped', async () => {
    const payload = { zen: 'e2e', hook_id: 1 };
    const bad = await signedWebhook('ping', payload, { badSignature: true });
    assert(bad.status === 401, 'bad signature -> 401', bad);
    const id = randomUUID();
    const ok = await signedWebhook('ping', payload, { deliveryId: id });
    assert(ok.status === 200 && ok.body.result === 'pong', 'signed ping', ok);
    const again = await signedWebhook('ping', payload, { deliveryId: id });
    assert(again.status === 200 && again.body.duplicate === true, 'replay deduped', again);
  });

  await step(
    'd0. alice leaves and re-joins while her agent is connected: config.update reaches it at once',
    async () => {
      const agentLog = () =>
        compose(['logs', '--no-color', '--no-log-prefix', 'alice'], {
          allowFail: true,
          maxBuffer: 256 * 1024 * 1024,
        })
          .stdout.split('\n')
          .filter((l) => l.includes('config updated'));
      const before = agentLog().length;
      const left = await users.alice.api('PUT', `/api/projects/${project.id}/participation`, {
        participating: false,
        budgetPercent: 50,
        mode: 'auto',
      });
      assert(left.status === 'inactive', 'alice left', left);
      await waitFor(
        'alice agent dropped the project',
        async () =>
          agentLog()
            .slice(before)
            .some((l) => l.includes('"participations":[]')),
        30_000,
      );
      const mid = agentLog().length;
      const back = await users.alice.api('PUT', `/api/projects/${project.id}/participation`, {
        participating: true,
        budgetPercent: 50,
        mode: 'auto',
      });
      assert(back.status === 'active', 'alice active again (still approved)', back);
      await waitFor(
        'alice agent got the participation back',
        async () =>
          agentLog()
            .slice(mid)
            .some((l) => l.includes(`${PROJECT}:AUTO`)),
        30_000,
      );
    },
  );

  let autoPr;
  await step(
    'd. auto: task -> offered to alice (auto), never auto to bob -> fake claude -p in the sandbox -> push -> draft PR -> merge -> DONE',
    async () => {
      await waitFor(
        'alice resumed on the server',
        async () => (await agentView('alice', 'alice-laptop'))?.paused === false,
      );
      const t = await createTask('Auto change by the pool');
      const n = t.issueNumber;
      const tv = await waitStatus(n, ['IN_REVIEW'], 300_000, () => bobDeclinesRequests(t.id));
      const as = await waitFor('the auto run to be reported SUCCEEDED', async () => {
        const list = assignmentsOf(t.id);
        return list.some((a) => a.status === 'SUCCEEDED') ? list : null;
      });
      log(`  assignments: ${JSON.stringify(as)}`);
      const run = as.find((a) => a.status === 'SUCCEEDED');
      assert(
        run && run.login === 'alice' && run.kind === 'AUTO_OFFER' && run.execMode === 'AUTO',
        'ran on alice from an auto offer',
        as,
      );
      assert(
        !as.some((a) => a.login === 'bob' && a.kind === 'AUTO_OFFER'),
        'bob never got an auto offer',
        as,
      );
      recordAssignment(run.id);
      assert(
        psql(
          `select count(*) from "Assignment" where "taskId"='${t.id}' and "reason" like 'not_participating%'`,
        )[0]?.[0] === '0',
        'no not_participating rejection after re-joining',
      );
      const s = await ghState();
      autoPr = s.pulls.find((p) => p.number === tv.prNumber);
      assert(autoPr && autoPr.draft === true, 'auto PR is a draft', {
        autoPr,
        prNumber: tv.prNumber,
        status: tv.status,
        pulls: s.pulls.map((p) => [p.number, p.draft]),
      });
      const runFile = Object.keys(s.branches).includes(autoPr.head.ref);
      assert(runFile, 'auto branch pushed');
      // The run log of `claude -p` was written by the agent.
      const logs = orch('alice', ['logs', `${PROJECT}#${n}`, '--no-follow'], { allowFail: true });
      assert(
        logs.status === 0 && /"type":"result","subtype":"success"/.test(logs.stdout),
        'run log has the result event',
        logs.stdout,
      );
      const files = await gh(`/_e2e/files?ref=${encodeURIComponent(autoPr.head.ref)}`);
      assert(
        files.some((f) => /^fake-claude\/run-.*\.txt$/.test(f)),
        'the file written by claude -p in the sandbox was pushed',
        files,
      );
      const m = await mergePr(autoPr.number);
      assert(m.merged && m.delivery.status === 200, 'merge webhook accepted', m);
      await waitStatus(n, ['DONE']);
      await waitFor(
        'alice cleanup removed the clone',
        async () => !existsSync(`${WORK.alice}/${run.id}`),
      );
    },
  );

  await step(
    'e. consent: paused bob gets nothing; broadcast = auto offer for alice, request for bob',
    async () => {
      orch('bob', ['pause']);
      await waitFor(
        'bob paused on the server',
        async () => (await agentView('bob', 'bob-desktop'))?.paused,
      );
      const t1 = await createTask('Pool task while bob is paused');
      const tv1 = await waitStatus(t1.issueNumber, ['IN_REVIEW'], 300_000);
      const a1 = assignmentsOf(t1.id);
      assert(
        a1.every((a) => a.login !== 'bob'),
        'paused bob got no offer',
        a1,
      );
      recordAssignment(a1.find((a) => a.login === 'alice')?.id);
      orch('bob', ['resume']);
      await waitFor(
        'bob resumed',
        async () => (await agentView('bob', 'bob-desktop'))?.paused === false,
      );
      // Fresh usage from bob after the resume (eligibility needs a recent report).
      await sleep(6000);

      const t2 = await createTask('Broadcast task', { dispatch: { mode: 'broadcast' } });
      await waitFor(
        'broadcast offers',
        async () => {
          const as = assignmentsOf(t2.id);
          return as.some((a) => a.login === 'alice' && a.kind === 'AUTO_OFFER') &&
            as.some((a) => a.login === 'bob' && a.kind === 'CONSENT_REQUEST')
            ? as
            : null;
        },
        60_000,
        500,
      );
      const tv2 = await waitStatus(t2.issueNumber, ['IN_REVIEW'], 300_000);
      const a2 = assignmentsOf(t2.id);
      log(`  broadcast assignments: ${JSON.stringify(a2)}`);
      assert(
        !a2.some((a) => a.login === 'bob' && a.kind === 'AUTO_OFFER'),
        'bob never gets an auto offer',
        a2,
      );
      const bobReq = a2.find((a) => a.login === 'bob');
      assert(
        bobReq && bobReq.status !== 'PENDING' && bobReq.status !== 'ACCEPTED',
        'bob request withdrawn after alice won',
        a2,
      );
      recordAssignment(a2.find((a) => a.login === 'alice' && a.kind === 'AUTO_OFFER')?.id);
      const bobOffers = await users.bob.get('/api/offers/mine');
      assert(
        !bobOffers.some((o) => o.task?.issueNumber === t2.issueNumber && o.status === 'PENDING'),
        'nothing pending for bob',
        bobOffers,
      );
      for (const tv of [tv1, tv2]) {
        const m = await mergePr(tv.prNumber);
        assert(m.merged && m.delivery.status === 200, 'merged', m);
        await waitStatus(tv.issueNumber, ['DONE']);
      }
    },
  );

  await step(
    'f. MCP: PAT -> submit_task with 2 dependent subtasks -> b blocked until a is merged',
    async () => {
      const pat = await users.olivia.post('/api/tokens', { name: 'e2e' });
      assert(
        pat.token?.startsWith('orch_pat_') && pat.mcpAddCommand.includes('/mcp'),
        'PAT created',
        Object.keys(pat),
      );
      const unauth = await mcp('orch_pat_invalid', 'tools/list', {});
      assert(unauth.status === 401, 'MCP rejects a bad token', unauth);
      const res = await mcpTool(pat.token, 'submit_task', {
        projectFullName: PROJECT,
        integrationBranch: 'feat/e2e-batch',
        tasks: [
          {
            ref: 'a',
            title: 'Batch step A',
            description: 'First step.',
            acceptanceCriteria: ['file A'],
            size: 'S',
            model: 'sonnet',
          },
          {
            ref: 'b',
            title: 'Batch step B',
            description: 'Second step, needs A.',
            acceptanceCriteria: ['file B'],
            size: 'S',
            model: 'sonnet',
            dependsOn: ['a'],
          },
        ],
      });
      log(`  submit_task -> ${JSON.stringify(res)}`);
      assert(res.created === 2, 'two tasks created', res);
      const a = res.tasks.find((x) => x.ref === 'a');
      const b = res.tasks.find((x) => x.ref === 'b');
      assert(b.dependsOn.includes(a.issueNumber), 'b depends on a', res);
      const s0 = await ghState();
      assert(
        s0.branches['feat/e2e-batch'],
        'integration branch created on GitHub',
        Object.keys(s0.branches),
      );
      const ta = await taskByIssue(a.issueNumber);
      const tb = await taskByIssue(b.issueNumber);
      assert(tb.status === 'BLOCKED', 'b is BLOCKED', tb.status);

      const tva = await waitStatus(a.issueNumber, ['IN_REVIEW'], 300_000, () =>
        bobDeclinesRequests(ta.id),
      );
      const sa = await ghState();
      const pra = sa.pulls.find((p) => p.number === tva.prNumber);
      assert(pra.base.ref === 'feat/e2e-batch', 'a PR targets the integration branch', pra);
      recordAssignment(
        (
          await waitFor('a SUCCEEDED', async () =>
            assignmentsOf(ta.id).find((x) => x.status === 'SUCCEEDED'),
          )
        ).id,
      );
      const stillBlocked = await taskByIssue(b.issueNumber);
      assert(
        stillBlocked.status === 'BLOCKED' && assignmentsOf(tb.id).length === 0,
        'b still blocked and never offered while a is in review',
        stillBlocked.status,
      );
      const st = await mcpTool(pat.token, 'task_status', {
        projectFullName: PROJECT,
        issueNumber: b.issueNumber,
      });
      log(`  task_status(b) -> ${JSON.stringify(st).slice(0, 300)}`);

      const m = await mergePr(pra.number);
      assert(m.merged && m.delivery.status === 200, 'merged a', m);
      await waitStatus(a.issueNumber, ['DONE']);
      const tvb = await waitStatus(b.issueNumber, ['IN_REVIEW'], 300_000, () =>
        bobDeclinesRequests(tb.id),
      );
      const sb = await ghState();
      const prb = sb.pulls.find((p) => p.number === tvb.prNumber);
      assert(prb.base.ref === 'feat/e2e-batch', 'b PR targets the integration branch', prb);
      recordAssignment(
        (
          await waitFor('b SUCCEEDED', async () =>
            assignmentsOf(tb.id).find((x) => x.status === 'SUCCEEDED'),
          )
        ).id,
      );
      const mb = await mergePr(prb.number);
      assert(mb.merged && mb.delivery.status === 200, 'merged b', mb);
      await waitStatus(b.issueNumber, ['DONE']);
    },
  );

  await step(
    'g. MCP OAuth: SDK client discovers, registers, signs in with GitHub, approves (PKCE), calls a tool',
    async () => {
      // The MCP SDK installed for the server (same one Claude Code's flow is modeled on).
      const sdk = `${REPO}/apps/server/node_modules/@modelcontextprotocol/sdk/dist/esm`;
      const { auth } = await import(`${sdk}/client/auth.js`);
      const { Client } = await import(`${sdk}/client/index.js`);
      const { StreamableHTTPClientTransport } = await import(`${sdk}/client/streamableHttp.js`);
      const redirect = 'http://127.0.0.1:33418/callback';
      const store = { client: undefined, tokens: undefined, verifier: '', authUrl: undefined };
      const provider = {
        get redirectUrl() {
          return redirect;
        },
        get clientMetadata() {
          return {
            client_name: 'orch-e2e (Claude Code)',
            redirect_uris: [redirect],
            grant_types: ['authorization_code', 'refresh_token'],
            response_types: ['code'],
            token_endpoint_auth_method: 'none',
          };
        },
        state: () => 'e2e-state',
        clientInformation: () => store.client,
        saveClientInformation: (c) => (store.client = c),
        tokens: () => store.tokens,
        saveTokens: (t) => (store.tokens = t),
        redirectToAuthorization: (u) => (store.authUrl = u),
        saveCodeVerifier: (v) => (store.verifier = v),
        codeVerifier: () => store.verifier,
      };
      const serverUrl = new URL(`${SERVER}/mcp`);
      const first = await auth(provider, { serverUrl });
      assert(first === 'REDIRECT' && store.authUrl, 'SDK starts the authorization', first);
      assert(store.client?.client_id?.startsWith('orch_cli_'), 'client registered', store.client);

      // A fresh browser (no orch session): authorize -> GitHub sign-in -> back -> consent.
      const browser = new Session('olivia');
      const loc = (r) => new URL(r.headers.get('location'), SERVER);
      let r = await browser.raw('GET', `${store.authUrl.pathname}${store.authUrl.search}`);
      assert(r.status === 302 && loc(r).pathname === '/api/auth/github/login', 'sent to sign-in');
      r = await browser.raw('GET', `${loc(r).pathname}${loc(r).search}`);
      const ghAuthorize = new URL(r.headers.get('location'));
      ghAuthorize.searchParams.set('login', 'olivia');
      const r2 = await fetch(ghAuthorize, { redirect: 'manual' });
      const cb = new URL(r2.headers.get('location'));
      r = await browser.raw('GET', `${cb.pathname}${cb.search}`);
      assert(r.status === 302 && loc(r).pathname === '/api/oauth/authorize', 'back to authorize');
      r = await browser.raw('GET', `${loc(r).pathname}${loc(r).search}`);
      const consentUrl = loc(r);
      assert(consentUrl.pathname === '/oauth/consent', 'consent page', consentUrl.href);
      const info = await browser.get(`/api/oauth/consent${consentUrl.search}`);
      assert(info.clientName === 'orch-e2e (Claude Code)' && info.login === 'olivia', 'info', info);
      const params = Object.fromEntries(consentUrl.searchParams);
      const res = await browser.raw(
        'POST',
        '/api/oauth/consent',
        { ...params, approve: true },
        { origin: SERVER },
      );
      assert(res.status === 200, 'consent approved', res.status);
      const back = new URL((await res.json()).redirectTo);
      assert(back.searchParams.get('state') === 'e2e-state', 'state passed through', back.href);
      const done = await auth(provider, {
        serverUrl,
        authorizationCode: back.searchParams.get('code'),
      });
      assert(done === 'AUTHORIZED', 'tokens issued', done);
      assert(store.tokens.access_token.startsWith('orch_oat_'), 'OAuth access token', '');

      const client = new Client({ name: 'orch-e2e', version: '0' });
      await client.connect(
        new StreamableHTTPClientTransport(serverUrl, { authProvider: provider }),
      );
      const out = await client.callTool({
        name: 'list_tasks',
        arguments: { projectFullName: PROJECT },
      });
      assert(!out.isError, 'list_tasks over OAuth', out);
      log(`  list_tasks via OAuth -> ${out.content?.[0]?.text?.slice(0, 120)}`);
      await client.close();
      const grants = await browser.get('/api/oauth/grants');
      assert(
        grants.some((g) => g.clientName === 'orch-e2e (Claude Code)'),
        'grant listed',
        grants,
      );
    },
  );

  await step(
    'invariants: no auto offer ever went to bob; no task container left; work merged',
    async () => {
      const main = await gh('/_e2e/files?ref=main');
      assert(main.includes('MANUAL.md'), 'manual change merged into main', main);
      assert(
        main.filter((f) => f.startsWith('fake-claude/run-')).length >= 3,
        'auto runs merged into main',
        main,
      );
      const batch = await gh('/_e2e/files?ref=feat%2Fe2e-batch');
      const runs = (l) => l.filter((f) => f.startsWith('fake-claude/run-')).length;
      assert(
        runs(batch) === runs(main) + 2,
        'both batch runs merged into the integration branch (not main)',
        { batch, main },
      );
      const rows = psql(
        `select count(*) from "Assignment" a join "User" u on u.id=a."userId" where u.login='bob' and a.kind='AUTO_OFFER'`,
      );
      assert(rows[0][0] === '0', 'no AUTO_OFFER for bob', rows);
      await waitFor(
        'no task containers left',
        async () =>
          docker(['ps', '-a', '--filter', 'label=orch.task', '--format', '{{.Names}} {{.Mounts}}'])
            .stdout.split('\n')
            .filter(
              (l) => l.includes('orch-task-') && (l.includes(WORK.alice) || l.includes(WORK.bob)),
            ).length === 0,
      );
    },
  );

  /** `orch login --token-stdin --no-setup` on alice (the CLI then runs the real check). */
  const aliceLogin = (token) => {
    const r = compose(['exec', '-T', 'alice', 'orch', 'login', '--token-stdin', '--no-setup'], {
      input: `${token}\n`,
      allowFail: true,
    });
    log(`  alice$ orch login --token-stdin --no-setup -> ${r.status}\n${r.stdout.trimEnd()}`);
    return r;
  };
  const aliceAutoOffers = (taskId) =>
    assignmentsOf(taskId).filter((a) => a.login === 'alice' && a.kind === 'AUTO_OFFER');

  await step(
    'h. rejected Claude token: orch login 401 -> agent flagged, no auto offer -> valid login + doctor -> the task runs',
    async () => {
      const before = await agentView('alice', 'alice-laptop');
      const bad = aliceLogin(REJECTED_CLAUDE_TOKEN);
      assert(bad.status !== 0, 'orch login with a rejected token exits non-zero', bad.status);
      assert(
        bad.stdout.includes('✗ Claude rejected this token (401)'),
        'orch login says Claude rejected the token',
        bad.stdout,
      );
      const flagged = await waitFor(
        'alice flagged by the check',
        async () => {
          const v = await agentView('alice', 'alice-laptop');
          return v?.claudeAuthValid === false ? v : null;
        },
        60_000,
      );
      assert(
        flagged.claudeAuthCheckedAt && flagged.claudeAuthCheckedAt !== before?.claudeAuthCheckedAt,
        'claudeAuthCheckedAt set by the check',
        flagged,
      );
      const t = await createTask('Runs after a verified Claude login');
      const n = t.issueNumber;
      // Several dispatch cycles (DISPATCHER_INTERVAL_MS=1000): alice must get no offer.
      for (let i = 0; i < 12; i++) {
        await bobDeclinesRequests(t.id);
        assert(aliceAutoOffers(t.id).length === 0, 'no auto offer to a flagged agent', i);
        await sleep(1000);
      }
      const why = await users.olivia.get(`/api/tasks/${t.id}/why-not-running`);
      const alice = why.members.find((m) => m.user.githubLogin === 'alice');
      assert(
        alice?.reasons[0]?.code === 'claude_login_expired',
        'why-not-running: Claude login expired for alice',
        why,
      );
      const status = orch('alice', ['status'], { allowFail: true });
      assert(/login expired/i.test(status.stdout), 'orch status shows the expired login', status);
      assert((await taskByIssue(n))?.status !== 'IN_PROGRESS', 'the task is not running');

      const good = aliceLogin(FAKE_CLAUDE_TOKEN);
      assert(good.status === 0, 'orch login with a valid token', good.stderr);
      assert(good.stdout.includes('✓ Claude login verified'), 'orch login verified', good.stdout);
      const doc = orch('alice', ['doctor'], { allowFail: true });
      assert(doc.status === 0, 'orch doctor exits 0', doc);
      assert(doc.stdout.includes('✓ Claude login verified'), 'orch doctor verified', doc.stdout);
      const cleared = await waitFor(
        'alice login valid again on the server',
        async () => {
          const v = await agentView('alice', 'alice-laptop');
          return v?.claudeAuthValid === true ? v : null;
        },
        60_000,
      );
      assert(
        cleared.claudeAuthCheckedAt &&
          Date.parse(cleared.claudeAuthCheckedAt) > Date.parse(flagged.claudeAuthCheckedAt),
        'claudeAuthCheckedAt updated by the valid check',
        cleared,
      );
      await waitStatus(n, ['IN_REVIEW'], 300_000, () => bobDeclinesRequests(t.id));
      const runs = assignmentsOf(t.id);
      assert(
        runs.some(
          (a) => a.login === 'alice' && a.kind === 'AUTO_OFFER' && a.status === 'SUCCEEDED',
        ),
        'ran on alice after the verified login',
        runs,
      );
      for (const a of runs) recordAssignment(a.id);
    },
  );

  await step(
    'i. Claude login revoked after the check: 401 run -> agent flagged, no auto offer -> orch login -> the task runs',
    async () => {
      const revoked = aliceLogin(REVOKED_CLAUDE_TOKEN);
      assert(revoked.status === 0, 'orch login (token still accepted by the check)', revoked);
      await waitFor(
        'alice valid after the check',
        async () => (await agentView('alice', 'alice-laptop'))?.claudeAuthValid === true,
        60_000,
      );
      const t = await createTask('Runs after a fresh Claude login');
      const n = t.issueNumber;
      await waitFor(
        'alice flagged: Claude login expired',
        async () => {
          await bobDeclinesRequests(t.id);
          const v = await agentView('alice', 'alice-laptop');
          return v?.claudeAuthValid === false ? v : null;
        },
        300_000,
        2000,
      );
      const failed = psql(
        `select "failureClass" from "Assignment" where "taskId"='${t.id}' and status='FAILED'`,
      );
      assert(
        failed.length >= 1 && failed.every(([c]) => c === 'claude_auth'),
        'the failed run is classified claude_auth',
        failed,
      );
      const why = await users.olivia.get(`/api/tasks/${t.id}/why-not-running`);
      const alice = why.members.find((m) => m.user.githubLogin === 'alice');
      assert(
        alice?.reasons[0]?.code === 'claude_login_expired',
        'why-not-running: Claude login expired for alice',
        why,
      );
      const status = orch('alice', ['status'], { allowFail: true });
      assert(/login expired/i.test(status.stdout), 'orch status shows the expired login', status);
      const card = await taskByIssue(n);
      assert(card.failedAttempts >= 1 && /401/.test(card.lastError ?? ''), 'card shows it', card);

      const good = aliceLogin(FAKE_CLAUDE_TOKEN);
      assert(good.status === 0, 'orch login on alice', good.stderr);
      await waitFor(
        'alice login valid again on the server',
        async () => (await agentView('alice', 'alice-laptop'))?.claudeAuthValid === true,
        60_000,
      );
      await waitStatus(n, ['IN_REVIEW'], 300_000, () => bobDeclinesRequests(t.id));
      const runs = assignmentsOf(t.id);
      assert(
        runs.some((a) => a.login === 'alice' && a.status === 'SUCCEEDED'),
        'ran on alice after the login',
        runs,
      );
      for (const a of runs) recordAssignment(a.id);
    },
  );

  // API only, last: no task is dispatched here, so earlier dispatch assertions are unaffected.
  await step(
    'j. owner joins and leaves their own pool; reject with a reason, member sees it, undo',
    async () => {
      const o = users.olivia;
      const base = `/api/projects/${project.id}`;
      const own = await o.api('PUT', `${base}/participation`, {
        participating: true,
        budgetPercent: 5,
        mode: 'approval',
      });
      assert(own.status === 'active', 'owner participation is auto-approved', own);
      const off = await o.api('PUT', `${base}/participation`, {
        participating: false,
        budgetPercent: 5,
        mode: 'approval',
      });
      assert(off.status === 'inactive', 'owner opted out', off);

      const before = project.whoCanParticipate;
      await o.api('PATCH', base, { whoCanParticipate: 'ALL_MEMBERS' });
      try {
        const req = await sam.api('PUT', `${base}/participation`, {
          participating: true,
          budgetPercent: 10,
          mode: 'approval',
        });
        assert(req.status === 'pending', 'sam is pending', req);
        const rej = await o.post(`${base}/participants/${sam.me.id}/reject`, {
          reason: 'e2e: not this sprint',
        });
        assert(rej.status === 'rejected', 'sam rejected', rej);
        const disc = await sam.get('/api/projects/discover');
        const mine = disc.find((i) => i.project.id === project.id)?.myParticipation;
        assert(
          mine?.status === 'rejected' && mine.rejectionReason === 'e2e: not this sprint',
          'sam sees the reason in discover',
          mine,
        );
        const undo = await o.post(`${base}/participants/${sam.me.id}/undo-rejection`, {
          to: 'pending',
        });
        assert(undo.status === 'pending' && undo.rejectionReason === null, 'undone', undo);
        const audit = psql(
          `select action from "AuditLog" where "projectId"='${project.id}' and "targetUserId"='${sam.me.id}' order by id`,
        ).map(([a]) => a);
        assert(
          audit.includes('participation.rejected') &&
            audit.includes('participation.rejection_undone'),
          'rejection and undo are audited',
          audit,
        );
        await sam.api('PUT', `${base}/participation`, {
          participating: false,
          budgetPercent: 10,
          mode: 'approval',
        });
      } finally {
        await o.api('PATCH', base, { whoCanParticipate: before });
      }
    },
  );
}

main()
  .catch(() => undefined)
  .finally(() => {
    console.log('\n===== E2E RESULTS =====');
    for (const r of results)
      console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}  (${Math.round(r.ms / 1000)} s)`);
    const failed = results.some((r) => !r.ok) || results.length === 0;
    if (failed && current) console.log(`stopped at: ${current}`);
    process.exit(failed ? 1 : 0);
  });
