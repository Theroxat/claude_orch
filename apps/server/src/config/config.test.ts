import { describe, expect, it } from 'vitest';
import { loadConfig } from './index';

describe('loadConfig', () => {
  it('applies defaults', () => {
    const c = loadConfig({ DATABASE_URL: 'postgresql://x' });
    expect(c.PORT).toBe(3000);
    expect(c.GITHUB_APP_ID).toBeUndefined();
  });

  it('treats empty optional values as unset', () => {
    const c = loadConfig({ DATABASE_URL: 'postgresql://x', GITHUB_APP_ID: '' });
    expect(c.GITHUB_APP_ID).toBeUndefined();
  });

  it('applies the budget safety reserve once: the agent already did (no extra server reserve)', () => {
    expect(loadConfig({ DATABASE_URL: 'postgresql://x' }).BUDGET_SAFETY_RESERVE).toBe(0);
  });

  it('defaults the GitHub URLs to github.com and strips a trailing slash', () => {
    const c = loadConfig({ DATABASE_URL: 'postgresql://x' });
    expect(c.GITHUB_API_URL).toBe('https://api.github.com');
    expect(c.GITHUB_WEB_URL).toBe('https://github.com');
    const e = loadConfig({
      DATABASE_URL: 'postgresql://x',
      GITHUB_API_URL: 'http://fake-github:8080/',
      GITHUB_WEB_URL: '',
    });
    expect(e.GITHUB_API_URL).toBe('http://fake-github:8080');
    expect(e.GITHUB_WEB_URL).toBe('https://github.com');
  });

  it('fails fast without DATABASE_URL', () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
  });
});

describe('public URL and proxy trust', () => {
  const base = { DATABASE_URL: 'postgresql://x' };

  it('ORCH_PUBLIC_URL wins over ORCH_BASE_URL', () => {
    const c = loadConfig({
      ...base,
      ORCH_BASE_URL: 'http://orch:3000',
      ORCH_PUBLIC_URL: 'https://orch.selfhostr.io',
    });
    expect(c.ORCH_BASE_URL).toBe('https://orch.selfhostr.io');
  });

  it('an empty ORCH_PUBLIC_URL is ignored', () => {
    const c = loadConfig({ ...base, ORCH_BASE_URL: 'https://a.example', ORCH_PUBLIC_URL: '' });
    expect(c.ORCH_BASE_URL).toBe('https://a.example');
  });

  it('trusts private networks only by default', () => {
    expect(loadConfig(base).ORCH_TRUST_PROXY).toBe('loopback,linklocal,uniquelocal');
    expect(loadConfig({ ...base, ORCH_TRUST_PROXY: 'false' }).ORCH_TRUST_PROXY).toBe(false);
    expect(loadConfig({ ...base, ORCH_TRUST_PROXY: '10.0.0.0/8' }).ORCH_TRUST_PROXY).toBe(
      '10.0.0.0/8',
    );
  });
});

describe('agent update settings', () => {
  const base = { DATABASE_URL: 'postgresql://x' };

  it('normalises ORCH_VERSION and defaults the image repository', () => {
    expect(loadConfig(base).ORCH_VERSION).toBe('dev');
    expect(loadConfig({ ...base, ORCH_VERSION: ' v0.4.3 ' }).ORCH_VERSION).toBe('0.4.3');
    expect(loadConfig({ ...base, ORCH_VERSION: '' }).ORCH_VERSION).toBe('dev');
    expect(loadConfig(base).ORCH_AGENT_IMAGE_REPO).toBe('ghcr.io/theroxat/orch-agent');
  });

  it('rejects an invalid ORCH_AGENT_IMAGE_REPO', () => {
    for (const bad of ['evil/x:1', 'UPPER/case', 'nohost', 'a b/c', 'x/y@sha256:abc']) {
      expect(() => loadConfig({ ...base, ORCH_AGENT_IMAGE_REPO: bad })).toThrow(
        /ORCH_AGENT_IMAGE_REPO/,
      );
    }
    expect(
      loadConfig({ ...base, ORCH_AGENT_IMAGE_REPO: 'reg.example:5000/o/agent' }),
    ).toMatchObject({ ORCH_AGENT_IMAGE_REPO: 'reg.example:5000/o/agent' });
  });
});
