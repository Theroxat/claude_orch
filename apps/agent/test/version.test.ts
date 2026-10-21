import { describe, expect, it } from 'vitest';
import { AGENT_VERSION } from '../src/version';

describe('agent version', () => {
  it('exposes a semver version or "dev"', () => {
    expect(AGENT_VERSION).toMatch(/^(\d+\.\d+\.\d+.*|dev)$/);
  });
});
