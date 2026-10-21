// Seeds the UI test stack through the real HTTP API (test/ui/stack.sh runs it in phases, then
// seed.sql sets the states the API cannot reach). Prints no secrets.
import { writeFileSync } from 'node:fs';
import { Session, oauthRequest, BASE } from './lib/api.mjs';

const phase = process.argv[2];
const PROJECT = 'acme/widgets';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const users = Object.fromEntries(
  ['olivia', 'alice', 'bob', 'rita'].map((l) => [l, new Session(l)]),
);
const log = (...a) => console.log('[seed]', ...a);

async function signAll() {
  for (const s of Object.values(users)) s.me = await s.signIn();
}
const projectId = async () =>
  (await users.olivia.get('/api/projects/mine')).find((p) => p.fullName === PROJECT).id;

if (phase === 'phase1') {
  await signAll();
  const o = users.olivia;
  const repos = await o.get('/api/repos/available');
  const repo = repos.find((r) => r.fullName === PROJECT);
  let p = await o.post('/api/projects', { githubRepoId: repo.githubRepoId });
  p = await o.api('PATCH', `/api/projects/${p.id}`, { requireParticipantApproval: true });
  const a = await users.alice.api('PUT', `/api/projects/${p.id}/participation`, {
    participating: true,
    budgetPercent: 50,
    mode: 'auto',
  });
  const b = await users.bob.api('PUT', `/api/projects/${p.id}/participation`, {
    participating: true,
    budgetPercent: 30,
    mode: 'approval',
  });
  for (const u of [users.alice, users.bob])
    await o.post(`/api/projects/${p.id}/participants/${u.me.id}/approve`);
  const t = await users.alice.post('/api/agents/enrollment-tokens');
  writeFileSync('/work/enroll-alice.txt', t.token, { mode: 0o600 });
  log('project', p.fullName, 'participation', a.status, b.status);
} else if (phase === 'wait-agent') {
  await users.alice.signIn();
  for (let i = 0; i < 90; i++) {
    const l = await users.alice.get('/api/agents/mine');
    if (l.some((x) => x.connected)) {
      log('alice agent connected');
      process.exit(0);
    }
    await sleep(1000);
  }
  throw new Error('agent never connected');
} else if (phase === 'phase2') {
  await signAll();
  const o = users.olivia;
  const pid = await projectId();
  // rita (GitHub read access) may not participate: she sees the "cannot participate" explanation
  await o.api('PATCH', `/api/projects/${pid}`, { whoCanParticipate: 'ALLOWLIST' });
  // pause alice so the dispatcher leaves the TODO tasks alone
  const agent = (await users.alice.get('/api/agents/mine')).find(
    (x) => x.machineName === 'alice-laptop',
  );
  await users.alice.post(`/api/agents/${agent.id}/pause`);
  const mk = (title, extra = {}) =>
    o.post(`/api/projects/${pid}/tasks`, {
      title,
      body: `UI test task: ${title}.`,
      acceptanceCriteria: ['it works'],
      size: 'S',
      model: 'SONNET',
      ...extra,
    });
  const todo = await mk('UI todo task');
  await mk('UI blocked task', { dependsOn: [todo.id] });
  await mk('UI in progress task');
  await mk('UI in review task');
  await mk('UI done task');
  await mk('UI failed task');
  await mk('UI proposed task');
  await mk('UI members-only task', { dispatch: { mode: 'members', memberIds: [users.bob.me.id] } });
  // tokens
  await users.alice.post('/api/tokens', { name: 'laptop-cli' });
  await users.alice.post('/api/tokens', { name: 'ci-bot', expiresInDays: 30 });
  const old = await users.alice.post('/api/tokens', { name: 'old-token' });
  await users.alice.api('DELETE', `/api/tokens/${old.id}`);
  // OAuth grant for alice (client registered, consent approved, code exchanged)
  const r = await oauthRequest('Claude Code (seed)');
  const res = await users.alice.raw('POST', '/api/oauth/consent', {
    client_id: r.client.client_id,
    redirect_uri: r.redirect,
    response_type: 'code',
    code_challenge: r.params.get('code_challenge'),
    code_challenge_method: 'S256',
    state: 'x',
    resource: r.params.get('resource'),
    approve: true,
  });
  const code = new URL((await res.json()).redirectTo).searchParams.get('code');
  const tok = await fetch(`${BASE}/api/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: r.redirect,
      client_id: r.client.client_id,
      code_verifier: r.verifier,
      resource: r.params.get('resource'),
    }),
  });
  log('oauth token exchange', tok.status);
  // access admin data: a pre-approved and a denied login
  await o.post('/api/admin/access/grants', { githubLogin: 'newcomer' });
  const ghost = await o.post('/api/admin/access/grants', { githubLogin: 'ghosty' });
  await o.post(`/api/admin/access/grants/${ghost.grant.id}/deny`).catch(() => undefined);
  await o.post('/api/admin/access/invites', { multiUse: false, expiresInHours: 24 });
  log('phase2 done');
} else if (phase === 'verify') {
  await signAll();
  const board = await users.olivia.get(`/api/projects/${await projectId()}/tasks`);
  log('board columns', Object.fromEntries(Object.entries(board).map(([k, v]) => [k, v.length])));
  log(
    'alice agents',
    (await users.alice.get('/api/agents/mine')).map(
      (a) => `${a.machineName} v${a.version} upd=${a.updateAvailable}`,
    ),
  );
}
