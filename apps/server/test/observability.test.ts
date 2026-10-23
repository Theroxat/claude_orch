import { afterAll, describe, expect, it } from 'vitest';
import { FakeGithub, api, loginAs, makeApp, prisma } from './harness';

const gh = new FakeGithub();
const TOKEN = 'a-metrics-token-of-16+chars';
const off = makeApp(gh);
const open = makeApp(gh, { env: { METRICS_ENABLED: 'true' } });
const guarded = makeApp(gh, { env: { METRICS_ENABLED: 'true', METRICS_TOKEN: TOKEN } });

afterAll(async () => {
  await Promise.all([off.close(), open.close(), guarded.close()]);
  await prisma.$disconnect();
});

describe('/metrics access', () => {
  it('is disabled by default (404)', async () => {
    const res = await off.inject({ method: 'GET', url: '/metrics' });
    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain('process_cpu');
  });

  it('serves the Prometheus text format when enabled', async () => {
    const res = await open.inject({ method: 'GET', url: '/metrics' });
    expect(res.statusCode).toBe(200);
    expect(String(res.headers['content-type'])).toContain('text/plain');
    expect(res.body).toContain('process_cpu_user_seconds_total');
    expect(res.body).toContain('nodejs_eventloop_lag_seconds');
  });

  it('requires the bearer token when METRICS_TOKEN is set', async () => {
    const none = await guarded.inject({ method: 'GET', url: '/metrics' });
    expect(none.statusCode).toBe(401);
    const wrong = await guarded.inject({
      method: 'GET',
      url: '/metrics',
      headers: { authorization: 'Bearer nope' },
    });
    expect(wrong.statusCode).toBe(401);
    const ok = await guarded.inject({
      method: 'GET',
      url: '/metrics',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(ok.statusCode).toBe(200);
  });

  it('refuses a METRICS_TOKEN shorter than 16 characters', () => {
    expect(() => makeApp(gh, { env: { METRICS_ENABLED: 'true', METRICS_TOKEN: 'short' } })).toThrow(
      /METRICS_TOKEN/,
    );
  });
});

describe('metric content', () => {
  it('exposes the domain metrics after a few requests', async () => {
    const user = await loginAs(open, gh);
    await api(open, user)('GET', '/api/me');
    await open.inject({ method: 'GET', url: '/healthz' });
    const res = await open.inject({ method: 'GET', url: '/metrics' });
    for (const name of [
      'orch_build_info',
      'orch_http_request_duration_seconds_bucket',
      'orch_agents_connected',
      'orch_tasks',
      'orch_dispatcher_tick_duration_seconds',
      'orch_offers_sent_total',
      'orch_offers_accepted_total',
      'orch_offers_refused_total',
      'orch_assignments_finished_total',
      'orch_ws_messages_total',
      'orch_webhook_deliveries_total',
    ]) {
      expect(res.body, name).toContain(`# TYPE ${name.replace(/_(bucket)$/, '')}`);
    }
    expect(res.body).toMatch(
      /orch_http_request_duration_seconds_count\{method="GET",route="\/healthz",status_class="2xx"\} 1/,
    );
    expect(res.body).toMatch(/orch_tasks\{status="TODO"\} \d+/);
  });

  it('labels by route template and status class, not by URL (bounded cardinality)', async () => {
    for (let i = 0; i < 25; i++) {
      await open.inject({ method: 'GET', url: `/api/tasks/id-${i}-${Math.random()}` });
      await open.inject({ method: 'GET', url: `/no/such/page/${i}?q=${i}` });
    }
    const body = (await open.inject({ method: 'GET', url: '/metrics' })).body;
    const lines = body
      .split('\n')
      .filter((l) => l.startsWith('orch_http_request_duration_seconds_count'));
    expect(lines.join('\n')).toContain('route="/api/tasks/:id"');
    expect(lines.join('\n')).toContain('route="unmatched"');
    expect(body).not.toMatch(/route="[^"]*id-\d/);
    expect(body).not.toContain('/no/such/page');
    expect(lines.length).toBeLessThan(15);
    expect(body).toMatch(/status_class="4xx"/);
    expect(body).not.toMatch(/status_class="(401|404)"/);
  });
});

describe('health probes', () => {
  it('/healthz is liveness and /readyz checks the database', async () => {
    const live = await open.inject({ method: 'GET', url: '/healthz' });
    expect(live.statusCode).toBe(200);
    const ready = await open.inject({ method: 'GET', url: '/readyz' });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toEqual({ status: 'ready' });
  });

  it('/readyz answers 503 when the database is unreachable', async () => {
    const broken = { ...prisma, $queryRaw: () => Promise.reject(new Error('db down')) };
    // An app whose prisma queries fail.
    const { buildApp } = await import('../src/app');
    const { loadConfig } = await import('../src/config');
    const app = buildApp({
      config: loadConfig({
        DATABASE_URL: process.env.DATABASE_URL_TEST ?? '',
        LOG_LEVEL: 'silent',
        DISPATCHER_ENABLED: 'false',
      }),
      prisma: broken as unknown as typeof prisma,
    });
    const res = await app.inject({ method: 'GET', url: '/readyz' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: 'unavailable' });
    await app.close();
  });
});
