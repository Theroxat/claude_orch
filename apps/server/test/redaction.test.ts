/** Server-side redaction: live log batches (split secrets), log lines, error logs. */
import { describe, expect, it } from 'vitest';
import { LiveLogStore } from '../src/logs/store';
import { buildApp, redactingStream } from '../src/app';
import { loadConfig } from '../src/config';

const GH = 'ghp_' + 'A1b2C3d4E5'.repeat(4);

describe('live log store', () => {
  it('masks a token split between two batches, and secret formats inside entries', () => {
    const store = new LiveLogStore();
    store.start('asg_1', 'tsk_1', 'agt_1');
    store.append('asg_1', [{ ts: 1, kind: 'stderr', text: `push ${GH.slice(0, 18)}` }]);
    store.append('asg_1', [
      { ts: 2, kind: 'stderr', text: `${GH.slice(18)} rejected` },
      { ts: 3, kind: 'text', text: 'AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCY' },
    ]);
    const texts = store.snapshot('tsk_1', 0).lines.map((l) => l.text);
    expect(texts).toEqual([
      'push [REDACTED]',
      '[REDACTED] rejected',
      'AWS_SECRET_ACCESS_KEY=[REDACTED]',
    ]);
  });
});

describe('server logs', () => {
  it('redactingStream masks secret formats in every line', () => {
    const lines: string[] = [];
    const s = redactingStream({ write: (m: string) => lines.push(m) });
    s.write(`{"msg":"push failed","err":"https://x:${GH}@github.com/o/r"}\n`);
    expect(lines[0]).not.toContain(GH.slice(4, 20));
    expect(JSON.parse(lines[0]!)).toMatchObject({ msg: 'push failed' });
  });

  it('error logs of the app go through it', async () => {
    const lines: string[] = [];
    const app = buildApp({
      config: loadConfig({
        DATABASE_URL: 'postgresql://u:p@127.0.0.1:1/x',
        LOG_LEVEL: 'info',
        DISPATCHER_ENABLED: 'false',
      }),
      logStream: { write: (m: string) => void lines.push(m) },
    });
    app.log.error({ err: new Error(`clone failed with ${GH}`) }, 'boom');
    await app.close();
    const all = lines.join('');
    expect(all).toContain('boom');
    expect(all).not.toContain(GH.slice(4, 20));
  });
});
