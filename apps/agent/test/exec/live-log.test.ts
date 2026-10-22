/** Live output: stream-json summaries, batching (time and size), back-pressure, redaction. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskLogPayload } from '@orch/shared';
import {
  LiveLogStreamer,
  entriesFromStreamLine,
  makeRedactor,
  toolArgs,
} from '../../src/exec/live-log';

const TOKEN = 'sk-ant-oat01-' + 'Zz9'.repeat(20);
const PLAIN_SECRET = 'not-a-pattern-but-secret-value';

function streamer(over: Partial<ConstructorParameters<typeof LiveLogStreamer>[0]> = {}) {
  const sent: TaskLogPayload[] = [];
  const s = new LiveLogStreamer({
    assignmentId: 'asg_1',
    send: (p) => (sent.push(p), true),
    redact: makeRedactor(() => [PLAIN_SECRET, null, 'short']),
    now: () => 1000,
    ...over,
  });
  return { s, sent };
}

const assistant = (content: unknown[]) =>
  JSON.stringify({ type: 'assistant', message: { content } });

describe('entriesFromStreamLine', () => {
  it('summarizes text, tool calls (name + short args), results and the final result', () => {
    expect(
      entriesFromStreamLine(
        assistant([
          { type: 'text', text: '  Looking at it.  ' },
          { type: 'tool_use', name: 'Bash', input: { command: 'pnpm   test\n--run' } },
          { type: 'tool_use', name: 'Edit', input: { file_path: 'src/a.ts', old_string: 'x' } },
          { type: 'tool_use', name: 'Grep', input: { pattern: 'foo', path: 'src' } },
          { type: 'thinking', thinking: 'hidden' },
        ]),
        5,
      ),
    ).toEqual([
      { ts: 5, kind: 'text', text: 'Looking at it.' },
      { ts: 5, kind: 'tool', tool: 'Bash', text: 'pnpm test --run' },
      { ts: 5, kind: 'tool', tool: 'Edit', text: 'src/a.ts' },
      { ts: 5, kind: 'tool', tool: 'Grep', text: 'foo in src' },
    ]);
    expect(
      entriesFromStreamLine(
        JSON.stringify({
          type: 'user',
          message: {
            content: [
              { type: 'tool_result', is_error: true, content: [{ type: 'text', text: 'boom' }] },
            ],
          },
        }),
        5,
      ),
    ).toEqual([{ ts: 5, kind: 'tool_result', text: 'boom', error: true }]);
    expect(
      entriesFromStreamLine(
        JSON.stringify({
          type: 'result',
          subtype: 'error_max_turns',
          num_turns: 9,
          result: 'gave up',
        }),
        5,
      ),
    ).toEqual([{ ts: 5, kind: 'result', text: 'error_max_turns, 9 turns: gave up', error: true }]);
    expect(entriesFromStreamLine('not json', 5)).toEqual([
      { ts: 5, kind: 'text', text: 'not json' },
    ]);
    expect(entriesFromStreamLine(JSON.stringify({ type: 'stream_event' }), 5)).toEqual([]);
  });

  it('shortens long arguments', () => {
    expect(toolArgs('Bash', { command: 'x'.repeat(1000) }).length).toBeLessThanOrEqual(240);
    expect(toolArgs('Custom', { a: 1 })).toBe('{"a":1}');
    expect(toolArgs('TodoWrite', { todos: [1, 2] })).toBe('2 todos');
  });
});

describe('LiveLogStreamer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('batches lines for 500 ms, then sends one task.log', () => {
    const { s, sent } = streamer();
    s.stdout(assistant([{ type: 'text', text: 'one' }]));
    s.stderr('two');
    vi.advanceTimersByTime(499);
    expect(sent).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(sent).toEqual([
      {
        assignmentId: 'asg_1',
        chunk: 1,
        entries: [
          { ts: 1000, kind: 'text', text: 'one' },
          { ts: 1000, kind: 'stderr', text: 'two' },
        ],
      },
    ]);
  });

  it('flushes at once when a batch reaches 32 KB, and splits big backlogs', () => {
    const { s, sent } = streamer();
    for (let i = 0; i < 20; i++) s.stderr('y'.repeat(3000));
    expect(sent.length).toBeGreaterThanOrEqual(1);
    for (const b of sent) {
      const bytes = b.entries.reduce((n, e) => n + e.text.length, 0);
      expect(bytes).toBeLessThanOrEqual(32 * 1024);
    }
    s.close();
    expect(sent.flatMap((b) => b.entries)).toHaveLength(20);
    expect(sent.map((b) => b.chunk)).toEqual(sent.map((_, i) => i + 1));
  });

  it('redacts known secret values and token patterns, strips ANSI, clips long text', () => {
    const { s, sent } = streamer();
    s.stderr(`\u001b[31m${PLAIN_SECRET} and ${TOKEN}\u001b[0m short`);
    s.stderr('z'.repeat(10_000));
    s.close();
    const [a, b] = sent[0]!.entries;
    expect(a!.text).toBe('[REDACTED] and [REDACTED] short');
    expect(b!.text.length).toBe(4000);
  });

  it('redacts before shortening: a token cut by the clip never leaks its first characters', () => {
    const { s, sent } = streamer();
    const gh = 'ghp_' + 'A1b2C3d4E5'.repeat(4);
    const argPad = 'x'.repeat(225); // tool args are clipped at 240: the token straddles the cut
    const resPad = 'y'.repeat(590); // tool results at 600
    s.stdout(
      assistant([
        { type: 'tool_use', name: 'Bash', input: { command: `${argPad} ${gh}` } },
        { type: 'tool_use', name: 'Bash', input: { command: `${argPad} ${PLAIN_SECRET}` } },
        { type: 'tool_result', content: `${resPad} ${gh}` },
      ]),
    );
    s.stdout(
      JSON.stringify({ type: 'result', subtype: 'success', result: `${'z'.repeat(1190)} ${gh}` }),
    );
    s.close();
    const texts = sent.flatMap((b) => b.entries.map((e) => e.text));
    expect(texts).toHaveLength(4);
    for (const t of texts) {
      expect(t).not.toContain('ghp_');
      expect(t).not.toContain('A1b2');
      expect(t).not.toContain('not-a-pattern');
    }
    expect(texts[0]).toContain('[REDACTED]');
  });

  it('counts what could not be sent and reports it with the next batch', () => {
    let online = false;
    const sent: TaskLogPayload[] = [];
    const { s } = streamer({ send: (p) => online && (sent.push(p), true) });
    s.stderr('lost 1');
    s.stderr('lost 2');
    vi.advanceTimersByTime(500);
    online = true;
    s.stderr('kept');
    vi.advanceTimersByTime(500);
    expect(sent).toEqual([
      {
        assignmentId: 'asg_1',
        chunk: 2,
        entries: [{ ts: 1000, kind: 'stderr', text: 'kept' }],
        dropped: 2,
      },
    ]);
  });

  it('bounds pending memory by dropping the oldest lines', () => {
    const sent: TaskLogPayload[] = [];
    const { s } = streamer({
      send: (p) => (sent.push(p), true),
      maxPendingBytes: 1000,
      batchBytes: 100_000,
    });
    for (let i = 0; i < 10; i++) s.stderr(`${i}`.repeat(300));
    s.close();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.dropped).toBeGreaterThan(0);
    expect(sent[0]!.entries.at(-1)!.text.startsWith('9')).toBe(true);
  });

  it('never throws: a throwing sender or redactor is reported once and the run goes on', () => {
    const errors: unknown[] = [];
    const { s } = streamer({
      send: () => {
        throw new Error('ws gone');
      },
      onError: (e) => errors.push(e),
    });
    expect(() => {
      s.stderr('a');
      vi.advanceTimersByTime(500);
      s.close();
    }).not.toThrow();
    expect(errors.length).toBeGreaterThan(0);

    const bad = streamer({
      redact: () => {
        throw new Error('bad regex');
      },
    });
    expect(() => bad.s.stdout('x')).not.toThrow();
  });

  it('close({ drop }) discards pending lines; nothing is accepted after close', () => {
    const { s, sent } = streamer();
    s.stderr('pending');
    s.close({ drop: true });
    s.stderr('late');
    vi.advanceTimersByTime(1000);
    expect(sent).toEqual([]);
    expect(s.isClosed).toBe(true);
  });
});
