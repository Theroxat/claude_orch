import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentMessage } from '@orch/shared';
import { InboundDedup } from '../src/dedup';
import { Outbox } from '../src/outbox';
import { sleep, tempDir, waitFor } from './helpers/util';

let tmp: ReturnType<typeof tempDir>;
beforeEach(() => {
  tmp = tempDir();
});
afterEach(() => tmp.cleanup());

describe('Outbox', () => {
  it('persists before sending, survives a restart, keeps ids and seq order', () => {
    const file = join(tmp.dir, 'outbox.json');
    const a = new Outbox(file);
    const e1 = a.enqueue('pause.set', { paused: true });
    const e2 = a.enqueue('pause.set', { paused: false });
    expect(e2.seq).toBe(e1.seq + 1);
    expect(statSync(file).mode & 0o777).toBe(0o600);

    const b = new Outbox(file);
    expect(b.pending().map((e) => e.id)).toEqual([e1.id, e2.id]);
    const e3 = b.enqueue('pause.set', { paused: true });
    expect(e3.seq).toBe(e2.seq + 1);

    const sent: AgentMessage[] = [];
    b.setSender((m) => (sent.push(m), true));
    b.setOnline(true);
    expect(sent.map((m) => [m.id, m.seq])).toEqual([
      [e1.id, e1.seq],
      [e2.id, e2.seq],
      [e3.id, e3.seq],
    ]);
    b.ack(e1.id);
    b.close();
    expect(new Outbox(file).pending().map((e) => e.id)).toEqual([e2.id, e3.id]);
  });

  it('resends an unacked entry with the same id after the retry timeout', async () => {
    const box = new Outbox(join(tmp.dir, 'o.json'), { retryMs: 60 });
    const sent: string[] = [];
    box.setSender((m) => (sent.push(m.id), true));
    box.setOnline(true);
    const e = box.enqueue('pause.set', { paused: true });
    await waitFor(() => sent.length >= 2);
    expect(new Set(sent)).toEqual(new Set([e.id]));
    box.ack(e.id);
    const n = sent.length;
    await sleep(150);
    expect(sent.length).toBe(n);
    box.close();
  });

  it('coalesces entries of the same type when asked', () => {
    const box = new Outbox(join(tmp.dir, 'o.json'));
    box.enqueue('pause.set', { paused: true });
    const p = { estimate: true as const, windowStart: null, windowResetAt: null, weighted: 0 };
    const usage = {
      ...p,
      tokens: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 },
      byModel: {},
      byProject: {},
      capacityEstimate: null,
      source: 'jsonl' as const,
    };
    box.enqueue('usage.report', usage, { replaceSameType: true });
    const last = box.enqueue('usage.report', usage, { replaceSameType: true });
    expect(box.pending().map((e) => e.type)).toEqual(['pause.set', 'usage.report']);
    expect(box.pending()[1]?.id).toBe(last.id);
  });

  it('moves a corrupt file aside instead of crashing', () => {
    const file = join(tmp.dir, 'o.json');
    writeFileSync(file, '{not json');
    expect(new Outbox(file).pending()).toEqual([]);
  });
});

describe('InboundDedup', () => {
  it('is persisted and bounded', () => {
    const file = join(tmp.dir, 'ids.json');
    const d = new InboundDedup(file, 3);
    for (const id of ['a', 'b', 'c', 'd']) d.remember(id);
    expect(d.size).toBe(3);
    expect(d.has('a')).toBe(false);
    const d2 = new InboundDedup(file, 3);
    expect(['b', 'c', 'd'].every((id) => d2.has(id))).toBe(true);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toHaveLength(3);
  });

  it('expires ids after the ttl', () => {
    const d = new InboundDedup(join(tmp.dir, 'ids.json'), 10, 1000);
    d.remember('old', Date.now() - 2000);
    d.remember('new');
    expect(d.has('old')).toBe(false);
    expect(d.has('new')).toBe(true);
  });
});
