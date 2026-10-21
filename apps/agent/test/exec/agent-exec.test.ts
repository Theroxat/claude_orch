/** Agent-level wiring: control socket -> executor -> WSS (claim, offer, tokens, list, cleanup). */
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { serverMessage } from '@orch/shared';
import { Agent } from '../../src/agent';
import { runCli } from '../../src/cli/run';
import { silentLogger } from '../../src/log';
import { FakeServer } from '../helpers/fake-server';
import { CREDENTIAL, tempDir, waitFor } from '../helpers/util';
import { FakeDocker, FakeGit, FakeScreen, offer, recordingFs } from './fakes';

const GH_TOKEN = 'ghs_' + 'Wire1'.repeat(8);
const CLAUDE_TOKEN = 'sk-ant-oat01-' + 'Qq7'.repeat(20);

let tmp: ReturnType<typeof tempDir>;
let cleanups: (() => Promise<void>)[] = [];
beforeEach(() => (tmp = tempDir()));
afterEach(async () => {
  for (const c of cleanups.reverse()) await c();
  cleanups = [];
  tmp.cleanup();
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
  stdin.end();
  return { io: { stdin, stdout: sink(out), stderr: sink(err) }, out, err };
}

describe('Agent with the manual executor', () => {
  it('lists, takes, pushes and cleans up through the server protocol', async () => {
    const server = await new FakeServer({
      credential: CREDENTIAL,
      config: {
        participations: [
          {
            projectId: 'prj_1',
            fullName: 'acme/widgets',
            percent: 50,
            mode: 'APPROVAL',
            allowedModels: ['SONNET'],
          },
        ],
      },
    }).start();
    cleanups.push(() => server.stop());
    server.onFrame = (msg) => {
      if (msg.type === 'tasks.list.request') {
        server.send(
          serverMessage(
            'tasks.list',
            {
              tasks: [
                {
                  taskId: 'tsk_1',
                  projectFullName: 'acme/widgets',
                  issueNumber: 42,
                  title: 'Add a dark mode toggle',
                  size: 'S',
                  model: 'SONNET',
                  createdBy: { login: 'alice' },
                },
              ],
            },
            { replyTo: msg.id },
          ),
        );
      } else if (msg.type === 'task.claim') {
        server.send(serverMessage('task.offer', offer(), { replyTo: msg.id }));
      } else if (msg.type === 'token.request') {
        const p = msg.payload as { requestId: string; purpose: string };
        server.send(
          serverMessage('token.grant', {
            requestId: p.requestId,
            token: GH_TOKEN,
            expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
            repository: 'acme/widgets',
            permissions: { contents: p.purpose === 'push' ? 'write' : 'read' },
          }),
        );
      }
    };
    const git = new FakeGit();
    const docker = new FakeDocker();
    const fs = recordingFs();
    const socketPath = join(tmp.dir, 'orch.sock');
    const agent = new Agent({
      serverUrl: 'http://127.0.0.1',
      wsUrl: server.url,
      credential: CREDENTIAL,
      agentId: 'agt_test',
      dataDir: join(tmp.dir, 'data'),
      socketPath,
      usageIntervalSec: 3600,
      usageIntervalExplicit: true,
      usageSource: {
        estimateUsage: async () => {
          throw new Error('unused');
        },
      },
      logger: silentLogger,
      backoff: { baseMs: 20, maxMs: 50 },
      exec: {
        config: {
          workDir: join(tmp.dir, 'work'),
          dataDir: join(tmp.dir, 'data'),
          maxConcurrent: 1,
          gitBaseUrl: 'https://github.com',
          defaultImage: 'node:22-bookworm',
          claudeBin: '/opt/orch/bin/claude',
          uid: process.getuid?.() || 1000,
          gid: process.getgid?.() || 1000,
          identity: { name: 'orch', email: 'orch@example.com' },
        },
        deps: { git, docker, screen: new FakeScreen(), fs, readClaudeToken: () => CLAUDE_TOKEN },
      },
    });
    cleanups.push(() => agent.stop());
    await agent.start();
    await waitFor(() => agent.client.ready, { what: 'welcome' });
    const hello = server.ofType('hello')[0]!.payload;
    expect(hello).toMatchObject({ capabilities: ['manual', 'devcontainer'], maxConcurrent: 1 });

    const env = { ORCH_SOCKET_PATH: socketPath };
    const l = io();
    expect(await runCli(['list'], l.io, env)).toBe(0);
    expect(l.out.join('')).toContain('acme/widgets#42  [S, sonnet]  Add a dark mode toggle');

    const t = io();
    expect(await runCli(['take', '42'], t.io, env, { sleep: async () => undefined })).toBe(0);
    const text = t.out.join('');
    expect(text).toContain('Claimed acme/widgets#42');
    expect(text).toContain('docker compose -f ~/orch/compose.yaml exec agent screen -r issue-42');
    expect(server.ofType('offer.accept')[0]?.payload).toEqual({
      assignmentId: 'asg_1',
      execMode: 'MANUAL',
    });

    const s = io();
    expect(await runCli(['status'], s.io, env)).toBe(0);
    expect(s.out.join('')).toContain('#42 Add a dark mode toggle!  [running]');

    const d = io();
    expect(await runCli(['done', '42'], d.io, env)).toBe(0);
    await waitFor(() => server.ofType('task.finished').length === 1, { what: 'task.finished' });
    expect(server.ofType('token.request').map((m) => m.payload.purpose)).toEqual(['clone', 'push']);
    expect(server.ofType('task.pushed')[0]?.payload.branch).toBe(
      'orch/issue-42-add-a-dark-mode-toggle',
    );
    // No GitHub or Claude token ever goes back to the server.
    for (const f of server.frames) {
      expect(f.raw).not.toContain(GH_TOKEN);
      expect(f.raw).not.toContain(CLAUDE_TOKEN);
    }

    server.send(serverMessage('cleanup', { assignmentId: 'asg_1' }));
    await waitFor(() => fs.removed.length === 1, { what: 'cleanup' });
    await waitFor(() => agent.executor?.store.get('asg_1') === undefined, {
      what: 'record removed',
    });

    // Paused: take is refused locally.
    agent.setPaused(true);
    const p = io();
    expect(await runCli(['take', '43'], p.io, env)).toBe(1);
    expect(p.err.join('')).toContain('paused');
  });
});
