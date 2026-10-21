import { describe, expect, it } from 'vitest';
import { AGENT_VERSION } from './version';

describe('agent stub', () => {
  it('exposes a semver version', () => {
    expect(AGENT_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
