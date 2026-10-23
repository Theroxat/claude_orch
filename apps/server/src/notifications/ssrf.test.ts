import { EventEmitter } from 'node:events';
import type { RequestOptions } from 'node:https';
import { describe, expect, it, vi } from 'vitest';

const calls: RequestOptions[] = [];
vi.mock('node:https', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:https')>();
  return {
    ...actual,
    request: vi.fn((_u: URL, opts: RequestOptions, cb: (res: unknown) => void) => {
      calls.push(opts);
      const req = Object.assign(new EventEmitter(), {
        end: () => {
          const res = Object.assign(new EventEmitter(), { statusCode: 204, resume: () => {} });
          cb(res);
        },
        destroy: () => {},
      });
      return req;
    }),
  };
});

const { safePost } = await import('./ssrf');
const https = await import('node:https');

describe('safePost', () => {
  it('uses its own agent (never the proxy-aware global one), a guarded lookup and a deadline', async () => {
    expect(await safePost('https://hooks.example.com/x', { a: 1 })).toEqual({
      ok: true,
      status: 204,
    });
    const opts = calls[0]!;
    expect(opts.agent).toBeInstanceOf(https.Agent);
    expect(opts.agent).not.toBe(https.globalAgent);
    expect(typeof opts.lookup).toBe('function');
    expect(opts.signal).toBeInstanceOf(AbortSignal);
  });

  it('refuses a private target before any request', () => {
    calls.length = 0;
    expect(() => safePost('https://[::127.0.0.1]/x', {})).toThrow();
    expect(calls).toHaveLength(0);
  });
});
