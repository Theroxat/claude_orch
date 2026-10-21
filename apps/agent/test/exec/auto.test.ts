/** Auto mode (M4): consent guard, headless claude -p run, timeout, cancel, requests, restart. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { serverMessage, type ServerMessage, type TaskOfferPayload } from '@orch/shared';
import { ClaudeAuthState, CLAUDE_AUTH_REJECT_PREFIX } from '../../src/claude-auth';
import { MAX_TURNS, buildAutoArgv, parseResultEvent } from '../../src/exec/claude-run';
import { ExecError, ManualExecutor, type ExecutorConfig } from '../../src/exec/executor';
import { silentLogger } from '../../src/log';
import { tempDir, waitFor } from '../helpers/util';
import {
  FakeDocker,
  FakeGit,
  FakeProc,
  FakeScreen,
  offer,
  recordingFs,
  resultLine,
  type FakeRun,
} from './fakes';

const CLAUDE_TOKEN = 'sk-ant-oat01-' + 'Au7'.repeat(20);
const GH_TOKEN = 'ghs_' + 'Aut0'.repeat(10);

interface Sent {
  id: string;
  type: string;
  payload: Record<string, unknown>;
}

let tmp: ReturnType<typeof tempDir>;
beforeEach(() => (tmp = tempDir()));
afterEach(() => tmp.cleanup());

type Mode = 'AUTO' | 'APPROVAL';

function setup(opts: { paused?: boolean; max?: number; mode?: Mode; models?: string[] } = {}) {
  const git = new FakeGit();
  const docker = new FakeDocker();
  const screen = new FakeScreen();
  const proc = new FakeProc();
  const fs = recordingFs();
  const sent: Sent[] = [];
  const state = { paused: opts.paused ?? false, mode: opts.mode ?? ('AUTO' as Mode) };
  let n = 0;
  const cfg: ExecutorConfig = {
    agentId: 'agt_test',
    workDir: join(tmp.dir, 'work'),
    dataDir: join(tmp.dir, 'data'),
    maxConcurrent: opts.max ?? 1,
    gitBaseUrl: 'https://github.com',
    defaultImage: 'node:22-bookworm',
    claudeBin: '/opt/orch/bin/claude',
    uid: process.getuid?.() || 1000,
    gid: process.getgid?.() || 1000,
    identity: { name: 'orch', email: 'orch@example.com' },
    claimTimeoutMs: 500,
    acceptTimeoutMs: 300,
    timeoutUnitMs: 1,
  };
  const deps = {
    git,
    docker,
    screen,
    proc,
    fs,
    requestToken: async () => GH_TOKEN,
    enqueue: (type: string, payload: unknown) => {
      const id = `m${++n}`;
      sent.push({ id, type, payload: payload as Record<string, unknown> });
      return id;
    },
    isPaused: () => state.paused,
    readClaudeToken: () => CLAUDE_TOKEN,
    participations: () => [
      {
        projectId: 'prj_1',
        fullName: 'acme/widgets',
        percent: 50,
        mode: state.mode,
        allowedModels: opts.models ?? ['SONNET', 'OPUS'],
      },
    ],
    logger: silentLogger,
  };
  const make = () => new ManualExecutor(cfg, deps as never);
  const ex = make();
  const of = (type: string) => sent.filter((s) => s.type === type);
  return { ex, make, git, docker, screen, proc, fs, sent, of, state, cfg };
}

const future = () => new Date(Date.now() + 60_000).toISOString();
const autoOffer = (over: Parameters<typeof offer>[0] = {}): TaskOfferPayload =>
  offer({ kind: 'AUTO_OFFER', execMode: 'AUTO', accepted: false, expiresAt: future(), ...over });
const msg = (p: TaskOfferPayload): ServerMessage => serverMessage('task.offer', p);

/** Delivers the offer and acks our offer.accept like the server does. */
function acceptAndAck(t: ReturnType<typeof setup>, p: TaskOfferPayload): void {
  t.ex.handle(msg(p));
  const accept = t.of('offer.accept').find((s) => s.payload.assignmentId === p.assignmentId);
  expect(accept?.payload).toEqual({ assignmentId: p.assignmentId, execMode: 'AUTO' });
  t.ex.onAck(accept!.id, { ok: true });
}

const finishOk = (run: FakeRun) => {
  run.stdout(JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-sonnet' }));
  run.stdout(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text' }] } }));
  run.stdout(resultLine());
  run.finish(0);
};

describe('auto mode: local consent guard', () => {
  it('rejects when paused, at max concurrency, with an unknown kind or a non-AUTO exec mode', async () => {
    const paused = setup({ paused: true });
    paused.ex.handle(msg(autoOffer()));
    expect(paused.of('offer.reject')[0]?.payload).toMatchObject({ reason: 'paused' });

    const full = setup({ max: 1 });
    acceptAndAck(full, autoOffer({ assignmentId: 'asg_a' }));
    full.ex.handle(msg(autoOffer({ assignmentId: 'asg_b', issueNumber: 7 })));
    expect(full.of('offer.reject')[0]?.payload).toMatchObject({
      assignmentId: 'asg_b',
      reason: 'concurrency',
    });

    const weird = setup();
    weird.ex.handle(msg({ ...autoOffer(), kind: 'SOMETHING' as never }));
    weird.ex.handle(msg(autoOffer({ assignmentId: 'asg_m', execMode: 'MANUAL' })));
    expect(weird.of('offer.reject').map((s) => s.payload.reason)).toEqual(['error', 'error']);

    for (const t of [paused, full, weird]) {
      expect(t.of('offer.accept').filter((s) => s.payload.assignmentId !== 'asg_a')).toEqual([]);
    }
    expect(paused.proc.runs).toEqual([]);
    expect(weird.git.calls).toEqual([]);
  });

  it('rejects AUTO_OFFER for an approval-mode participation or a model not allowed', () => {
    const approval = setup({ mode: 'APPROVAL' });
    approval.ex.handle(msg(autoOffer()));
    expect(approval.of('offer.reject')[0]?.payload).toMatchObject({
      reason: 'not_participating',
    });
    const model = setup({ models: ['SONNET'] });
    model.ex.handle(msg(autoOffer({ task: { model: 'OPUS' } })));
    expect(model.of('offer.reject')[0]?.payload).toMatchObject({ reason: 'model_not_allowed' });
    const other = setup();
    other.ex.handle(
      msg(
        autoOffer({ task: { project: { id: 'prj_x', fullName: 'x/y', defaultBranch: 'main' } } }),
      ),
    );
    expect(other.of('offer.reject')[0]?.payload).toMatchObject({ reason: 'not_participating' });
  });

  it('never runs a CONSENT_REQUEST the member has not accepted; keeps it as a request', async () => {
    const t = setup({ mode: 'APPROVAL' });
    t.ex.handle(msg(autoOffer({ kind: 'CONSENT_REQUEST', accepted: false })));
    t.ex.handle(msg({ ...autoOffer({ kind: 'CONSENT_REQUEST' }), accepted: undefined }));
    await t.ex.idle();
    expect(t.of('offer.accept')).toEqual([]);
    expect(t.ex.store.all()).toEqual([]);
    expect(t.proc.runs).toEqual([]);
    expect(t.ex.requestViews().map((r) => r.assignmentId)).toEqual(['asg_1']);
  });

  it('ignores an expired offer', async () => {
    const t = setup();
    t.ex.handle(msg(autoOffer({ expiresAt: new Date(Date.now() - 1000).toISOString() })));
    await t.ex.idle();
    expect(t.sent).toEqual([]);
    expect(t.ex.store.all()).toEqual([]);
  });

  it('a replayed refusal (duplicate ack) starts nothing', async () => {
    const t = setup();
    t.ex.handle(msg(autoOffer()));
    await t.ex.idle();
    const accept = t.of('offer.accept')[0]!;
    // First reply lost on reconnect: the server replays its refusal for the resent id.
    t.ex.onAck(accept.id, {
      ok: false,
      duplicate: true,
      error: { code: 'paused', message: 'The agent is paused' },
    });
    await t.ex.idle();
    expect(t.ex.store.get('asg_1')).toBeUndefined();
    expect(t.git.calls).toEqual([]);
    expect(t.ex.running()).toEqual([]);
  });

  it('starts nothing until the server acks the accept, and drops a late accept', async () => {
    const t = setup();
    t.ex.handle(msg(autoOffer()));
    await t.ex.idle();
    expect(t.git.calls).toEqual([]);
    expect(t.ex.running()).toEqual([]);
    const accept = t.of('offer.accept')[0]!;
    t.ex.onAck(accept.id, { ok: false, error: { code: 'taken', message: 'taken' } });
    t.ex.handle(serverMessage('task.cancel', { assignmentId: 'asg_1', reason: 'taken' }));
    await t.ex.idle();
    expect(t.ex.store.get('asg_1')).toBeUndefined();
    expect(t.git.calls).toEqual([]);
    expect(t.of('task.finished')).toEqual([]);

    // An offer withdrawn before the ack ("expired") is dropped the same way.
    t.ex.handle(msg(autoOffer({ assignmentId: 'asg_2' })));
    t.ex.handle(serverMessage('task.cancel', { assignmentId: 'asg_2', reason: 'expired' }));
    await t.ex.idle();
    expect(t.ex.store.get('asg_2')).toBeUndefined();
    expect(t.of('task.finished')).toEqual([]);
  });
});

describe('auto mode: headless run', () => {
  it('runs claude -p, then pushes and reports pushed + finished; keeps the clone', async () => {
    const t = setup();
    t.proc.script = finishOk;
    acceptAndAck(t, autoOffer({ timeoutSec: 600 }));
    await t.ex.idle();

    const rec = t.ex.store.get('asg_1')!;
    expect(rec).toMatchObject({ state: 'finished', execMode: 'AUTO', timeoutSec: 600 });
    expect(t.proc.runs).toHaveLength(1);
    const run = t.proc.runs[0]!;
    expect(run.argv).toEqual([
      'docker',
      'exec',
      '-i',
      '-w',
      '/workspace',
      rec.container,
      '/opt/orch/bin/claude',
      '-p',
      '--model',
      'sonnet',
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-mode',
      'bypassPermissions',
      '--max-turns',
      String(MAX_TURNS.S),
    ]);
    const joined = run.argv.join(' ');
    expect(joined).not.toContain(t.cfg.workDir);
    expect(joined).not.toContain(t.cfg.dataDir);
    expect(joined).not.toContain(CLAUDE_TOKEN);
    // The prompt goes through stdin, with the issue between delimiters.
    expect(run.input).toContain('Please add a toggle.');
    expect(run.input).toContain('<<<ORCH_ISSUE_BEGIN>>>');
    expect(run.input).toContain('unattended');
    expect(t.screen.sessions.size).toBe(0);

    expect(t.of('task.status').map((s) => s.payload.state)).toEqual([
      'preparing',
      'building',
      'running',
      'pushing',
    ]);
    expect(t.git.calls.find((c) => c[0] === 'push')).toEqual([
      'push',
      rec.cloneDir,
      rec.branch,
      GH_TOKEN,
    ]);
    const pushed = t.of('task.pushed')[0]!.payload;
    expect(pushed).toMatchObject({ branch: rec.branch, headSha: 'a'.repeat(40), changedFiles: 3 });
    expect(pushed.summary).toContain('- feat: one');
    expect(pushed.summary).toContain('Added the toggle');
    expect(t.of('task.finished')[0]!.payload).toMatchObject({
      outcome: 'succeeded',
      usage: { input: 100, output: 50, weighted: 260 },
    });
    // The run log holds the stream-json lines.
    expect(rec.logFile).toBe(join(t.cfg.dataDir, 'logs', 'asg_1.log'));
    const log = readFileSync(rec.logFile!, 'utf8');
    expect(log.trim().split('\n')).toHaveLength(3);
    expect(log).toContain('"type":"result"');
    // Containers and network gone, clone kept until cleanup.
    expect(t.docker.containers.size).toBe(0);
    expect(t.docker.networks.size).toBe(0);
    expect(existsSync(rec.cloneDir)).toBe(true);
    expect(t.ex.view(rec)).toMatchObject({ mode: 'auto', attach: 'orch logs 42' });

    t.ex.handle(serverMessage('cleanup', { assignmentId: 'asg_1' }));
    await t.ex.idle();
    expect(existsSync(rec.logFile!)).toBe(false);
    expect(existsSync(rec.taskDir)).toBe(false);
  });

  it('redacts secrets in the run log and reports a failed run without pushing', async () => {
    const t = setup();
    t.proc.script = (run) => {
      run.stdout(JSON.stringify({ type: 'user', text: `env: ${CLAUDE_TOKEN}` }));
      run.stdout(resultLine({ is_error: true, subtype: 'error_max_turns', result: 'gave up' }));
      run.finish(1);
    };
    acceptAndAck(t, autoOffer());
    await t.ex.idle();
    expect(t.ex.store.get('asg_1')?.state).toBe('failed');
    expect(t.git.calls.some((c) => c[0] === 'push')).toBe(false);
    const fin = t.of('task.finished')[0]!.payload;
    expect(fin).toMatchObject({ outcome: 'failed', usage: { input: 100, output: 50 } });
    expect(fin.error).toMatch(/exited with code 1 \(error_max_turns\)/);
    const log = readFileSync(join(t.cfg.dataDir, 'logs', 'asg_1.log'), 'utf8');
    expect(log).not.toContain(CLAUDE_TOKEN);
    expect(log).toContain('[REDACTED]');
  });

  it('kills the run when the timeout expires and reports a failure', async () => {
    const t = setup();
    acceptAndAck(t, autoOffer({ timeoutSec: 30 })); // 30 x 1 ms in tests
    await t.ex.idle();
    const run = t.proc.runs[0]!;
    expect(run.killed).toBe(true);
    const rec = t.ex.store.get('asg_1')!;
    expect(rec.state).toBe('failed');
    expect(t.docker.calls).toContainEqual(['remove', rec.container]);
    expect(t.docker.containers.size).toBe(0);
    expect(t.of('task.finished')[0]!.payload).toMatchObject({ outcome: 'failed' });
    expect(t.of('task.finished')[0]!.payload.error).toMatch(/Timed out/);
    expect(t.of('task.pushed')).toEqual([]);
  });

  it('stops the run on task.cancel and reports it once', async () => {
    const t = setup();
    acceptAndAck(t, autoOffer());
    await waitFor(() => t.proc.runs.length === 1, { what: 'claude started' });
    const view = t.ex.views()[0]!;
    expect(view).toMatchObject({ mode: 'auto', state: 'running', timeoutSec: 1800 });
    expect(view.elapsedSec).toBeGreaterThanOrEqual(0);
    t.ex.handle(serverMessage('task.cancel', { assignmentId: 'asg_1', reason: 'mode_changed' }));
    await t.ex.idle();
    expect(t.proc.runs[0]!.killed).toBe(true);
    expect(t.ex.store.get('asg_1')?.state).toBe('cancelled');
    expect(t.of('task.finished').map((s) => s.payload.outcome)).toEqual(['cancelled']);
    expect(t.of('task.pushed')).toEqual([]);
    expect(t.docker.containers.size).toBe(0);
  });

  it('runs an accepted CONSENT_REQUEST like an auto offer (approval-mode participation)', async () => {
    const t = setup({ mode: 'APPROVAL' });
    t.proc.script = finishOk;
    acceptAndAck(t, autoOffer({ kind: 'CONSENT_REQUEST', accepted: true, expiresAt: null }));
    await t.ex.idle();
    expect(t.of('task.finished')[0]?.payload.outcome).toBe('succeeded');
  });

  it('refuses manual-only commands on an auto task', async () => {
    const t = setup();
    acceptAndAck(t, autoOffer());
    await waitFor(() => t.proc.runs.length === 1, { what: 'claude started' });
    await expect(t.ex.done(42)).rejects.toMatchObject({ code: 'auto_mode' });
    await expect(t.ex.attach(42)).rejects.toMatchObject({ code: 'auto_mode' });
    expect(t.ex.logs(42)).toEqual([
      'tail',
      '-n',
      '100',
      '-F',
      join(t.cfg.dataDir, 'logs', 'asg_1.log'),
    ]);
    t.proc.runs[0]!.finish(0);
    await t.ex.idle();
    expect(t.ex.logs(42, undefined, true, 20)).toEqual([
      'tail',
      '-n',
      '20',
      join(t.cfg.dataDir, 'logs', 'asg_1.log'),
    ]);
  });
});

describe('approval requests', () => {
  const request = (id: string, issueNumber: number) =>
    serverMessage('offer.request', {
      assignmentId: id,
      expiresAt: future(),
      task: {
        taskId: `tsk_${id}`,
        project: { id: 'prj_1', fullName: 'acme/widgets' },
        issueNumber,
        title: `Issue ${issueNumber}`,
        size: 'M',
        model: 'OPUS',
        createdBy: { login: 'bob' },
      },
    });

  it('lists, accepts and rejects requests; withdrawn ones disappear', async () => {
    const t = setup({ mode: 'APPROVAL' });
    t.ex.handle(request('req_1', 5));
    t.ex.handle(request('req_2', 6));
    t.ex.handle(request('req_3', 7));
    expect(t.ex.requestViews().map((r) => r.issueNumber)).toEqual([5, 6, 7]);
    t.ex.handle(serverMessage('offer.withdrawn', { assignmentId: 'req_3', reason: 'taken' }));
    expect(t.ex.requestViews()).toHaveLength(2);

    const accepting = t.ex.acceptRequest('5');
    const accept = t.of('offer.accept')[0]!;
    expect(accept.payload).toEqual({ assignmentId: 'req_1', execMode: 'AUTO' });
    t.ex.onAck(accept.id, { ok: true });
    await expect(accepting).resolves.toMatchObject({ assignmentId: 'req_1' });
    // Accepting does not start anything by itself: the server's task.offer does.
    expect(t.ex.store.all()).toEqual([]);

    expect(t.ex.rejectRequest('req_2')).toMatchObject({ assignmentId: 'req_2' });
    expect(t.of('offer.reject')[0]?.payload).toEqual({
      assignmentId: 'req_2',
      reason: 'user_declined',
    });
    expect(t.ex.requestViews()).toEqual([]);
    expect(() => t.ex.rejectRequest('99')).toThrow(ExecError);
  });

  it('refuses to accept when paused or full, and surfaces a server refusal', async () => {
    const t = setup({ mode: 'APPROVAL' });
    t.ex.handle(request('req_1', 5));
    t.state.paused = true;
    await expect(t.ex.acceptRequest('req_1')).rejects.toMatchObject({ code: 'paused' });
    t.state.paused = false;
    const p = t.ex.acceptRequest('req_1');
    t.ex.onAck(t.of('offer.accept')[0]!.id, {
      ok: false,
      error: { code: 'not_live', message: 'The request expired' },
    });
    await expect(p).rejects.toThrow(/expired/);
    expect(t.of('offer.accept')).toHaveLength(1);
  });
});

describe('auto mode: restart and screen names', () => {
  it('reports an interrupted auto run as failed and removes its containers', async () => {
    const t = setup();
    acceptAndAck(t, autoOffer());
    await waitFor(() => t.proc.runs.length === 1, { what: 'claude started' });
    const rec = t.ex.store.get('asg_1')!;
    // A second offer still waiting for its ack survives the restart untouched.
    const t2offer = autoOffer({ assignmentId: 'asg_w', issueNumber: 8 });
    // Simulated restart: a new executor on the same state file while the old run is cut off.
    const ex2 = t.make();
    expect(ex2.store.get('asg_1')?.state).toBe('running');
    t.docker.labeled = [{ kind: 'container', name: rec.container, value: 'asg_1' }];
    t.sent.length = 0;
    await ex2.reconcile();
    expect(ex2.store.get('asg_1')?.state).toBe('failed');
    expect(t.of('task.finished')[0]?.payload).toMatchObject({ outcome: 'failed' });
    expect(String(t.of('task.finished')[0]?.payload.error)).toMatch(
      /restarted during the auto run/,
    );
    expect(t.docker.calls).toContainEqual(['remove', rec.container]);
    expect(t.docker.containers.has(rec.container)).toBe(false);
    expect(t.screen.sessions.size).toBe(0);
    // Let the cut-off run of the old process end before the temp dir goes away.
    t.proc.runs[0]!.finish(1);
    await t.ex.idle();

    const t3 = setup({ max: 2 });
    t3.proc.script = finishOk;
    t3.ex.handle(msg(t2offer));
    const ex3 = t3.make();
    await ex3.reconcile();
    expect(ex3.store.get('asg_w')?.pendingAcceptId).toBe('m1');
    expect(ex3.running()).toEqual([]);
    expect(t3.of('task.finished')).toEqual([]);
    ex3.onAck('m1', { ok: true });
    await ex3.idle();
    expect(ex3.store.get('asg_w')).toMatchObject({ pendingAcceptId: null, state: 'finished' });
  });

  it('uses <repo>-issue-<n> when issue-<n> is already a session of another project', async () => {
    const t = setup({ max: 2 });
    t.ex.handle(msg(offer({ assignmentId: 'asg_a' })));
    t.ex.handle(
      msg(
        offer({
          assignmentId: 'asg_b',
          task: { project: { id: 'prj_2', fullName: 'acme/gadgets', defaultBranch: 'main' } },
        }),
      ),
    );
    await t.ex.idle();
    expect([...t.screen.sessions.keys()].sort()).toEqual(['gadgets-issue-42', 'issue-42']);
    expect(t.ex.view(t.ex.store.get('asg_b')!).attach).toBe('orch attach 42');
    await expect(t.ex.done(42)).rejects.toMatchObject({ code: 'ambiguous' });
    await expect(t.ex.done(42, 'acme/gadgets')).resolves.toMatchObject({ state: 'finished' });
  });
});

describe('claude -p helpers', () => {
  it('builds the exact argv by size and model', () => {
    expect(
      buildAutoArgv({
        container: 'orch-task-1-x',
        workspaceFolder: '/workspaces/app',
        claudeBin: '/opt/orch/bin/claude',
        model: 'opus',
        size: 'L',
      }).join(' '),
    ).toBe(
      'docker exec -i -w /workspaces/app orch-task-1-x /opt/orch/bin/claude -p --model opus ' +
        '--output-format stream-json --verbose --permission-mode bypassPermissions --max-turns 300',
    );
  });

  it('parses the result event and ignores other lines', () => {
    expect(parseResultEvent('not json')).toBeNull();
    expect(parseResultEvent('{"type":"assistant"}')).toBeNull();
    expect(parseResultEvent(resultLine())).toMatchObject({
      isError: false,
      subtype: 'success',
      usage: { input: 100, output: 50, cacheWrite: 10, cacheRead: 1000 },
    });
    expect(parseResultEvent(resultLine({ subtype: 'error_during_execution' }))?.isError).toBe(true);
  });
});

const AUTH_ERROR = 'Failed to authenticate. API Error: 401 OAuth access token is invalid.';
const ENV_ERROR = 'docker compose failed: env file /some/path/.env not found';

describe('failure classification and Claude login state', () => {
  const authFailure = (t: ReturnType<typeof setup>) => {
    t.proc.script = (run) => {
      run.stdout(resultLine({ is_error: true, subtype: 'success', result: AUTH_ERROR }));
      run.finish(1);
    };
  };

  it('sends failureClass env for a setup failure', async () => {
    const t = setup();
    t.docker.createNetwork = async () => {
      throw new Error(ENV_ERROR);
    };
    acceptAndAck(t, autoOffer());
    await t.ex.idle();
    expect(t.of('task.finished')[0]!.payload).toMatchObject({
      outcome: 'failed',
      failureClass: 'env',
    });
    expect(t.of('task.finished')[0]!.payload.rateLimitedUntil).toBeUndefined();
    expect(t.ex.claudeAuth.isValid()).toBe(true);
  });

  it('sends failureClass timeout', async () => {
    const t = setup();
    acceptAndAck(t, autoOffer({ timeoutSec: 30 }));
    await t.ex.idle();
    expect(t.of('task.finished')[0]!.payload).toMatchObject({ failureClass: 'timeout' });
  });

  it('sends failureClass rate_limited with rateLimitedUntil when a reset time is given', async () => {
    const t = setup();
    t.proc.script = (run) => {
      run.stdout(
        resultLine({ is_error: true, result: 'Claude AI usage limit reached|1900000000' }),
      );
      run.finish(1);
    };
    acceptAndAck(t, autoOffer());
    await t.ex.idle();
    expect(t.of('task.finished')[0]!.payload).toMatchObject({
      failureClass: 'rate_limited',
      rateLimitedUntil: new Date(1900000000 * 1000).toISOString(),
    });
  });

  it('classifies claude_auth, persists the flag and refuses AUTO offers locally until login', async () => {
    const t = setup({ max: 2 });
    authFailure(t);
    acceptAndAck(t, autoOffer());
    await t.ex.idle();
    expect(t.of('task.finished')[0]!.payload).toMatchObject({
      failureClass: 'claude_auth',
      error: expect.stringContaining('Failed to authenticate'),
    });
    const file = join(t.cfg.dataDir, 'claude-auth.json');
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ valid: false });
    expect(readFileSync(file, 'utf8')).not.toContain(CLAUDE_TOKEN);

    t.ex.handle(msg(autoOffer({ assignmentId: 'asg_2', issueNumber: 8 })));
    const rej = t.of('offer.reject').find((s) => s.payload.assignmentId === 'asg_2')!;
    expect(rej.payload.reason).toBe('error');
    expect(String(rej.payload.detail).startsWith(CLAUDE_AUTH_REJECT_PREFIX)).toBe(true);
    expect(CLAUDE_AUTH_REJECT_PREFIX).toBe('claude_auth: Claude login expired: run "orch login"');
    expect(t.of('offer.accept').filter((s) => s.payload.assignmentId === 'asg_2')).toEqual([]);

    // A manual take fails with a clear message too.
    expect(() => t.ex.take(9, 'acme/widgets')).toThrow(/Claude login expired/);

    // `orch login` (another process) resets the state; the next offer is accepted.
    new ClaudeAuthState(t.cfg.dataDir).markValid();
    expect(t.ex.claudeAuth.isValid()).toBe(true);
    t.proc.script = undefined as never;
    t.ex.handle(msg(autoOffer({ assignmentId: 'asg_3', issueNumber: 9 })));
    expect(t.of('offer.accept').some((s) => s.payload.assignmentId === 'asg_3')).toBe(true);
  });

  it('treats a corrupt state file as valid', () => {
    const t = setup();
    mkdirSync(t.cfg.dataDir, { recursive: true });
    writeFileSync(join(t.cfg.dataDir, 'claude-auth.json'), 'not json');
    expect(t.ex.claudeAuth.isValid()).toBe(true);
  });
});
