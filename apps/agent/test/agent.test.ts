import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { serverMessage } from '@orch/shared';
import { Agent } from '../src/agent';
import { sendControl } from '../src/cli/client';
import { silentLogger } from '../src/log';
import type { UsageEstimate } from '../src/usage';
import { toUsageReport } from '../src/usage-loop';
import { FakeServer } from './helpers/fake-server';
import { CREDENTIAL, sleep, tempDir, waitFor } from './helpers/util';

const estimate: UsageEstimate = {
  estimate: true,
  source: 'claude-code-jsonl',
  now: Date.parse('2026-10-21T12:00:00Z'),
  window: {
    start: Date.parse('2026-10-21T10:00:00Z'),
    resetAt: Date.parse('2026-10-21T15:00:00Z'),
  },
  tokens: { input: 100, output: 50, cacheWrite: 10, cacheRead: 1000 },
  byModel: {
    'claude-sonnet-4-5': { input: 60, output: 30, cacheWrite: 10, cacheRead: 1000, weighted: 200 },
    'claude-opus-4-1': { input: 40, output: 20, cacheWrite: 0, cacheRead: 0, weighted: 300 },
  },
  weighted: 500,
  weekly: {
    since: 0,
    tokens: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 },
    weighted: 0,
    informationalOnly: true,
  },
  budget: {
    plan: 'pro',
    limitWeighted: 1000,
    safetyMargin: 0.2,
    usableWeighted: 800,
    remainingWeighted: 300,
    usedFraction: 0.625,
  },
  filesScanned: 2,
  linesSkipped: 0,
};

let tmp: ReturnType<typeof tempDir>;
let cleanups: (() => Promise<void>)[] = [];
beforeEach(() => {
  tmp = tempDir();
});
afterEach(async () => {
  for (const c of cleanups.reverse()) await c();
  cleanups = [];
  tmp.cleanup();
});

async function startServer(opts: { port?: number; autoAck?: boolean; heartbeatSec?: number } = {}) {
  const s = await new FakeServer({
    credential: CREDENTIAL,
    port: opts.port,
    autoAck: opts.autoAck,
    config: { heartbeatSec: opts.heartbeatSec ?? 30 },
  }).start();
  cleanups.push(() => s.stop());
  return s;
}

async function startAgent(
  url: string,
  extra: { usageIntervalSec?: number; usageFirstDelayMs?: number } = {},
) {
  let calls = 0;
  const agent = new Agent({
    serverUrl: 'http://127.0.0.1',
    wsUrl: url,
    credential: CREDENTIAL,
    agentId: 'agt_test',
    dataDir: join(tmp.dir, 'data'),
    socketPath: join(tmp.dir, 'orch.sock'),
    usageIntervalSec: extra.usageIntervalSec ?? 3600,
    usageIntervalExplicit: extra.usageIntervalSec !== undefined,
    usageSource: {
      estimateUsage: async () => {
        calls++;
        return estimate;
      },
    },
    logger: silentLogger,
    backoff: { baseMs: 20, maxMs: 100 },
    outboxRetryMs: 150,
    usageFirstDelayMs: extra.usageFirstDelayMs ?? 3_600_000,
  });
  await agent.start();
  cleanups.push(() => agent.stop());
  return { agent, usageCalls: () => calls };
}

describe('usage mapping', () => {
  it('maps an estimate to a usage.report payload', () => {
    expect(toUsageReport(estimate)).toEqual({
      estimate: true,
      windowStart: '2026-10-21T10:00:00.000Z',
      windowResetAt: '2026-10-21T15:00:00.000Z',
      tokens: { input: 100, output: 50, cacheWrite: 10, cacheRead: 1000 },
      weighted: 500,
      byModel: { 'claude-sonnet-4-5': 200, 'claude-opus-4-1': 300 },
      byProject: { personal: 500 },
      capacityEstimate: 800,
      source: 'jsonl',
    });
    expect(toUsageReport({ ...estimate, window: null }).windowStart).toBeNull();
  });
});

describe('Agent', () => {
  it('enqueues usage reports on the interval after the first welcome', async () => {
    const s = await startServer();
    const { agent, usageCalls } = await startAgent(s.url, {
      usageIntervalSec: 1,
      usageFirstDelayMs: 10,
    });
    await waitFor(() => s.ofType('usage.report').length >= 1, { what: 'first report' });
    expect(s.ofType('usage.report')[0]?.payload).toEqual(toUsageReport(estimate));
    await waitFor(() => usageCalls() >= 2, { timeoutMs: 3000, what: 'second report' });
    await waitFor(() => agent.outbox.pending().length === 0);
    expect(agent.status().lastUsageReportAt).not.toBeNull();
  });

  it('keeps the loop alive when the estimate fails', async () => {
    const s = await startServer();
    let n = 0;
    const agent = new Agent({
      serverUrl: 'http://x',
      wsUrl: s.url,
      credential: CREDENTIAL,
      agentId: null,
      dataDir: join(tmp.dir, 'd2'),
      socketPath: join(tmp.dir, 'o2.sock'),
      usageIntervalSec: 1,
      usageIntervalExplicit: true,
      usageSource: {
        estimateUsage: async () => {
          if (n++ === 0) throw new Error('boom');
          return estimate;
        },
      },
      logger: silentLogger,
      usageFirstDelayMs: 10,
    });
    await agent.start();
    cleanups.push(() => agent.stop());
    await waitFor(() => s.ofType('usage.report').length === 1, { timeoutMs: 3000 });
  });

  it('replays offline messages in seq order with the same ids, resends unacked ones, survives restart', async () => {
    const s = await startServer({ autoAck: false });
    const port = s.port;
    const first = await startAgent(s.url);
    await waitFor(() => first.agent.client.ready);
    await s.stop();
    await waitFor(() => !first.agent.client.ready);

    // Offline: pause/resume/pause go to the outbox.
    const ids = [true, false, true].map((p) => {
      first.agent.setPaused(p);
      return first.agent.outbox.pending().at(-1)!.id;
    });
    const persisted = JSON.parse(readFileSync(join(tmp.dir, 'data', 'outbox.json'), 'utf8'));
    expect(persisted.entries.map((e: { id: string }) => e.id)).toEqual(ids);

    // Restart the agent process (new instance on the same data dir) while offline.
    await first.agent.stop();
    const { agent } = await startAgent(`ws://127.0.0.1:${port}/agent/ws`);
    expect(agent.outbox.pending().map((e) => e.id)).toEqual(ids);

    const s2 = await startServer({ port, autoAck: false });
    await waitFor(() => s2.ofType('pause.set').length >= 3, { what: 'replay' });
    const replay = s2.ofType('pause.set').slice(0, 3);
    expect(replay.map((m) => m.id)).toEqual(ids);
    const seqs = replay.map((m) => m.seq ?? 0);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
    expect(replay.map((m) => m.payload.paused)).toEqual([true, false, true]);

    // Ack only the first one: the others are resent with the same ids.
    s2.send(serverMessage('ack', { ok: true }, { replyTo: ids[0]! }));
    await waitFor(() => s2.ofType('pause.set').length >= 5, { what: 'retry' });
    const resent = s2
      .ofType('pause.set')
      .slice(3)
      .map((m) => m.id);
    expect(resent.every((id) => id === ids[1] || id === ids[2])).toBe(true);
    expect(agent.outbox.pending().map((e) => e.id)).toEqual([ids[1], ids[2]]);

    s2.send(serverMessage('ack', { ok: true }, { replyTo: ids[1]! }));
    s2.send(serverMessage('ack', { ok: true, duplicate: true }, { replyTo: ids[2]! }));
    await waitFor(() => agent.outbox.pending().length === 0);
  });

  it('acks config.update, re-acks a duplicate id without re-applying it', async () => {
    const s = await startServer();
    const { agent } = await startAgent(s.url);
    await waitFor(() => agent.client.ready);
    const update = serverMessage('config.update', {
      heartbeatSec: 30,
      usageSec: 300,
      paused: true,
      participations: [],
    });
    s.send(update);
    await waitFor(() => s.ofType('ack').length === 1);
    expect(agent.isPaused()).toBe(true);

    agent.pause.set(false, 'local'); // a later local change must not be overwritten by the replay
    s.send(update);
    await waitFor(() => s.ofType('ack').length === 2);
    const acks = s.ofType('ack');
    expect(acks.map((a) => a.replyTo)).toEqual([update.id, update.id]);
    expect(acks[0]?.payload).toEqual({ ok: true });
    expect(acks[1]?.payload).toEqual({ ok: true, duplicate: true });
    expect(agent.isPaused()).toBe(false);
  });

  it('pauses via the control socket offline, persists it, and sends pause.set once online', async () => {
    const s = await startServer();
    const port = s.port;
    await s.stop();
    const { agent } = await startAgent(`ws://127.0.0.1:${port}/agent/ws`);
    const res = await sendControl(join(tmp.dir, 'orch.sock'), { cmd: 'pause' });
    expect(res.ok && res.status?.paused).toBe(true);
    expect(res.ok && res.status?.connected).toBe(false);
    const state = JSON.parse(readFileSync(join(tmp.dir, 'data', 'state.json'), 'utf8'));
    expect(state.paused).toBe(true);

    // The server still thinks "not paused": the pending local pause wins.
    const s2 = await startServer({ port });
    await waitFor(() => s2.ofType('pause.set').length === 1);
    expect(s2.ofType('pause.set')[0]?.payload).toEqual({ paused: true });
    expect(s2.ofType('hello')[0]?.payload.localPaused).toBe(true);
    await waitFor(() => agent.outbox.pending().length === 0);
    expect(agent.isPaused()).toBe(true);

    // Web pause/resume flips local state.
    s2.send(
      serverMessage('config.update', {
        heartbeatSec: 30,
        usageSec: 300,
        paused: false,
        participations: [],
      }),
    );
    await waitFor(() => !agent.isPaused());
  });

  it('never sends the credential or a Claude token over the socket', async () => {
    const s = await startServer({ heartbeatSec: 1 });
    const { agent } = await startAgent(s.url, { usageIntervalSec: 1, usageFirstDelayMs: 10 });
    await waitFor(() => agent.client.ready);
    agent.setPaused(true);
    agent.setPaused(false);
    await waitFor(() => s.ofType('heartbeat').length >= 1 && s.ofType('usage.report').length >= 1, {
      timeoutMs: 3000,
    });
    s.send(
      serverMessage('config.update', {
        heartbeatSec: 1,
        usageSec: 1,
        paused: true,
        participations: [],
      }),
    );
    await waitFor(() => s.ofType('ack').length >= 1);
    await sleep(50);
    const secret = CREDENTIAL.split('.')[1]!;
    expect(s.frames.length).toBeGreaterThan(4);
    for (const f of s.frames) {
      expect(f.raw).not.toContain(secret);
      expect(f.raw).not.toContain('orch_agent_');
      expect(f.raw).not.toMatch(/sk-ant-[A-Za-z0-9_-]+/);
    }
  });
});
