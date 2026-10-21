import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ClaudeAuthPayload } from '@orch/shared';
import { Agent } from '../src/agent';
import { ClaudeAuthState, hashClaudeToken } from '../src/claude-auth';
import {
  CHECK_LABEL,
  buildCheckCreateArgs,
  checkArgv,
  checkClaudeAuth,
  checkLine,
  classifyCheck,
  classifyDockerFailure,
  resolveExecutable,
  tokenFileHash,
  tokenFileStat,
  type ClaudeCheckDeps,
  type ClaudeCheckOutcome,
} from '../src/claude-check';
import { sendControl } from '../src/cli/client';
import { defaultLocalCheck, doctor, runCli, type CliDeps } from '../src/cli/run';
import type { CliConfig } from '../src/config';
import { startControlServer, type ControlServer } from '../src/control/server';
import type { CommandRunner, RunOptions, RunResult } from '../src/exec/runner';
import { BLANKED_AUTH_ENV, CLAUDE_TOKEN_ENV } from '../src/exec/sandbox';
import { silentLogger } from '../src/log';
import { CREDENTIAL, tempDir, waitFor } from './helpers/util';

const TOKEN = 'sk-ant-oat01-FAKE' + 'x'.repeat(90);
const CFG = {
  agentId: 'agt_1',
  image: 'node:22-bookworm',
  claudeBin: '/opt/orch/bin/claude',
  uid: 1000,
  gid: 1000,
};
const values = (args: string[], flag: string) =>
  args.flatMap((a, i) => (a === flag ? [args[i + 1] as string] : []));

let tmp: ReturnType<typeof tempDir>;
let cleanups: (() => Promise<void> | void)[] = [];
beforeEach(() => {
  tmp = tempDir();
});
afterEach(async () => {
  for (const c of cleanups.reverse()) await c();
  cleanups = [];
  tmp.cleanup();
});

describe('classifyCheck', () => {
  const ok = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'ok' });
  it('accepts a clean result', () => {
    expect(classifyCheck({ code: 0, stdout: ok, stderr: '' })).toMatchObject({ valid: true });
    expect(classifyCheck({ code: 0, stdout: ok, stderr: '' }).errorClass).toBeUndefined();
  });
  it('flags rejected tokens as unauthorized', () => {
    for (const msg of [
      'Failed to authenticate. API Error: 401 OAuth access token is invalid.',
      'Invalid API key · Please run /login',
      'API Error: 401 {"type":"error","error":{"type":"authentication_error"}}',
      'invalid x-api-key',
      'OAuth token has expired',
      'OAuth token revoked',
    ]) {
      expect(classifyCheck({ code: 1, stdout: '', stderr: msg })).toEqual({
        valid: false,
        errorClass: 'unauthorized',
        text: msg,
      });
    }
    const errJson = JSON.stringify({
      is_error: true,
      result: 'Invalid API key · Please run /login',
    });
    expect(classifyCheck({ code: 1, stdout: errJson, stderr: '' }).errorClass).toBe('unauthorized');
    // Real Claude Code 2.1.306 output for a rejected token: subtype "success" but is_error true.
    const real = JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: true,
      result: 'Failed to authenticate. API Error: 401 OAuth access token is invalid.',
      terminal_reason: 'api_error',
    });
    expect(classifyCheck({ code: 1, stdout: real, stderr: '' })).toMatchObject({
      valid: false,
      errorClass: 'unauthorized',
    });
    expect(classifyCheck({ code: 0, stdout: real, stderr: '' }).valid).toBe(false);
    // exit 0 but an error result is not a success
    expect(classifyCheck({ code: 0, stdout: errJson, stderr: '' }).valid).toBe(false);
  });
  it('treats a rate limit as accepted auth', () => {
    expect(
      classifyCheck({ code: 1, stdout: '', stderr: 'API Error: 429 rate_limit_error' }),
    ).toMatchObject({ valid: true, errorClass: 'rate_limited' });
    expect(
      classifyCheck({ code: 1, stdout: '', stderr: 'Claude AI usage limit reached|1760000000' }),
    ).toMatchObject({ valid: true, errorClass: 'rate_limited' });
  });
  it('does not take a generic "rate limit" / "limit reached" as accepted auth', () => {
    for (const stderr of ['some rate limit hit', 'limit reached', 'toomanyrequests: rate limit']) {
      expect(classifyCheck({ code: 1, stdout: '', stderr }).valid).toBe(false);
    }
  });
  it('classifies timeouts, network and other errors as inconclusive', () => {
    expect(classifyCheck({ code: 128, stdout: '', stderr: '', timedOut: true }).errorClass).toBe(
      'timeout',
    );
    expect(
      classifyCheck({ code: 1, stdout: '', stderr: 'getaddrinfo ENOTFOUND api.anthropic.com' })
        .errorClass,
    ).toBe('network');
    expect(classifyCheck({ code: 1, stdout: '', stderr: 'connect ECONNREFUSED' }).errorClass).toBe(
      'network',
    );
    expect(classifyCheck({ code: 2, stdout: '', stderr: 'segfault' })).toMatchObject({
      valid: false,
      errorClass: 'error',
    });
  });
});

describe('check container', () => {
  it('builds hardened create args with the token by name only', () => {
    const args = buildCheckCreateArgs('orch-claude-check-1', CFG);
    expect(values(args, '--user')).toEqual(['1000:1000']);
    expect(values(args, '--cap-drop')).toEqual(['ALL']);
    expect(values(args, '--security-opt')).toEqual(['no-new-privileges']);
    expect(values(args, '--tmpfs')[0]).toMatch(/^\/tmp:/);
    expect(values(args, '--label')).toEqual(
      expect.arrayContaining(['orch.agent=agt_1', `${CHECK_LABEL}=claude-auth`]),
    );
    expect(args).not.toContain('--mount');
    expect(args).not.toContain('-v');
    const env = values(args, '-e');
    expect(env).toEqual(
      expect.arrayContaining([
        'HOME=/tmp',
        'CLAUDE_CONFIG_DIR=/tmp/.claude',
        'DISABLE_AUTOUPDATER=1',
      ]),
    );
    for (const k of BLANKED_AUTH_ENV) expect(env).toContain(`${k}=`);
    expect(env[env.length - 1]).toBe(CLAUDE_TOKEN_ENV);
    expect(args.slice(-4)).toEqual(['--entrypoint', 'sleep', 'node:22-bookworm', 'infinity']);
    expect(() => buildCheckCreateArgs('x', { ...CFG, uid: 0 })).toThrow();
    expect(checkArgv(CFG.claudeBin)).toEqual([
      '/opt/orch/bin/claude',
      '-p',
      'reply with: ok',
      '--max-turns',
      '1',
      '--model',
      'haiku',
      '--output-format',
      'json',
    ]);
  });

  function fakeDocker(result: RunResult | Error) {
    const calls: { op: string; args: unknown[] }[] = [];
    const docker: ClaudeCheckDeps['docker'] = {
      create: async (args, env) => void calls.push({ op: 'create', args: [args, env] }),
      copyIn: async (c, f) => void calls.push({ op: 'copyIn', args: [c, f] }),
      start: async (c) => void calls.push({ op: 'start', args: [c] }),
      remove: async (c) => void calls.push({ op: 'remove', args: [c] }),
      pull: async (i) => void calls.push({ op: 'pull', args: [i] }),
    };
    const runner: CommandRunner = {
      run: async (cmd: string, args: readonly string[], opts?: RunOptions) => {
        calls.push({ op: 'run', args: [cmd, [...args], opts] });
        if (result instanceof Error) throw result;
        return result;
      },
    };
    return { docker, runner, calls };
  }

  it('runs claude in a throwaway container, token only in the docker env, always removed', async () => {
    const f = fakeDocker({
      code: 0,
      stdout: JSON.stringify({ is_error: false, result: 'ok' }),
      stderr: '',
    });
    const out = await checkClaudeAuth(CFG, { ...f, readClaudeToken: () => TOKEN });
    expect(out.payload.valid).toBe(true);
    expect(out.payload.errorClass).toBeUndefined();
    expect(out.tokenHash).toBe(hashClaudeToken(TOKEN));
    expect(f.calls.map((c) => c.op)).toEqual(['create', 'copyIn', 'start', 'run', 'remove']);
    const [createArgs, env] = f.calls[0]!.args as [string[], Record<string, string>];
    expect(env).toEqual({ [CLAUDE_TOKEN_ENV]: TOKEN });
    const name = values(createArgs, '--name')[0];
    expect(f.calls[1]!.args).toEqual([name, CFG.claudeBin]);
    const [, runArgs, opts] = f.calls[3]!.args as [string, string[], RunOptions];
    expect(runArgs.slice(0, 2)).toEqual(['exec', name]);
    expect(opts.timeoutMs).toBe(90_000);
    expect(f.calls[4]!.args).toEqual([name]);
    // The token never appears in any argv.
    for (const c of f.calls) {
      const argv = c.op === 'create' ? (c.args[0] as string[]) : c.args;
      expect(JSON.stringify(argv)).not.toContain('FAKE');
    }
  });

  it('reports unauthorized with a redacted detail and removes the container on errors', async () => {
    const f = fakeDocker({
      code: 1,
      stdout: '',
      stderr: `Failed to authenticate. API Error: 401 OAuth access token is invalid. ${TOKEN}`,
    });
    const out = await checkClaudeAuth(CFG, { ...f, readClaudeToken: () => TOKEN });
    expect(out.payload).toMatchObject({ valid: false, errorClass: 'unauthorized' });
    expect(out.payload.detail).toMatch(/OAuth access token is invalid/);
    expect(out.payload.detail).not.toContain('FAKE');
    expect(out.payload.detail!.length).toBeLessThanOrEqual(300);

    const g = fakeDocker(new Error('spawn docker ENOENT'));
    const e = await checkClaudeAuth(CFG, { ...g, readClaudeToken: () => TOKEN });
    expect(e.payload).toMatchObject({ valid: false, errorClass: 'error' });
    expect(g.calls.at(-1)?.op).toBe('remove');
  });

  it('never validates on a docker step failure (pull rate limit, create, copy, start)', async () => {
    const pullLimit =
      'toomanyrequests: You have reached your pull rate limit. You may increase the limit by authenticating';
    const cases: [string, Partial<ClaudeCheckDeps['docker']>, string][] = [
      [
        'pull',
        {
          create: async () => {
            throw new Error('Unable to find image: No such image');
          },
          pull: async () => {
            throw new Error(pullLimit);
          },
        },
        'network',
      ],
      [
        'create',
        {
          create: async () => {
            throw new Error(`Error response from daemon: ${pullLimit}`);
          },
        },
        'network',
      ],
      [
        'copy',
        {
          copyIn: async () => {
            throw new Error('usage limit reached: disk quota');
          },
        },
        'error',
      ],
      [
        'start',
        {
          start: async () => {
            throw new Error('API Error: 429 rate_limit_error');
          },
        },
        'error',
      ],
    ];
    for (const [step, override, errorClass] of cases) {
      const f = fakeDocker({ code: 0, stdout: JSON.stringify({ result: 'ok' }), stderr: '' });
      const out = await checkClaudeAuth(CFG, {
        ...f,
        docker: { ...f.docker, ...override },
        readClaudeToken: () => TOKEN,
      });
      expect(out.payload, step).toMatchObject({ valid: false, errorClass });
      expect(out.payload.detail, step).toContain(`docker ${step} failed`);
      expect(
        f.calls.some((c) => c.op === 'run'),
        step,
      ).toBe(false);
      expect(f.calls.at(-1)?.op, step).toBe('remove');
    }
    expect(
      classifyDockerFailure('create', 'dial tcp: lookup registry: no such host'),
    ).toMatchObject({ valid: false, errorClass: 'network' });
  });

  it('answers no_token without any container', async () => {
    const f = fakeDocker({ code: 0, stdout: '', stderr: '' });
    const out = await checkClaudeAuth(CFG, { ...f, readClaudeToken: () => null });
    expect(out).toMatchObject({
      payload: { valid: false, errorClass: 'no_token' },
      tokenHash: null,
    });
    expect(f.calls).toEqual([]);
  });
});

describe('ClaudeAuthState transitions', () => {
  const at = '2026-10-21T12:00:00.000Z';
  it('only a successful check validates; unauthorized/no_token invalidate; others keep', () => {
    const s = new ClaudeAuthState(tmp.dir);
    s.markInvalid('401 from a task');
    // A token being present (or stored again) changes nothing.
    writeFileSync(join(tmp.dir, 'claude-token'), TOKEN);
    expect(s.isValid()).toBe(false);
    s.recordCheck({ valid: false, checkedAt: at, errorClass: 'network', detail: 'x' }, 'h1');
    expect(s.read()).toMatchObject({ valid: false, errorClass: 'network', tokenHash: 'h1' });
    s.recordCheck({ valid: true, checkedAt: at }, 'h1');
    expect(s.read()).toEqual({ valid: true, checkedAt: at, tokenHash: 'h1' });
    s.recordCheck({ valid: false, checkedAt: at, errorClass: 'timeout' }, 'h1');
    expect(s.isValid()).toBe(true);
    s.recordCheck({ valid: false, checkedAt: at, errorClass: 'unauthorized' }, 'h2');
    expect(s.read()).toMatchObject({ valid: false, errorClass: 'unauthorized', tokenHash: 'h2' });
    s.recordCheck({ valid: true, checkedAt: at, errorClass: 'rate_limited' }, 'h3');
    expect(s.read()).toMatchObject({ valid: true, errorClass: 'rate_limited' });
    s.recordCheck({ valid: false, checkedAt: at, errorClass: 'no_token' }, null);
    expect(s.read().valid).toBe(false);
    expect(s.read().tokenHash).toBeUndefined();
    // Task failures still invalidate.
    s.recordCheck({ valid: true, checkedAt: at }, 'h3');
    s.markInvalid('401');
    expect(s.read()).toMatchObject({ valid: false, tokenHash: 'h3' });
    expect(JSON.stringify(s.read())).not.toContain('FAKE');
  });
});

describe('Agent Claude check', () => {
  async function setup(result: (n: number) => ClaudeAuthPayload, opts: { watchMs?: number } = {}) {
    const secrets = join(tmp.dir, 'secrets');
    mkdirSync(secrets, { recursive: true });
    let runs = 0;
    const agent = new Agent({
      serverUrl: 'http://127.0.0.1',
      wsUrl: 'ws://127.0.0.1:1/agent/ws',
      credential: CREDENTIAL,
      agentId: 'agt_test',
      dataDir: join(tmp.dir, 'data'),
      socketPath: join(tmp.dir, 'orch.sock'),
      usageIntervalSec: 3600,
      usageIntervalExplicit: true,
      usageSource: { estimateUsage: () => new Promise(() => undefined) },
      logger: silentLogger,
      backoff: { baseMs: 1000, maxMs: 1000 },
      claudeCheck: {
        run: async (): Promise<ClaudeCheckOutcome> => {
          runs++;
          await new Promise((r) => setTimeout(r, 20));
          return { payload: result(runs), tokenHash: tokenFileHash(secrets) };
        },
        tokenStat: () => tokenFileStat(secrets),
        tokenHash: () => tokenFileHash(secrets),
        watchMs: opts.watchMs ?? 20,
      },
    });
    return { agent, secrets, runs: () => runs };
  }
  const ok = (): ClaudeAuthPayload => ({ valid: true, checkedAt: new Date().toISOString() });

  it('checks once per token change, records it and queues claude.auth', async () => {
    const t = await setup(ok);
    writeFileSync(join(t.secrets, 'claude-token'), TOKEN);
    await t.agent.start();
    cleanups.push(() => t.agent.stop());
    await waitFor(() => t.runs() === 1, { what: 'first check' });
    await waitFor(() => t.agent.outbox.hasPending('claude.auth'), { what: 'claude.auth queued' });
    // Several watch ticks with the same token: no new check.
    await new Promise((r) => setTimeout(r, 150));
    expect(t.runs()).toBe(1);
    const queued = t.agent.outbox.pending().filter((e) => e.type === 'claude.auth');
    expect(queued).toHaveLength(1);
    expect(queued[0]!.payload).toMatchObject({ valid: true });
    expect(new ClaudeAuthState(join(tmp.dir, 'data')).read()).toMatchObject({
      valid: true,
      tokenHash: hashClaudeToken(TOKEN),
    });
    // A new token: exactly one more check.
    writeFileSync(join(t.secrets, 'claude-token'), TOKEN + 'y');
    await waitFor(() => t.runs() === 2, { what: 'second check' });
    await new Promise((r) => setTimeout(r, 150));
    expect(t.runs()).toBe(2);
  });

  it('does not check at startup when the stored hash matches', async () => {
    const t = await setup(ok);
    writeFileSync(join(t.secrets, 'claude-token'), TOKEN);
    new ClaudeAuthState(join(tmp.dir, 'data')).recordCheck(ok(), hashClaudeToken(TOKEN));
    await t.agent.start();
    cleanups.push(() => t.agent.stop());
    await new Promise((r) => setTimeout(r, 150));
    expect(t.runs()).toBe(0);
  });

  it('serves claude.check over the control socket (single-flight)', async () => {
    const t = await setup(
      (): ClaudeAuthPayload => ({
        valid: false,
        checkedAt: new Date().toISOString(),
        errorClass: 'unauthorized',
        detail: '401',
      }),
      { watchMs: 60_000 },
    );
    await t.agent.start();
    cleanups.push(() => t.agent.stop());
    writeFileSync(join(t.secrets, 'claude-token'), TOKEN);
    const sock = join(tmp.dir, 'orch.sock');
    const [a, b] = await Promise.all([
      sendControl(sock, { cmd: 'claude.check', reason: 'doctor' }, 5_000),
      sendControl(sock, { cmd: 'claude.check' }, 5_000),
    ]);
    expect(a.ok && a.claudeAuth).toMatchObject({ valid: false, errorClass: 'unauthorized' });
    expect(b.ok && b.claudeAuth).toMatchObject({ valid: false, errorClass: 'unauthorized' });
    expect(t.runs()).toBe(1);
    expect(t.agent.status().claudeAuthValid).toBe(false);
  });
});

describe('orch doctor', () => {
  let server: ControlServer | undefined;
  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  function cfg(): CliConfig {
    const secrets = join(tmp.dir, 'secrets');
    mkdirSync(secrets, { recursive: true });
    return {
      socketPath: join(tmp.dir, 'orch.sock'),
      secretsDir: secrets,
      dataDir: join(tmp.dir, 'data'),
      claudeBin: '/opt/orch/bin/claude',
      defaultImage: 'node:22-bookworm',
    };
  }
  function deps(local?: ClaudeAuthPayload): CliDeps {
    return {
      spawnInteractive: async () => 0,
      sleep: async () => undefined,
      takeWaitMs: 0,
      updateWaitMs: 0,
      runner: { run: async () => ({ code: 0, stdout: '2.1.0 (Claude Code)\n', stderr: '' }) },
      localCheck: async () => {
        if (!local) throw new Error('local check not expected');
        return { payload: local, tokenHash: null };
      },
    };
  }
  async function daemon(p: ClaudeAuthPayload, path: string) {
    server = await startControlServer(
      path,
      { 'claude.check': () => ({ claudeAuth: p }) },
      silentLogger,
    );
  }

  it('prints the verified line via the daemon and exits 0', async () => {
    const c = cfg();
    writeFileSync(join(c.secretsDir, 'claude-token'), TOKEN);
    await daemon({ valid: true, checkedAt: new Date().toISOString() }, c.socketPath);
    const lines: string[] = [];
    expect(await doctor(c, deps(), (s) => lines.push(s))).toBe(0);
    const text = lines.join('\n');
    expect(text).toContain('Claude binary:  /opt/orch/bin/claude (2.1.0 (Claude Code))');
    expect(text).toContain('Token:          present');
    expect(text).toContain('Token shape:    ok (107 chars, sk-ant-oat prefix)');
    expect(text).toContain('✓ Claude login verified');
    expect(text).not.toContain('FAKE');
  });

  it('prints the 401 line and exits 1; other classes print the inconclusive line', async () => {
    const c = cfg();
    writeFileSync(join(c.secretsDir, 'claude-token'), 'sk-ant-oat01-short');
    await daemon(
      { valid: false, checkedAt: new Date().toISOString(), errorClass: 'unauthorized' },
      c.socketPath,
    );
    const lines: string[] = [];
    expect(await doctor(c, deps(), (s) => lines.push(s))).toBe(1);
    expect(lines.join('\n')).toContain('Token shape:    unexpected: too short');
    expect(lines.at(-1)).toBe('✗ Claude rejected this token (401). Run `orch login` again.');
    expect(
      checkLine({
        valid: false,
        checkedAt: new Date().toISOString(),
        errorClass: 'network',
        detail: 'ENOTFOUND',
      }),
    ).toBe('? Could not verify the Claude login (network): ENOTFOUND');
  });

  it('falls back to an in-process check when the daemon is unreachable', async () => {
    const c = cfg();
    const lines: string[] = [];
    const code = await doctor(
      c,
      deps({
        valid: false,
        checkedAt: new Date().toISOString(),
        errorClass: 'timeout',
        detail: 't',
      }),
      (s) => lines.push(s),
    );
    expect(code).toBe(1);
    expect(lines.join('\n')).toContain('Token:          missing');
    expect(lines.join('\n')).toContain('not reported to the server');
    expect(lines.at(-1)).toBe('? Could not verify the Claude login (timeout): t');
  });

  it('is wired as `orch doctor`', async () => {
    const c = cfg();
    await daemon({ valid: true, checkedAt: new Date().toISOString() }, c.socketPath);
    const out: string[] = [];
    const sink = { write: (s: string) => (out.push(s), true) } as unknown as NodeJS.WritableStream;
    const code = await runCli(
      ['doctor'],
      { stdin: process.stdin, stdout: sink, stderr: sink } as never,
      { ORCH_SOCKET_PATH: c.socketPath, ORCH_SECRETS_DIR: c.secretsDir },
      deps(),
    );
    expect(code).toBe(0);
    expect(out.join('')).toContain('✓ Claude login verified');
  });
});

describe('in-process check binary resolution', () => {
  it('resolves a bare ORCH_CLAUDE_BIN on PATH, and reports a clear message when missing', async () => {
    const bin = join(tmp.dir, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'claude'), '#!/bin/sh\n');
    chmodSync(join(bin, 'claude'), 0o755);
    writeFileSync(join(bin, 'notexec'), '');
    expect(resolveExecutable('claude', `/nonexistent:${bin}`)).toBe(join(bin, 'claude'));
    expect(resolveExecutable('notexec', bin)).toBeNull();
    expect(resolveExecutable(join(bin, 'claude'), '')).toBe(join(bin, 'claude'));
    expect(resolveExecutable('claude', '')).toBeNull();

    const out = await defaultLocalCheck(
      { claudeBin: 'claude', secretsDir: tmp.dir } as unknown as CliConfig,
      join(tmp.dir, 'empty'),
    );
    expect(out.payload).toMatchObject({ valid: false, errorClass: 'error' });
    expect(out.payload.detail).toContain('Set ORCH_CLAUDE_BIN to its absolute path');
  });
});
