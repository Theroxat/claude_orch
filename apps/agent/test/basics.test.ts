import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, toWsUrl } from '../src/config';
import { createLogger, redact } from '../src/log';
import { backoffCap, backoffDelay } from '../src/ws/backoff';
import { CREDENTIAL } from './helpers/util';

describe('backoff', () => {
  const o = { baseMs: 1000, maxMs: 60_000 };
  it('caps at min(max, base * 2^n)', () => {
    expect([0, 1, 2, 5, 6, 7, 100].map((n) => backoffCap(n, o))).toEqual([
      1000, 2000, 4000, 32_000, 60_000, 60_000, 60_000,
    ]);
  });
  it('uses full jitter in [0, cap)', () => {
    expect(backoffDelay(3, { ...o, random: () => 0 })).toBe(0);
    expect(backoffDelay(3, { ...o, random: () => 0.5 })).toBe(4000);
    for (let n = 0; n < 12; n++) {
      const d = backoffDelay(n, { ...o, random: Math.random });
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThanOrEqual(backoffCap(n, o));
    }
  });
});

describe('config', () => {
  it('parses defaults and derives URLs', () => {
    const c = loadConfig({
      ORCH_SERVER_URL: 'https://orch.example.com/',
      ORCH_AGENT_CREDENTIAL: '',
    });
    expect(c.wsUrl).toBe('wss://orch.example.com/agent/ws');
    expect(c.enrollUrl).toBe('https://orch.example.com/api/agents/enroll');
    expect(c.credential).toBeUndefined();
    expect(c.dataDir).toBe('/data');
    expect(c.socketPath).toBe('/run/orch.sock');
    expect(c.claudeUsageRoot).toBe('/host-claude');
    expect(c.plan).toBe('pro');
    expect(c.usageIntervalSec).toBe(300);
    expect(c.usageIntervalExplicit).toBe(false);
  });
  it('honours an explicit usage interval', () => {
    const c = loadConfig({ ORCH_SERVER_URL: 'http://caddy:80', ORCH_USAGE_INTERVAL_SEC: '60' });
    expect(c.usageIntervalExplicit).toBe(true);
    expect(c.usageIntervalSec).toBe(60);
    expect(c.wsUrl).toBe('ws://caddy/agent/ws');
  });
  it('fails fast with a readable error', () => {
    expect(() => loadConfig({ ORCH_PLAN: 'huge' })).toThrow(ConfigError);
    expect(() => loadConfig({})).toThrow(/ORCH_SERVER_URL: is required/);
    expect(() => loadConfig({ ORCH_SERVER_URL: 'ftp://x' })).toThrow(/http:\/\/ or https:\/\//);
  });
  it('strips credentials from the server URL', () => {
    expect(toWsUrl('https://u:p@h.example/base')).toBe('wss://h.example/base/agent/ws');
  });
});

describe('logger', () => {
  it('redacts credentials and Claude tokens', () => {
    const lines: string[] = [];
    const log = createLogger('debug', (l) => lines.push(l));
    log.info(`cred ${CREDENTIAL}`, { token: 'sk-ant-oat01-abcdefABCDEF_123' });
    expect(lines.join('')).not.toContain('S3cr3t');
    expect(lines.join('')).not.toContain('sk-ant-oat01');
    expect(redact('x sk-ant-api03-zzz y')).toBe('x [REDACTED] y');
  });
});
