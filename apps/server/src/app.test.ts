import { describe, expect, it } from 'vitest';
import { buildApp } from './app';
import { loadConfig } from './config';

describe('GET /healthz', () => {
  it('returns ok', async () => {
    const app = buildApp({
      config: loadConfig({ DATABASE_URL: 'postgresql://x', LOG_LEVEL: 'silent' }),
    });
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
    await app.close();
  });
});
