import { execFile } from 'node:child_process';
import { readFileSync, statSync, writeFileSync, chmodSync } from 'node:fs';
import { createConnection } from 'node:net';
import { join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DaemonNotRunningError, sendControl } from '../src/cli/client';
import type { StatusInfo } from '../src/cli/protocol';
import { extractToken, login } from '../src/cli/login';
import { runCli } from '../src/cli/run';
import { startControlServer, type ControlServer } from '../src/control/server';
import { silentLogger } from '../src/log';
import { tempDir } from './helpers/util';

const AGENT_DIR = resolve(__dirname, '..');
const TOKEN = 'sk-ant-oat01-' + 'A1b2C3d4'.repeat(8);

let tmp: ReturnType<typeof tempDir>;
let server: ControlServer | undefined;
let paused = false;
const status = (): StatusInfo => ({
  agentId: 'agt_1',
  version: '0.0.0',
  connected: false,
  paused,
  serverUrl: 'https://orch.example.com',
  lastUsageReportAt: null,
  outboxPending: paused ? 1 : 0,
});

beforeEach(() => {
  tmp = tempDir();
  paused = false;
});
afterEach(async () => {
  await server?.close();
  server = undefined;
  tmp.cleanup();
});

async function startServer(path = join(tmp.dir, 'orch.sock')) {
  server = await startControlServer(
    path,
    {
      status: () => ({ status: status() }),
      pause: () => ((paused = true), { status: status() }),
      resume: () => ((paused = false), { status: status() }),
    },
    silentLogger,
  );
  return path;
}

function io(input = '') {
  const stdin = new PassThrough();
  stdin.end(input);
  const out: string[] = [];
  const err: string[] = [];
  const sink = (arr: string[]) => {
    const s = new PassThrough();
    s.on('data', (c: Buffer) => arr.push(c.toString()));
    return s;
  };
  return { io: { stdin, stdout: sink(out), stderr: sink(err) }, out, err };
}

function runEntry(args: string[], env: Record<string, string>, input?: string) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((res) => {
    const child = execFile(
      process.execPath,
      ['--import', 'tsx', 'src/cli/main.ts', ...args],
      { cwd: AGENT_DIR, env: { ...process.env, ...env }, timeout: 20_000 },
      (error, stdout, stderr) => res({ code: error ? Number(error.code ?? 1) : 0, stdout, stderr }),
    );
    if (input !== undefined) child.stdin?.end(input);
  });
}

describe('control socket', () => {
  it('serves status/pause/resume with mode 0600 and rejects unknown commands', async () => {
    const path = await startServer();
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(await sendControl(path, { cmd: 'status' })).toEqual({ ok: true, status: status() });
    const p = await sendControl(path, { cmd: 'pause' });
    expect(p.ok && p.status?.paused).toBe(true);

    const reply = await new Promise<string>((res) => {
      const c = createConnection(path, () => c.write('{"cmd":"explode"}\n'));
      c.on('data', (d) => {
        res(d.toString());
        c.destroy();
      });
    });
    expect(JSON.parse(reply)).toMatchObject({ ok: false, error: { code: 'unknown_command' } });
  });

  it('removes a stale socket file on start', async () => {
    const path = await startServer();
    await server!.close();
    server = undefined;
    await startServer(path);
    expect((await sendControl(path, { cmd: 'status' })).ok).toBe(true);
  });

  it('reports a clear error when the daemon is not running', async () => {
    await expect(sendControl(join(tmp.dir, 'none.sock'), { cmd: 'status' })).rejects.toBeInstanceOf(
      DaemonNotRunningError,
    );
  });
});

describe('orch CLI', () => {
  it('status/pause/resume print human-readable output', async () => {
    const path = await startServer();
    const env = { ORCH_SOCKET_PATH: path };
    const a = io();
    expect(await runCli(['status'], a.io, env)).toBe(0);
    expect(a.out.join('')).toContain('Agent:        agt_1');
    expect(a.out.join('')).toContain('Paused:       no');
    const b = io();
    expect(await runCli(['pause'], b.io, env)).toBe(0);
    expect(b.out.join('')).toMatch(/^Paused\. \(offline/);
    const c = io();
    expect(await runCli(['resume'], c.io, env)).toBe(0);
    expect(c.out.join('')).toMatch(/^Resumed\./);
    const d = io();
    expect(await runCli(['take', '12'], d.io, env)).toBe(1);
    expect(d.err.join('')).toContain('take is not available on this agent');
    const e = io();
    expect(await runCli(['take', 'abc'], e.io, env)).toBe(2);
    const h = io();
    expect(await runCli(['help'], h.io, env)).toBe(0);
    expect(h.out.join('')).toContain('Usage: orch');
  });

  it('the real entry talks to the daemon socket', async () => {
    const path = await startServer();
    const r = await runEntry(['status'], { ORCH_SOCKET_PATH: path });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Server:       https://orch.example.com');
    expect(r.stdout).toContain('Connection:   disconnected');
  });

  it('the real entry exits 1 with a clear message when the daemon is not running', async () => {
    const r = await runEntry(['status'], { ORCH_SOCKET_PATH: join(tmp.dir, 'none.sock') });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('daemon is not running');
  });
});

describe('orch login', () => {
  function fakeClaude(exitCode = 0) {
    const bin = join(tmp.dir, 'fake-claude');
    writeFileSync(
      bin,
      `#!/bin/sh\necho "fake claude $1" >> "${join(tmp.dir, 'calls')}"\necho "Your token: (shown by claude)"\nexit ${exitCode}\n`,
    );
    chmodSync(bin, 0o755);
    return bin;
  }

  it('wraps claude setup-token and stores the token 0600 without printing it', async () => {
    const secrets = join(tmp.dir, 'secrets');
    const r = await runEntry(
      ['login', '--token-stdin'],
      { ORCH_SECRETS_DIR: secrets, ORCH_CLAUDE_BIN: fakeClaude() },
      `${TOKEN}\n`,
    );
    expect(r.code).toBe(0);
    expect(readFileSync(join(tmp.dir, 'calls'), 'utf8')).toBe('fake claude setup-token\n');
    const file = join(secrets, 'claude-token');
    expect(readFileSync(file, 'utf8').trim()).toBe(TOKEN);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(r.stdout + r.stderr).not.toContain(TOKEN);
    expect(r.stdout + r.stderr).not.toContain('A1b2C3d4');
  });

  it('rejects an invalid token and a failing setup-token', async () => {
    const secrets = join(tmp.dir, 'secrets');
    const bad = io('two words here\n');
    expect(
      await runCli(['login', '--token-stdin'], bad.io, {
        ORCH_SECRETS_DIR: secrets,
        ORCH_CLAUDE_BIN: fakeClaude(),
      }),
    ).toBe(1);
    expect(bad.err.join('')).toContain('whitespace');
    const fail = io(`${TOKEN}\n`);
    expect(
      await runCli(['login', '--token-stdin'], fail.io, {
        ORCH_SECRETS_DIR: secrets,
        ORCH_CLAUDE_BIN: fakeClaude(3),
      }),
    ).toBe(1);
    expect(fail.err.join('')).toContain('setup-token failed');
    const missing = io(`${TOKEN}\n`);
    expect(
      await runCli(['login', '--token-stdin'], missing.io, {
        ORCH_SECRETS_DIR: secrets,
        ORCH_CLAUDE_BIN: join(tmp.dir, 'nope'),
      }),
    ).toBe(1);
    expect(missing.err.join('')).toContain('Claude Code CLI not found');
  });

  it('captures the token from the setup-token output in a pty, without asking or echoing it', async () => {
    const secrets = join(tmp.dir, 'secrets');
    const bin = join(tmp.dir, 'fake-claude-print');
    writeFileSync(
      bin,
      `#!/bin/sh\necho "Open https://claude.ai/oauth/authorize?x=1"\necho "Your OAuth token (valid for 1 year):"\necho "${TOKEN}"\necho "Store this token securely."\n`,
    );
    chmodSync(bin, 0o755);
    const r = await runEntry(['login'], { ORCH_SECRETS_DIR: secrets, ORCH_CLAUDE_BIN: bin }, '');
    expect(r.stderr).not.toContain('Paste the token');
    expect(r.code).toBe(0);
    const file = join(secrets, 'claude-token');
    expect(readFileSync(file, 'utf8').trim()).toBe(TOKEN);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('uses the injected runner output and falls back to the hidden prompt when none is found', async () => {
    const secrets = join(tmp.dir, 'secrets');
    const base = { secretsDir: secrets, claudeBin: 'x', tokenFromStdin: false, skipSetup: false };
    const a = io('');
    await login(
      { ...base, setupRunner: async () => `\u001b[1mtoken\u001b[0m\r\n${TOKEN}\r\n` },
      a.io,
    );
    expect(readFileSync(join(secrets, 'claude-token'), 'utf8').trim()).toBe(TOKEN);
    expect(a.out.join('') + a.err.join('')).not.toContain(TOKEN);

    const other = 'sk-ant-oat01-' + 'Zz9Yy8Xx'.repeat(8);
    const b = io(`${other}\n`);
    await login({ ...base, setupRunner: async () => 'no token here\n' }, b.io);
    expect(b.err.join('')).toContain('Could not read the token automatically');
    expect(readFileSync(join(secrets, 'claude-token'), 'utf8').trim()).toBe(other);
  });
});

describe('extractToken', () => {
  it('finds a token among ANSI codes and CRLF', () => {
    const out = `\u001b[2J\u001b[1;1HOpen the URL\r\n\u001b[32m${TOKEN}\u001b[0m\r\nStore it.\r\n`;
    expect(extractToken(out)).toBe(TOKEN);
  });
  it('joins a token wrapped over several lines but not following prose', () => {
    const out = `Your token:\n${TOKEN.slice(0, 40)}\n${TOKEN.slice(40, 80)}\n${TOKEN.slice(80)}\n\nStore this token securely.\n`;
    expect(extractToken(out)).toBe(TOKEN);
  });
  it('returns null when there is no token', () => {
    expect(extractToken('Open https://claude.ai ... paste the code\n')).toBeNull();
    expect(extractToken('sk-ant-\n')).toBeNull();
  });
});
