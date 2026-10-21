import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TaskFinishedPayloadSchema, serverMessage, type ServerMessage } from '@orch/shared';
import { ExecError, ManualExecutor, type ExecutorConfig } from '../../src/exec/executor';
import { silentLogger } from '../../src/log';
import { tempDir } from '../helpers/util';
import { CommandError } from '../../src/exec/runner';
import { BOT_REPO_FILES, botRepoModel } from './compose-fixtures';
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
      // The git dir is private to the agent: outside the work dir, never mounted.
      join(t.cfg.dataDir, 'git', 'asg_1.git'),
    ]);
    expect(t.git.calls.map((c) => c[0])).toContain('seedTaskGit');
    expect(t.git.calls.find((c) => c[0] === 'createBranch')?.slice(2)).toEqual([
      'orch/issue-42-add-a-dark-mode-toggle',
      'main',
    ]);
    expect(t.tokenRequests).toEqual(['clone']);
    // Dockerfile build, sidecars on the task network, container, claude copied in.
    expect(t.docker.names()).toEqual([
      'createNetwork',
      'composeConfig',
      'composeUp',
      'build',
      'create',
      'copyIn',
      'start',
    ]);
    const up = t.docker.calls.find((c) => c[0] === 'composeUp')!;
    const [checked, override] = up[2] as [string, string];
    // Sidecars start from the validated model, never from the repo's raw file.
    expect(checked).toBe(join(t.cfg.workDir, 'asg_1', 'compose.orch.checked.json'));
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
    // The task is frozen while the agent stages and commits its files.
    const names = t.docker.names();
    expect(names.indexOf('pause')).toBeGreaterThan(-1);
    expect(names.indexOf('unpause')).toBeGreaterThan(names.indexOf('pause'));
    expect(t.docker.paused.size).toBe(0);
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

  it('sends integer token counts even when the task wrote fractional ones', async () => {
    const t = setup();
    t.git.ahead = 0;
    t.ex.handle(offerMsg());
    await t.ex.idle();
    // The task can write its own Claude logs: a fractional count must not break the schema.
    t.docker.usageJsonl = JSON.stringify({
      timestamp: '2026-10-21T10:00:00Z',
      message: { id: 'm1', usage: { input_tokens: 1.5, output_tokens: 2.4 } },
    });
    await t.ex.done(42);
    const finished = t.of('task.finished')[0]!;
    expect(TaskFinishedPayloadSchema.safeParse(finished.payload).success).toBe(true);
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
    expect(t.fs.removed).toEqual([rec.taskDir, join(t.cfg.dataDir, 'git', 'asg_1.git')]);
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
    t.docker.projects = [{ name: 'orch-task-old' }];
    const ex2 = t.make();
    await ex2.reconcile();
    expect(ex2.store.get('asg_1')?.state).toBe('running');
    expect(t.screen.sessions.get('issue-42')?.join(' ')).toContain('--continue');
    expect(t.docker.calls).toContainEqual(['remove', 'orch-task-1-old']);
    expect(t.docker.calls).not.toContainEqual(['remove', rec.container]);
    expect(t.docker.calls).toContainEqual(['removeNetwork', 'orch-net-old']);
    expect(t.docker.calls).toContainEqual(['composeDown', 'orch-task-old']);
  });

  it('reconcile never touches containers, networks or sidecars of another agent', async () => {
    const t = setup();
    t.docker.labeled = [
      { kind: 'container', name: 'orch-task-7-other', value: 'asg_other', agent: 'agt_other' },
      { kind: 'network', name: 'orch-net-other', value: 'asg_other', agent: 'agt_other' },
      { kind: 'container', name: 'orch-task-8-mine', value: 'asg_gone' },
    ];
    t.docker.projects = [
      { name: 'orch-task-other', agent: 'agt_other' },
      { name: 'orch-task-gone' },
    ];
    await t.make().reconcile();
    expect(t.docker.calls).not.toContainEqual(['remove', 'orch-task-7-other']);
    expect(t.docker.calls).not.toContainEqual(['removeNetwork', 'orch-net-other']);
    expect(t.docker.calls).not.toContainEqual(['composeDown', 'orch-task-other']);
    expect(t.docker.calls).toContainEqual(['remove', 'orch-task-8-mine']);
    expect(t.docker.calls).toContainEqual(['composeDown', 'orch-task-gone']);
  });

  it('labels every network, image and container with this agent id', async () => {
    const t = setup();
    t.git.files = { 'README.md': '#\n', Dockerfile: 'FROM debian\n' };
    t.ex.handle(offerMsg());
    await t.ex.idle();
    const net = t.docker.calls.find((c) => c[0] === 'createNetwork');
    expect(net).toBeDefined();
    const build = t.docker.calls.find((c) => c[0] === 'build')?.[1] as { labels: object };
    expect(build.labels).toMatchObject({ 'orch.agent': 'agt_test', 'orch.task': 'asg_1' });
    const create = t.docker.calls.find((c) => c[0] === 'create')?.[1] as string[];
    expect(create.join(' ')).toContain('--label orch.agent=agt_test');
  });

  it('refuses a dangerous compose file: the task fails with the reason, nothing starts', async () => {
    const t = setup({ files: { 'compose.yaml': 'services: {}\n' } });
    t.docker.composeModel = {
      name: 'p',
      services: {
        evil: {
          image: 'alpine',
          privileged: true,
          volumes: [{ type: 'bind', source: '/var/run/docker.sock', target: '/s' }],
        },
      },
    };
    t.ex.handle(offerMsg());
    await t.ex.idle();
    const rec = t.ex.store.get('asg_1')!;
    expect(rec.state).toBe('failed');
    expect(rec.error).toContain('Refusing the repository compose file');
    expect(rec.error).toContain('privileged');
    expect(rec.error).toContain('/var/run/docker.sock');
    expect(t.docker.names()).not.toContain('composeUp');
    expect(t.docker.names()).not.toContain('create');
    expect(t.of('task.finished')[0]?.payload).toMatchObject({ outcome: 'failed' });
  });

  it('strips published ports and labels the sidecars', async () => {
    const t = setup({ files: { 'compose.yaml': 'services: {}\n' } });
    t.docker.composeModel = {
      name: 'p',
      services: {
        db: {
          image: 'postgres',
          ports: [{ mode: 'ingress', target: 5432, published: '5432', protocol: 'tcp' }],
        },
      },
    };
    t.ex.handle(offerMsg());
    await t.ex.idle();
    const rec = t.ex.store.get('asg_1')!;
    expect(rec.state).toBe('running');
    const up = t.docker.calls.find((c) => c[0] === 'composeUp')!;
    const model = JSON.parse(readFileSync((up[2] as string[])[0]!, 'utf8')) as {
      services: { db: { ports?: unknown; labels: Record<string, string> } };
    };
    expect(model.services.db.ports).toBeUndefined();
    expect(model.services.db.labels).toMatchObject({
      'orch.agent': 'agt_test',
      'orch.task': 'asg_1',
    });
    expect(rec.warnings.join(' ')).toContain('published ports');
  });

  it('a missing env_file in the clone is dropped with a warning; compose gets an override', async () => {
    const t = setup({
      files: { 'compose.yaml': 'services:\n  db:\n    image: x\n    env_file: .env\n' },
    });
    t.docker.composeModel = { name: 'p', services: { db: { image: 'x' } } };
    t.ex.handle(offerMsg());
    await t.ex.idle();
    const rec = t.ex.store.get('asg_1')!;
    expect(rec.state).toBe('running');
    expect(rec.warnings.join(' ')).toContain('env file .env not found in the repository');
    const cfg = t.docker.calls.find((c) => c[0] === 'composeConfig')!;
    expect((cfg[2] as string[]).map((f) => f.split('/').pop())).toEqual([
      'compose.yaml',
      'compose.orch.envfix.yaml',
    ]);
    expect(existsSync(join(t.cfg.workDir, 'asg_1', 'src', '.env'))).toBe(false);
  });

  it('bot-repo shape (list env_file .env, .env.example, container_name): every compose call uses the override', async () => {
    const t = setup({ files: BOT_REPO_FILES });
    const clone = join(t.cfg.workDir, 'asg_1', 'src');
    const taskDir = join(t.cfg.workDir, 'asg_1');
    t.docker.composeModel = botRepoModel(clone);
    t.ex.handle(offerMsg());
    await t.ex.idle();
    const rec = t.ex.store.get('asg_1')!;
    expect(rec.state, rec.error ?? '').toBe('running');
    const raw = join(clone, 'docker-compose.yml');
    const envfix = join(taskDir, 'compose.orch.envfix.yaml');
    const checked = join(taskDir, 'compose.orch.checked.json');
    const net = join(taskDir, 'compose.orch.yaml');
    // The override swaps the missing .env for the committed example; nothing is written in the clone.
    expect(readFileSync(envfix, 'utf8')).toContain(
      `path: ${JSON.stringify(join(clone, '.env.example'))}`,
    );
    expect(existsSync(join(clone, '.env'))).toBe(false);
    // Fixed container names would collide with the member's own stack: removed, kept as aliases.
    const upModel = JSON.parse(readFileSync(checked, 'utf8')) as {
      services: Record<string, { container_name?: string; networks: unknown; ports?: unknown }>;
    };
    expect(upModel.services.bot!.container_name).toBeUndefined();
    expect(upModel.services.helper!.networks).toEqual({ default: { aliases: ['bot-helper'] } });
    expect(upModel.services.bot!.ports).toBeUndefined();
    // The build never overwrites the member's own tag of the published image.
    expect((upModel.services.bot as { image?: string }).image).toBeUndefined();
    expect((upModel.services.helper as { image?: string }).image).toBe('busybox:1.36');
    expect(rec.warnings.join(' ')).toContain('using .env.example instead');
    await t.ex.cleanup('asg_1');

    const calls = t.docker.calls.filter((c) => String(c[0]).startsWith('compose'));
    expect(calls.map((c) => c[0])).toEqual(['composeConfig', 'composeUp', 'composeDown']);
    for (const c of calls) {
      // Same project and project directory everywhere; the raw file never without the override.
      expect(c[1]).toBe('orch-task-asg-1');
      expect(c[3]).toBe(clone);
      const files = c[2] as string[];
      if (files.includes(raw)) expect(files).toEqual([raw, envfix]);
      else expect(files).toEqual([checked, net]);
    }
    expect(calls[0]![2]).toEqual([raw, envfix]);
  });

  it('a compose failure is actionable in orch status and task.finished', async () => {
    const t = setup({ files: BOT_REPO_FILES });
    const env = join(t.cfg.workDir, 'asg_1', 'src', '.env');
    t.docker.composeConfigError = new CommandError(
      'docker compose',
      1,
      `env file ${env} not found: stat ${env}: no such file or directory`,
    );
    t.ex.handle(offerMsg());
    await t.ex.idle();
    const rec = t.ex.store.get('asg_1')!;
    expect(rec.state).toBe('failed');
    expect(rec.error).toContain('Sidecars (docker-compose.yml) failed at "docker compose config"');
    expect(rec.error).toContain('Commit a .env.example next to it');
    expect(rec.error).toContain(`env file ${env} not found`);
    const fin = t.of('task.finished')[0]?.payload as { error: string };
    expect(fin.error).toBe(rec.error);
    expect(t.docker.names()).not.toContain('composeUp');
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
