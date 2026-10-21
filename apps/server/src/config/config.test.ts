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

  it('fails fast without DATABASE_URL', () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
  });
});
