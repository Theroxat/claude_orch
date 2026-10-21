import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { me, mockApi, renderApp } from '../test/helpers';

const agent = (over: Record<string, unknown>) => ({
  id: 'a1',
  machineName: 'laptop',
  version: '0.2.0',
  connected: true,
  lastSeenAt: null,
  lastUsage: null,
  paused: false,
  revokedAt: null,
  ...over,
});

describe('Pool', () => {
  it('warns about machines whose Claude login expired', async () => {
    mockApi({
      'GET /me': () => ({ json: me }),
      'GET /projects/mine': () => ({ json: [] }),
      'GET /projects/discover': () => ({ json: [] }),
      'GET /pool': () => ({ json: { members: [] } }),
      'GET /agents/mine': () => ({
        json: [
          agent({ claudeAuthValid: false }),
          agent({
            id: 'a2',
            machineName: 'old',
            claudeAuthValid: false,
            revokedAt: '2026-01-01T00:00:00Z',
          }),
          agent({ id: 'a3', machineName: 'fine', claudeAuthValid: true }),
        ],
      }),
    });
    renderApp('/pool');
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Claude login expired on laptop: run orch login.');
    expect(alert.textContent).toContain('No task is offered to that machine until then.');
    expect(screen.getAllByRole('alert')).toHaveLength(1);
  });
});
