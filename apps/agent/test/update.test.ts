import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { serverMessage, type UpdateStatusPayload } from '@orch/shared';
import { Agent } from '../src/agent';
import type { ControlResult, StatusInfo } from '../src/cli/protocol';
import { runCli } from '../src/cli/run';
import { startControlServer, type ControlServer } from '../src/control/server';
import type { CommandRunner, RunOptions, RunResult } from '../src/exec/runner';
import { silentLogger } from '../src/log';
import {
  ENV_BACKUP_SUFFIX,
  HELPER_SCRIPT,
  UpdateError,
  chooseImageKey,
  helperRunArgs,
  parseSelfInspect,
  readFileArgs,
  setEnvValue,
  validateUpdateImage,
  writeEnvArgs,
  type SelfContainer,
} from '../src/update/plan';
import { Updater } from '../src/update/updater';
import { FakeServer } from './helpers/fake-server';
import { CREDENTIAL, tempDir, waitFor } from './helpers/util';

const REPO = 'ghcr.io/theroxat/orch-agent';
const IMAGE_ID = `sha256:${'a'.repeat(64)}`;
const COMPOSE_TEMPLATE = readFileSync(
  resolve(__dirname, '../../../deploy/agent/compose.yaml'),
  'utf8',
);

function inspectJson(labels: Record<string, string>, extra: Record<string, unknown> = {}) {
  return JSON.stringify([
    {
      Id: 'c0ffee',
      Image: IMAGE_ID,
      Config: { Image: `${REPO}:0.4.1`, Labels: labels },
      Mounts: [{ Source: '/home/u/.claude', Destination: '/host-claude' }],
      ...extra,
    },
  ]);
}

const LABELS = {
  'com.docker.compose.project': 'orch-agent',
  'com.docker.compose.service': 'agent',
  'com.docker.compose.project.working_dir': '/home/u/orch',
  'com.docker.compose.project.config_files': '/home/u/orch/compose.yaml',
};

const SELF: SelfContainer = {
  imageId: IMAGE_ID,
  project: 'orch-agent',
  service: 'agent',
  workingDir: '/home/u/orch',
  configFiles: ['/home/u/orch/compose.yaml'],
  envFile: '/home/u/orch/.env',
  hostClaudeDir: '/home/u/.claude',
};

let tmp: ReturnType<typeof tempDir>;
beforeEach(() => {
  tmp = tempDir();
});
afterEach(() => tmp.cleanup());

// ---------- pure parts ----------

describe('image validation', () => {
  it('accepts only <configured repo>:<release>', () => {
    expect(validateUpdateImage(`${REPO}:0.4.3`, '0.4.3', REPO)).toBe(`${REPO}:0.4.3`);
    const bad: [string, string][] = [
      ['evil.io/theroxat/orch-agent:0.4.3', '0.4.3'],
      ['ghcr.io/theroxat/orch-agent-evil:0.4.3', '0.4.3'],
      [`${REPO}:0.4.4`, '0.4.3'],
      [`${REPO}:latest`, 'latest'],
      [`${REPO}@sha256:${'b'.repeat(64)}`, '0.4.3'],
      [`${REPO}:0.4.3 --privileged`, '0.4.3'],
      ['--privileged', '0.4.3'],
      [`${REPO}:0.4.3;rm -rf /`, '0.4.3;rm -rf /'],
    ];
    for (const [image, v] of bad) {
      expect(() => validateUpdateImage(image, v, REPO), image).toThrow(UpdateError);
    }
    expect(() => validateUpdateImage('x/y:0.4.3', '0.4.3', 'not a repo')).toThrow(/repository/);
  });
});

describe('own container discovery', () => {
  it('reads the compose labels and the image id', () => {
    expect(parseSelfInspect(inspectJson(LABELS))).toEqual(SELF);
  });

  it('uses a single env file label and splits several config files', () => {
    const s = parseSelfInspect(
      inspectJson({
        ...LABELS,
        'com.docker.compose.project.config_files':
          '/home/u/orch/compose.yaml,/home/u/orch/override.yaml',
        'com.docker.compose.project.environment_file': '/home/u/orch/agent.env',
      }),
    );
    expect(s.configFiles).toEqual(['/home/u/orch/compose.yaml', '/home/u/orch/override.yaml']);
    expect(s.envFile).toBe('/home/u/orch/agent.env');
  });

  it('refuses containers not started by compose, odd layouts and odd names', () => {
    const code = (json: string) => {
      try {
        parseSelfInspect(json);
        return 'ok';
      } catch (e) {
        return (e as UpdateError).code;
      }
    };
    expect(code(inspectJson({}))).toBe('not_compose');
    expect(code('not json')).toBe('not_compose');
    expect(code(inspectJson(LABELS, { Image: 'orch-agent:latest' }))).toBe('not_compose');
    expect(
      code(
        inspectJson({
          ...LABELS,
          'com.docker.compose.project.config_files': '/etc/compose.yaml',
        }),
      ),
    ).toBe('unsupported_layout');
    expect(
      code(
        inspectJson({
          ...LABELS,
          'com.docker.compose.project.working_dir': '/home/u/../root',
        }),
      ),
    ).toBe('unsupported_layout');
    expect(code(inspectJson({ ...LABELS, 'com.docker.compose.project': '-p x' }))).toBe(
      'unsupported_layout',
    );
  });
});

describe('.env update', () => {
  it('picks the variable the compose template uses', () => {
    expect(chooseImageKey(COMPOSE_TEMPLATE)).toBe('ORCH_AGENT_TAG');
    expect(chooseImageKey('image: ${ORCH_AGENT_IMAGE:-ghcr.io/x/y:latest}')).toBe(
      'ORCH_AGENT_IMAGE',
    );
    expect(() => chooseImageKey('image: ghcr.io/x/y:1.0.0')).toThrow(/manually/);
  });

  it('replaces or appends the assignment and keeps every other line', () => {
    const env = 'ORCH_SERVER_URL=https://o\nORCH_AGENT_CREDENTIAL=secret\n';
    expect(setEnvValue(env, 'ORCH_AGENT_TAG', '0.4.3')).toBe(`${env}ORCH_AGENT_TAG=0.4.3\n`);
    expect(setEnvValue('A=1\nORCH_AGENT_TAG=0.4.1\nB=2', 'ORCH_AGENT_TAG', '0.4.3')).toBe(
      'A=1\nORCH_AGENT_TAG=0.4.3\nB=2',
    );
    expect(setEnvValue('export ORCH_AGENT_TAG=0.4.1\r\n', 'ORCH_AGENT_TAG', '0.4.3')).toBe(
      'export ORCH_AGENT_TAG=0.4.3\r\n',
    );
    expect(setEnvValue('A=1', 'ORCH_AGENT_IMAGE', `${REPO}:0.4.3`)).toBe(
      `A=1\nORCH_AGENT_IMAGE=${REPO}:0.4.3\n`,
    );
    expect(() => setEnvValue('', 'ORCH_AGENT_TAG', '1\nX=2')).toThrow(UpdateError);
  });
});

describe('helper commands', () => {
  it('builds the exact argv of the detached helper', () => {
    expect(
      helperRunArgs(SELF, 'orch-agent-update-1', 5, { ORCH_CLAUDE_DIR: '/home/u/.claude' }),
    ).toEqual([
      'run',
      '-d',
      '--rm',
      '--name',
      'orch-agent-update-1',
      '--label',
      'orch.update-helper=1',
      '-v',
      '/var/run/docker.sock:/var/run/docker.sock',
      '-v',
      '/home/u/orch:/home/u/orch',
      '-w',
      '/home/u/orch',
      '-e',
      'ORCH_CLAUDE_DIR=/home/u/.claude',
      '--entrypoint',
      'sh',
      IMAGE_ID,
      '-c',
      HELPER_SCRIPT,
      'orch-update-helper',
      '5',
      'orch-agent',
      '/home/u/orch',
      'agent',
      '/home/u/orch/.env',
      '/home/u/orch/compose.yaml',
    ]);
    expect(() => helperRunArgs(SELF, 'x', 5, { PATH: '/tmp' })).toThrow(UpdateError);
  });

  it('builds the exact argv of the .env read and write', () => {
    expect(readFileArgs(SELF, '/home/u/orch/.env')).toEqual([
      'run',
      '--rm',
      '--network',
      'none',
      '--label',
      'orch.update-helper=1',
      '-v',
      '/home/u/orch:/home/u/orch',
      '--entrypoint',
      'sh',
      IMAGE_ID,
      '-c',
      'cat -- "$1"',
      'orch-update-read',
      '/home/u/orch/.env',
    ]);
    const w = writeEnvArgs(SELF);
    expect(w.slice(0, 5)).toEqual(['run', '--rm', '-i', '--network', 'none']);
    expect(w.slice(-3)).toEqual([
      `cp -p -- "$1" "$1${ENV_BACKUP_SUFFIX}" && cat > "$1"`,
      'orch-update-env',
      '/home/u/orch/.env',
    ]);
  });

  /** Runs HELPER_SCRIPT with a fake `docker` that logs its argv and fails when asked to. */
  function runHelper(failFirstUp: boolean) {
    const wd = join(tmp.dir, 'orch');
    const bin = join(tmp.dir, 'bin');
    mkdirSync(wd, { recursive: true });
    mkdirSync(bin, { recursive: true });
    const log = join(tmp.dir, 'docker.log');
    writeFileSync(
      join(bin, 'docker'),
      `#!/bin/sh\necho "$*" >> "${log}"\nif [ -n "$FAIL_ONCE" ] && [ ! -f "${log}.failed" ]; then touch "${log}.failed"; exit 1; fi\nexit 0\n`,
    );
    chmodSync(join(bin, 'docker'), 0o755);
    writeFileSync(join(wd, '.env'), 'ORCH_AGENT_TAG=0.4.3\n');
    writeFileSync(join(wd, `.env${ENV_BACKUP_SUFFIX}`), 'ORCH_AGENT_TAG=0.4.1\n');
    let code = 0;
    try {
      execFileSync(
        'sh',
        [
          '-c',
          HELPER_SCRIPT,
          'orch-update-helper',
          '0',
          'orch-agent',
          wd,
          'agent',
          join(wd, '.env'),
          join(wd, 'compose.yaml'),
          join(wd, 'override.yaml'),
        ],
        {
          env: { PATH: `${bin}:/usr/bin:/bin`, FAIL_ONCE: failFirstUp ? '1' : '' },
          stdio: 'ignore',
        },
      );
    } catch (e) {
      code = (e as { status: number }).status;
    }
    return { wd, code, calls: readFileSync(log, 'utf8').trim().split('\n') };
  }

  it('the helper script runs compose up for the agent service only', () => {
    const { wd, code, calls } = runHelper(false);
    expect(code).toBe(0);
    expect(calls).toEqual([
      `compose -p orch-agent --project-directory ${wd} -f ${wd}/compose.yaml -f ${wd}/override.yaml up -d --no-deps agent`,
    ]);
    expect(readFileSync(join(wd, '.env'), 'utf8')).toBe('ORCH_AGENT_TAG=0.4.3\n');
    expect(existsSync(join(wd, `.env${ENV_BACKUP_SUFFIX}`))).toBe(false);
  });

  it('the helper script restores the old .env and restarts the old version on failure', () => {
    const { wd, code, calls } = runHelper(true);
    expect(code).toBe(1);
    expect(calls).toHaveLength(2);
    expect(readFileSync(join(wd, '.env'), 'utf8')).toBe('ORCH_AGENT_TAG=0.4.1\n');
  });
});

// ---------- updater ----------

class FakeRunner implements CommandRunner {
  calls: { args: string[]; input?: string }[] = [];
  failPull = false;
  inspect = inspectJson(LABELS);
  env = 'ORCH_SERVER_URL=https://o\nORCH_AGENT_CREDENTIAL=orch_agent_x.secret\n';

  async run(_cmd: string, args: readonly string[], opts: RunOptions = {}): Promise<RunResult> {
    this.calls.push({ args: [...args], input: opts.input });
    const ok = (stdout = ''): RunResult => ({ code: 0, stdout, stderr: '' });
    if (args[0] === 'inspect') return ok(this.inspect);
    if (args[0] === 'pull') {
      return this.failPull ? { code: 1, stdout: '', stderr: 'manifest unknown' } : ok();
    }
    const last = args[args.length - 1];
    if (args.includes('orch-update-read')) {
      return ok(last?.endsWith('.env') ? this.env : COMPOSE_TEMPLATE);
    }
    return ok('helper-id\n');
  }
  kinds(): string[] {
    return this.calls.map((c) => {
      if (c.args[0] !== 'run') return c.args[0]!;
      const tag = c.args.find((a) => a.startsWith('orch-update-'));
      return tag ?? 'run';
    });
  }
}

function makeUpdater(running = 0) {
  const runner = new FakeRunner();
  const reports: UpdateStatusPayload[] = [];
  let tasks = running;
  const u = new Updater({
    runner,
    selfId: 'c0ffee',
    imageRepo: REPO,
    currentVersion: '0.4.1',
    dataDir: tmp.dir,
    runningTasks: () => tasks,
    report: (p) => reports.push(p),
    logger: silentLogger,
    helperDelaySec: 3,
    idlePollMs: 10,
  });
  return { u, runner, reports, setTasks: (n: number) => (tasks = n) };
}

const REQ = { updateId: 'upd_1', targetVersion: '0.4.3', image: `${REPO}:0.4.3`, whenIdle: false };

describe('Updater', () => {
  it('pulls, rewrites the .env tag and hands off to the helper', async () => {
    const { u, runner, reports } = makeUpdater();
    expect(u.request(REQ).status).toBe('pending');
    await u.inflight;
    expect(reports.map((r) => r.status)).toEqual(['pending', 'pulling', 'restarting']);
    expect(runner.kinds()).toEqual([
      'inspect',
      'orch-update-read',
      'pull',
      'orch-update-read',
      'orch-update-env',
      'orch-update-helper',
    ]);
    expect(runner.calls[0]!.args).toEqual(['inspect', '--type', 'container', '--', 'c0ffee']);
    expect(runner.calls[2]!.args).toEqual(['pull', '--', `${REPO}:0.4.3`]);
    expect(runner.calls[4]!.input).toBe(`${runner.env}ORCH_AGENT_TAG=0.4.3\n`);
    const helper = runner.calls[5]!.args;
    expect(helper.slice(0, 3)).toEqual(['run', '-d', '--rm']);
    expect(helper).toContain(IMAGE_ID);
    // The .env had no ORCH_CLAUDE_DIR: the current mount source is kept for the restart.
    expect(helper).toContain('ORCH_CLAUDE_DIR=/home/u/.claude');
    expect(JSON.parse(readFileSync(join(tmp.dir, 'update-pending.json'), 'utf8'))).toEqual({
      updateId: 'upd_1',
      targetVersion: '0.4.3',
      fromVersion: '0.4.1',
    });
    // Secrets of the .env never reach a report.
    expect(JSON.stringify(reports)).not.toContain('secret');
  });

  it('refuses while tasks are running unless "when idle" was chosen', () => {
    const { u, runner, reports } = makeUpdater(2);
    const s = u.request(REQ);
    expect(s).toMatchObject({ status: 'failed', code: 'busy' });
    expect(reports[0]).toMatchObject({ updateId: 'upd_1', status: 'failed', code: 'busy' });
    expect(runner.calls).toHaveLength(0);
  });

  it('defers until idle, then updates', async () => {
    const { u, runner, reports, setTasks } = makeUpdater(1);
    expect(u.request({ ...REQ, whenIdle: true }).status).toBe('deferred');
    expect(u.isDeferred()).toBe(true);
    await new Promise((r) => setTimeout(r, 40));
    expect(runner.calls).toHaveLength(0);
    setTasks(0);
    await waitFor(() => reports.some((r) => r.status === 'pending'), { what: 'start' });
    await u.inflight;
    expect(reports.map((r) => r.status)).toEqual(['deferred', 'pending', 'pulling', 'restarting']);
    expect(u.isDeferred()).toBe(false);
    u.close();
  });

  it('rejects an image outside the allowed repository without running anything', () => {
    const { u, runner, reports } = makeUpdater();
    const s = u.request({ ...REQ, image: 'docker.io/evil/agent:0.4.3' });
    expect(s).toMatchObject({ status: 'failed', code: 'invalid_image' });
    expect(reports).toHaveLength(1);
    expect(runner.calls).toHaveLength(0);
  });

  it('keeps everything as it was when the pull fails', async () => {
    const { u, runner, reports } = makeUpdater();
    runner.failPull = true;
    u.request(REQ);
    await u.inflight;
    expect(reports.at(-1)).toMatchObject({ status: 'failed', code: 'pull_failed' });
    expect(runner.kinds()).toEqual(['inspect', 'orch-update-read', 'pull']);
    expect(existsSync(join(tmp.dir, 'update-pending.json'))).toBe(false);
  });

  it('fails cleanly when the agent was not started by compose', async () => {
    const { u, runner, reports } = makeUpdater();
    runner.inspect = inspectJson({});
    u.request(REQ);
    await u.inflight;
    expect(reports.at(-1)).toMatchObject({ status: 'failed', code: 'not_compose' });
    expect(runner.kinds()).toEqual(['inspect']);
  });

  it('reports done (or not applied) after the restart', () => {
    writeFileSync(
      join(tmp.dir, 'update-pending.json'),
      JSON.stringify({ updateId: 'upd_1', targetVersion: '0.4.3', fromVersion: '0.4.1' }),
    );
    const reports: UpdateStatusPayload[] = [];
    const mk = (currentVersion: string) =>
      new Updater({
        runner: new FakeRunner(),
        selfId: 'x',
        imageRepo: REPO,
        currentVersion,
        dataDir: tmp.dir,
        runningTasks: () => 0,
        report: (p) => reports.push(p),
        logger: silentLogger,
      });
    mk('0.4.3').resumeAfterRestart();
    expect(reports[0]).toMatchObject({ updateId: 'upd_1', status: 'done' });
    expect(existsSync(join(tmp.dir, 'update-pending.json'))).toBe(false);
    writeFileSync(
      join(tmp.dir, 'update-pending.json'),
      JSON.stringify({ updateId: 'upd_2', targetVersion: '0.4.3', fromVersion: '0.4.1' }),
    );
    mk('0.4.1').resumeAfterRestart();
    expect(reports[1]).toMatchObject({ updateId: 'upd_2', status: 'failed', code: 'not_applied' });
  });
});

// ---------- agent wiring ----------

describe('Agent self-update', () => {
  let cleanups: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const c of cleanups.reverse()) await c();
    cleanups = [];
  });

  async function setup(withUpdate = true) {
    const s = await new FakeServer({ credential: CREDENTIAL }).start();
    cleanups.push(() => s.stop());
    s.config = { ...s.config, latestAgentVersion: '0.4.3' } as typeof s.config;
    const runner = new FakeRunner();
    const agent = new Agent({
      serverUrl: 'http://127.0.0.1',
      wsUrl: s.url,
      credential: CREDENTIAL,
      agentId: 'agt_test',
      dataDir: join(tmp.dir, 'data'),
      socketPath: join(tmp.dir, 'orch.sock'),
      usageIntervalSec: 3600,
      usageIntervalExplicit: false,
      usageSource: { estimateUsage: async () => null as never },
      logger: silentLogger,
      backoff: { baseMs: 20, maxMs: 100 },
      outboxRetryMs: 150,
      usageFirstDelayMs: 3_600_000,
      ...(withUpdate
        ? {
            update: {
              runner,
              selfId: 'c0ffee',
              imageRepo: REPO,
              currentVersion: '0.4.1',
              helperDelaySec: 0,
            },
          }
        : {}),
    });
    await agent.start();
    cleanups.push(() => agent.stop());
    await waitFor(() => s.ofType('hello').length > 0 && agent.client.ready, { what: 'welcome' });
    return { s, agent, runner };
  }

  it('announces selfUpdate in hello and runs agent.update, reporting update.status', async () => {
    const { s, agent, runner } = await setup();
    expect(s.ofType('hello')[0]!.payload.selfUpdate).toBe(true);
    const m = serverMessage('agent.update', REQ);
    s.send(m);
    await waitFor(() => s.ofType('update.status').some((f) => f.payload.status === 'restarting'), {
      what: 'restarting',
    });
    expect(s.ofType('ack').some((a) => a.replyTo === m.id)).toBe(true);
    // Outbox retries resend the same id: compare distinct messages.
    const distinct = [...new Map(s.ofType('update.status').map((f) => [f.id, f])).values()];
    expect(distinct.map((f) => f.payload.status)).toEqual(['pending', 'pulling', 'restarting']);
    expect(runner.calls.some((c) => c.args[0] === 'pull')).toBe(true);
    expect(agent.status().latestAgentVersion).toBe('0.4.3');
    expect(agent.status().update?.status).toBe('restarting');
  });

  it('a forged image in agent.update is refused and nothing runs', async () => {
    const { s, runner } = await setup();
    s.send(serverMessage('agent.update', { ...REQ, image: 'evil.example/x:0.4.3' }));
    await waitFor(() => s.ofType('update.status').length > 0, { what: 'status' });
    expect(s.ofType('update.status')[0]!.payload).toMatchObject({
      status: 'failed',
      code: 'invalid_image',
    });
    expect(runner.calls).toHaveLength(0);
  });

  it('without self-update support the agent says so', async () => {
    const { s } = await setup(false);
    expect(s.ofType('hello')[0]!.payload.selfUpdate).toBeUndefined();
    s.send(serverMessage('agent.update', REQ));
    await waitFor(() => s.ofType('update.status').length > 0, { what: 'status' });
    expect(s.ofType('update.status')[0]!.payload).toMatchObject({ code: 'unsupported' });
  });
});

// ---------- orch update CLI ----------

describe('orch update', () => {
  let server: ControlServer | undefined;
  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  function io() {
    const out: string[] = [];
    const err: string[] = [];
    const sink = (arr: string[]) => {
      const s = new PassThrough();
      s.on('data', (c: Buffer) => arr.push(c.toString()));
      return s;
    };
    const stdin = new PassThrough();
    stdin.end('');
    return { io: { stdin, stdout: sink(out), stderr: sink(err) }, out, err };
  }

  const base: StatusInfo = {
    agentId: 'agt_1',
    version: '0.4.1',
    connected: true,
    paused: false,
    serverUrl: 'https://o',
    lastUsageReportAt: null,
    outboxPending: 0,
  };

  async function start(onUpdate: (r: { version?: string; whenIdle?: boolean }) => ControlResult) {
    const statuses: StatusInfo['update'][] = [
      { updateId: 'local-1', targetVersion: '0.4.3', status: 'pulling' },
      {
        updateId: 'local-1',
        targetVersion: '0.4.3',
        status: 'restarting',
        detail: 'Restarting on x in 5 s',
      },
    ];
    const path = join(tmp.dir, 'orch.sock');
    server = await startControlServer(
      path,
      {
        status: () => ({ status: { ...base, update: statuses.shift() ?? null } }),
        update: onUpdate,
      },
      silentLogger,
    );
    return { ORCH_SOCKET_PATH: path };
  }

  it('requests the update and follows it until the restart hand-off', async () => {
    const seen: unknown[] = [];
    const env = await start((r) => {
      seen.push(r);
      return {
        message: 'Updating to v0.4.3: pulling the image, then the agent restarts.',
        update: { updateId: 'local-1', targetVersion: '0.4.3', status: 'pending' },
      };
    });
    const a = io();
    expect(await runCli(['update'], a.io, env, { sleep: async () => undefined })).toBe(0);
    expect(seen).toEqual([{ cmd: 'update', whenIdle: false }]);
    const out = a.out.join('');
    expect(out).toContain('Updating to v0.4.3');
    expect(out).toContain('Pulling the new image');
    expect(out).toContain('The agent restarts in a few seconds');
  });

  it('passes --when-idle and --version, and exits 1 on a refusal', async () => {
    const seen: unknown[] = [];
    const env = await start((r) => {
      seen.push(r);
      throw Object.assign(new Error('2 task(s) running on this machine.'), { code: 'busy' });
    });
    const a = io();
    expect(await runCli(['update', '--when-idle', '--version=0.4.3'], a.io, env)).toBe(1);
    expect(seen).toEqual([{ cmd: 'update', whenIdle: true, version: '0.4.3' }]);
    expect(a.err.join('')).toContain('2 task(s) running');
    const b = io();
    expect(await runCli(['update', '--image=evil'], b.io, env)).toBe(2);
  });
});
