import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { serverMessage, type ServerMessage } from '@orch/shared';
import { ExecError, ManualExecutor, type ExecutorConfig } from '../../src/exec/executor';
import { silentLogger } from '../../src/log';
import { tempDir } from '../helpers/util';
import { FakeDocker, FakeGit, FakeScreen, offer, recordingFs } from './fakes';

const CLAUDE_TOKEN = 'sk-ant-oat01-' + 'Zz9'.repeat(20);
const GH_TOKEN = 'ghs_' + 'Gh1'.repeat(12);

interface Sent {
  id: string;
  type: string;
  payload: Record<string, unknown>;
}

let tmp: ReturnType<typeof tempDir>;
beforeEach(() => (tmp = tempDir()));
afterEach(() => tmp.cleanup());

function setup(
  opts: {
    paused?: boolean;
    max?: number;
    claudeToken?: string | null;
    files?: Record<string, string>;
  } = {},
) {
  const git = new FakeGit();
  if (opts.files) git.files = opts.files;
  const docker = new FakeDocker();
  const screen = new FakeScreen();
  const fs = recordingFs();
  const sent: Sent[] = [];
  const tokenRequests: string[] = [];
  const state = { paused: opts.paused ?? false };
  let n = 0;
  const cfg: ExecutorConfig = {
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
  };
  const deps = {
    git,
    docker,
    screen,
    fs,
    requestToken: async (_id: string, purpose: 'clone' | 'push') => {
      tokenRequests.push(purpose);
      return GH_TOKEN;
    },
    enqueue: (type: string, payload: unknown) => {
      const id = `m${++n}`;
      sent.push({ id, type, payload: payload as Record<string, unknown> });
      return id;
    },
    isPaused: () => state.paused,
    readClaudeToken: () => (opts.claudeToken === undefined ? CLAUDE_TOKEN : opts.claudeToken),
    participations: () => [
      {
        projectId: 'prj_1',
        fullName: 'acme/widgets',
        percent: 50,
        mode: 'APPROVAL' as const,
        allowedModels: ['SONNET' as const],
      },
    ],
    logger: silentLogger,
  };
  const make = () => new ManualExecutor(cfg, deps as never);
  const ex = make();
  const of = (type: string) => sent.filter((s) => s.type === type);
  return { ex, make, git, docker, screen, fs, sent, of, tokenRequests, state, cfg };
}

const offerMsg = (o = offer(), replyTo?: string): ServerMessage =>
  serverMessage('task.offer', o, replyTo ? { replyTo } : {});

describe('ManualExecutor take -> done', () => {
  it('claims, prepares the sandbox, starts the screen session, then pushes and tears down', async () => {
    const t = setup({ files: { Dockerfile: 'FROM node:22\n', 'compose.yaml': 'services: {}\n' } });
    const taking = t.ex.take(42);
    const claim = t.of('task.claim')[0];
    expect(claim?.payload).toEqual({ projectFullName: 'acme/widgets', issueNumber: 42 });
    t.ex.onAck(claim!.id, { ok: true });
    t.ex.handle(offerMsg(offer(), claim!.id));
    const view = await taking;
    expect(view).toMatchObject({ issueNumber: 42, branch: 'orch/issue-42-add-a-dark-mode-toggle' });
    expect(t.of('offer.accept')[0]?.payload).toEqual({ assignmentId: 'asg_1', execMode: 'MANUAL' });
    await t.ex.idle();

    const rec = t.ex.store.get('asg_1')!;
    expect(rec.state).toBe('running');
    // Isolated clone under the work dir, branch from the base branch, clone token only.
    expect(t.git.calls.find((c) => c[0] === 'clone')).toEqual([
      'clone',
      join(t.cfg.dataDir, 'mirrors', 'prj_1.git'),
      'https://github.com/acme/widgets.git',
      join(t.cfg.workDir, 'asg_1', 'src'),
      GH_TOKEN,
    ]);
    expect(t.git.calls.find((c) => c[0] === 'createBranch')?.slice(2)).toEqual([
      'orch/issue-42-add-a-dark-mode-toggle',
      'main',
    ]);
    expect(t.tokenRequests).toEqual(['clone']);
    // Dockerfile build, sidecars on the task network, container, claude copied in.
    expect(t.docker.names()).toEqual([
      'createNetwork',
      'composeUp',
      'build',
      'create',
      'copyIn',
      'start',
    ]);
    const up = t.docker.calls.find((c) => c[0] === 'composeUp')!;
    const override = (up[2] as string[])[1]!;
    expect(readFileSync(override, 'utf8')).toContain(`name: ${rec.network}`);
    expect(override.startsWith(join(t.cfg.workDir, 'asg_1', 'src'))).toBe(false);
    const createArgs = t.docker.calls.find((c) => c[0] === 'create')![1] as string[];
    expect(createArgs.join(' ')).not.toContain(CLAUDE_TOKEN);
    expect(t.docker.createEnv[0]).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: CLAUDE_TOKEN });
    // Screen session runs claude through docker exec, with the issue as the starting prompt.
    const argv = t.screen.sessions.get('issue-42')!;
    expect(argv.slice(0, 9)).toEqual([
      'docker',
      'exec',
      '-it',
      '-w',
      '/workspace',
      rec.container,
      '/opt/orch/bin/claude',
      '--model',
      'sonnet',
    ]);
    expect(argv[9]).toContain('Please add a toggle.');
    expect(argv.join(' ')).not.toContain(CLAUDE_TOKEN);
    expect(t.of('task.status').map((s) => s.payload.state)).toEqual([
      'preparing',
      'building',
      'running',
    ]);
    expect(t.ex.running()).toEqual([
      { assignmentId: 'asg_1', taskId: 'tsk_1', state: 'running', lastSeq: 3 },
    ]);

    t.docker.usageJsonl = [
      JSON.stringify({
        timestamp: '2026-10-21T10:00:00Z',
        requestId: 'r1',
        message: {
          id: 'm1',
          model: 'claude-sonnet-4-5',
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      }),
      'garbage',
    ].join('\n');
    const done = await t.ex.done(42);
    expect(done.state).toBe('finished');
    expect(t.git.calls.find((c) => c[0] === 'push')).toEqual([
      'push',
      rec.cloneDir,
      'orch/issue-42-add-a-dark-mode-toggle',
      GH_TOKEN,
    ]);
    expect(t.tokenRequests).toEqual(['clone', 'push']);
    const pushed = t.of('task.pushed')[0]!.payload;
    expect(pushed).toMatchObject({
      assignmentId: 'asg_1',
      branch: 'orch/issue-42-add-a-dark-mode-toggle',
      headSha: 'a'.repeat(40),
      changedFiles: 3,
      summary: '- feat: one\n- fix: two',
    });
    const finished = t.of('task.finished')[0]!.payload;
    expect(finished).toMatchObject({
      outcome: 'succeeded',
      usage: { input: 10, output: 5, weighted: 15 },
    });
    // seq strictly increasing across task.* messages.
    const seqs = t.sent.filter((s) => s.type.startsWith('task.') && s.type !== 'task.claim');
    const values = seqs.map((s) => s.payload.seq as number);
    expect(values).toEqual([...values].sort((a, b) => a - b));
    expect(new Set(values).size).toBe(values.length);
    // Containers, sidecars and network gone; clone kept; session killed.
    expect(t.docker.containers.size).toBe(0);
    expect(t.docker.networks.size).toBe(0);
    expect(t.docker.names()).toContain('composeDown');
    expect(t.screen.sessions.size).toBe(0);
    expect(existsSync(rec.cloneDir)).toBe(true);
    expect(t.ex.running()).toEqual([]);
    // Nothing secret persisted in the state file.
    const stateFile = readFileSync(join(t.cfg.dataDir, 'tasks.json'), 'utf8');
    expect(stateFile).not.toContain(CLAUDE_TOKEN);
    expect(stateFile).not.toContain(GH_TOKEN);
  });

  it('reports no_changes without pushing when nothing was committed', async () => {
    const t = setup();
    t.git.ahead = 0;
    t.ex.handle(offerMsg());
    await t.ex.idle();
    await t.ex.done(42);
    expect(t.git.calls.some((c) => c[0] === 'push')).toBe(false);
    expect(t.of('task.pushed')).toEqual([]);
    expect(t.of('task.finished')[0]?.payload.outcome).toBe('no_changes');
  });

  it('keeps the task running when the push fails', async () => {
    const t = setup();
    t.git.failPush = true;
    t.ex.handle(offerMsg());
    await t.ex.idle();
    await expect(t.ex.done(42)).rejects.toThrow(/still running/);
    expect(t.ex.store.get('asg_1')?.state).toBe('running');
    expect(t.of('task.finished')).toEqual([]);
  });

  it('uses the default image and runs postCreateCommand from devcontainer.json', async () => {
    const t = setup({
      files: {
        '.devcontainer/devcontainer.json':
          '{"image":"python:3.12","postCreateCommand":"pip install -e ."}',
      },
    });
    t.ex.handle(offerMsg());
    await t.ex.idle();
    expect(t.docker.calls.find((c) => c[0] === 'pull')).toEqual(['pull', 'python:3.12']);
    expect(t.docker.calls.find((c) => c[0] === 'exec')?.[2]).toEqual([
      'sh',
      '-c',
      'pip install -e .',
    ]);
    expect(t.ex.store.get('asg_1')?.builtImage).toBeNull();
  });

  it('fails the task and reports task.finished failed when preparation breaks', async () => {
    const t = setup({ files: { '.devcontainer/devcontainer.json': '{broken' } });
    t.ex.handle(offerMsg());
    await t.ex.idle();
    expect(t.ex.store.get('asg_1')).toMatchObject({ state: 'failed' });
    expect(t.of('task.finished')[0]?.payload).toMatchObject({ outcome: 'failed' });
    expect(t.docker.networks.size).toBe(0);
  });
});

describe('ManualExecutor guards', () => {
  it('refuses take when paused, without a Claude token, or at max concurrency', async () => {
    const paused = setup({ paused: true });
    expect(() => paused.ex.take(1)).toThrow(ExecError);
    expect(() => paused.ex.take(1)).toThrow(/paused/);
    expect(paused.of('task.claim')).toEqual([]);

    const noToken = setup({ claudeToken: null });
    expect(() => noToken.ex.take(1)).toThrow(/orch login/);

    const t = setup({ max: 1 });
    t.ex.handle(offerMsg());
    await t.ex.idle();
    expect(() => t.ex.take(7)).toThrow(/max 1/);
    expect(t.of('task.claim')).toEqual([]);
  });

  it('rejects CLAIM offers when paused or full, and auto offers when full', async () => {
    const t = setup({ max: 1 });
    t.state.paused = true;
    t.ex.handle(offerMsg());
    expect(t.of('offer.reject')[0]?.payload).toMatchObject({
      assignmentId: 'asg_1',
      reason: 'paused',
    });
    t.state.paused = false;
    t.ex.handle(offerMsg(offer({ assignmentId: 'asg_2' })));
    await t.ex.idle();
    t.ex.handle(offerMsg(offer({ assignmentId: 'asg_3', issueNumber: 9 })));
    expect(t.of('offer.reject')[1]?.payload).toMatchObject({
      assignmentId: 'asg_3',
      reason: 'concurrency',
    });
    t.ex.handle(offerMsg(offer({ assignmentId: 'asg_4', kind: 'AUTO_OFFER' })));
    expect(t.of('offer.reject')[2]?.payload).toMatchObject({
      assignmentId: 'asg_4',
      reason: 'concurrency',
    });
    expect(t.of('offer.accept')).toHaveLength(1);
  });

  it('surfaces claim refusals with a readable message', async () => {
    const t = setup();
    const p = t.ex.take(42);
    t.ex.onAck(t.of('task.claim')[0]!.id, {
      ok: false,
      error: { code: 'already_taken', message: 'raw' },
    });
    await expect(p).rejects.toThrow(/Someone else already took/);
  });

  it('times out a claim the server does not answer', async () => {
    const t = setup();
    await expect(t.ex.take(42)).rejects.toMatchObject({ code: 'claim_pending' });
  });
});

describe('ManualExecutor cleanup and restart', () => {
  it('deletes the clone and the task image on the cleanup message', async () => {
    const t = setup({ files: { Dockerfile: 'FROM node:22\n' } });
    t.ex.handle(offerMsg());
    await t.ex.idle();
    await t.ex.done(42);
    const rec = t.ex.store.get('asg_1')!;
    expect(existsSync(rec.taskDir)).toBe(true);
    t.ex.handle(serverMessage('cleanup', { assignmentId: 'asg_1' }));
    await t.ex.idle();
    expect(existsSync(rec.taskDir)).toBe(false);
    expect(t.fs.removed).toEqual([rec.taskDir]);
    expect(t.docker.calls).toContainEqual(['removeImage', rec.builtImage]);
    expect(t.ex.store.get('asg_1')).toBeUndefined();
    expect(() => t.ex.handle(serverMessage('cleanup', { assignmentId: '../../etc' }))).toThrow();
  });

  it('cancels a running task on task.cancel', async () => {
    const t = setup();
    t.ex.handle(offerMsg());
    await t.ex.idle();
    t.ex.handle(serverMessage('task.cancel', { assignmentId: 'asg_1', reason: 'reassigned' }));
    await t.ex.idle();
    expect(t.ex.store.get('asg_1')?.state).toBe('cancelled');
    expect(t.of('task.finished')[0]?.payload.outcome).toBe('cancelled');
    expect(t.docker.containers.size).toBe(0);
  });

  it('after a restart: resumes running tasks, recreates the session and removes orphans', async () => {
    const t = setup();
    t.ex.handle(offerMsg());
    await t.ex.idle();
    const rec = t.ex.store.get('asg_1')!;
    t.screen.sessions.clear(); // the agent container restarted: screen is gone
    t.docker.labeled = [
      { kind: 'container', name: rec.container, value: 'asg_1' },
      { kind: 'container', name: 'orch-task-1-old', value: 'asg_old' },
      { kind: 'network', name: 'orch-net-old', value: 'asg_old' },
    ];
    t.docker.projects = ['orch-task-old'];
    const ex2 = t.make();
    await ex2.reconcile();
    expect(ex2.store.get('asg_1')?.state).toBe('running');
    expect(t.screen.sessions.get('issue-42')?.join(' ')).toContain('--continue');
    expect(t.docker.calls).toContainEqual(['remove', 'orch-task-1-old']);
    expect(t.docker.calls).not.toContainEqual(['remove', rec.container]);
    expect(t.docker.calls).toContainEqual(['removeNetwork', 'orch-net-old']);
    expect(t.docker.calls).toContainEqual(['composeDown', 'orch-task-old']);
  });

  it('after a restart: fails tasks whose container vanished or whose preparation was cut', async () => {
    const t = setup();
    t.ex.handle(offerMsg());
    await t.ex.idle();
    t.docker.containers.clear();
    const ex2 = t.make();
    await ex2.reconcile();
    expect(ex2.store.get('asg_1')).toMatchObject({ state: 'failed' });
    expect(t.of('task.finished')[0]?.payload).toMatchObject({ outcome: 'failed' });
  });
});
