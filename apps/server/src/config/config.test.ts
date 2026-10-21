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
