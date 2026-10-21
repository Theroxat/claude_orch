import { afterEach, describe, expect, it } from 'vitest';
import { silentLogger } from '../src/log';
import { backoffCap } from '../src/ws/backoff';
import { WsClient } from '../src/ws/client';
import { FakeServer } from './helpers/fake-server';
import { CREDENTIAL, waitFor } from './helpers/util';

const hello = () => ({
  agentVersion: '0.0.0',
  capabilities: [],
  localPaused: false,
  maxConcurrent: 1,
  running: [],
});

let cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.reverse()) await c();
  cleanups = [];
});

function client(url: string, credential = CREDENTIAL, random = () => 0.999) {
  const c = new WsClient({
    url,
    credential,
    hello,
    logger: silentLogger,
    backoff: { baseMs: 20, maxMs: 160, random },
  });
  const delays: { attempt: number; delayMs: number }[] = [];
  c.on('reconnect', (r) => delays.push(r));
  cleanups.push(() => c.stop());
  return { c, delays };
}

async function server(port?: number) {
  const s = await new FakeServer({ credential: CREDENTIAL, port }).start();
  cleanups.push(() => s.stop());
  return s;
}

describe('WsClient', () => {
  it('sends hello with the Bearer header and becomes ready on welcome', async () => {
    const s = await server();
    const { c } = client(s.url);
    const welcomes: string[] = [];
    c.on('welcome', (w) => welcomes.push(w.agentId));
    c.start();
    await waitFor(() => c.ready, { what: 'ready' });
    expect(welcomes).toEqual(['agt_test']);
    expect(s.ofType('hello')).toHaveLength(1);
    expect(s.rejectedAuth).toBe(0);
  });

  it('reconnects with full-jitter backoff after the server dies, and resets after welcome', async () => {
    const s = await server();
    const port = s.port;
    const { c, delays } = client(s.url);
    c.start();
    await waitFor(() => c.ready);

    await s.stop();
    // Let a few failed attempts accumulate while the server is down.
    await waitFor(() => delays.length >= 4, { what: 'reconnect attempts' });
    for (const d of delays) {
      expect(d.delayMs).toBeGreaterThanOrEqual(0);
      expect(d.delayMs).toBeLessThanOrEqual(backoffCap(d.attempt, { baseMs: 20, maxMs: 160 }));
    }
    expect(delays.slice(0, 4).map((d) => d.attempt)).toEqual([0, 1, 2, 3]);

    const s2 = await server(port);
    await waitFor(() => s2.ofType('hello').length === 1 && c.ready, { what: 'reconnected' });

    // Backoff was reset by the welcome: the next drop starts again at attempt 0.
    const before = delays.length;
    s2.closeAll(4001, 'superseded');
    await waitFor(() => delays.length > before);
    expect(delays[before]?.attempt).toBe(0);
    await waitFor(() => c.ready && s2.connections === 2, { what: 'second reconnect' });
  });

  it('stops reconnecting after a fatal close (4003 revoked)', async () => {
    const s = await server();
    const { c, delays } = client(s.url);
    const fatal: number[] = [];
    c.on('fatal', (f) => fatal.push(f.code));
    c.start();
    await waitFor(() => c.ready);
    s.closeAll(4003, 'revoked');
    await waitFor(() => fatal.length === 1, { what: 'fatal' });
    await new Promise((r) => setTimeout(r, 300));
    expect(fatal).toEqual([4003]);
    expect(delays).toHaveLength(0);
    expect(s.connections).toBe(1);
    expect(c.currentState).toBe('fatal');
  });

  it('treats an HTTP 401 at upgrade as fatal', async () => {
    const s = await server();
    const { c, delays } = client(s.url, `orch_agent_agt_test.${'x'.repeat(40)}`);
    const fatal: number[] = [];
    c.on('fatal', (f) => fatal.push(f.code));
    c.start();
    await waitFor(() => fatal.length === 1);
    expect(fatal).toEqual([4401]);
    expect(delays).toHaveLength(0);
    expect(s.rejectedAuth).toBe(1);
  });

  it('reconnects after a 4008 close', async () => {
    const s = await server();
    const { c } = client(s.url);
    c.start();
    await waitFor(() => c.ready);
    s.closeAll(4008, 'heartbeat timeout');
    await waitFor(() => s.connections === 2 && c.ready);
  });
});
