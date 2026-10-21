import { screen, within } from '@testing-library/react';
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

  it('names the 401 rejection and shows verified machines', async () => {
    mockApi({
      'GET /me': () => ({ json: me }),
      'GET /projects/mine': () => ({ json: [] }),
      'GET /projects/discover': () => ({ json: [] }),
      'GET /pool': () => ({ json: { members: [] } }),
      'GET /agents/mine': () => ({
        json: [
          agent({
            claudeAuthValid: false,
            claudeAuthError: 'unauthorized',
            claudeAuthCheckedAt: new Date().toISOString(),
          }),
          agent({
            id: 'a3',
            machineName: 'fine',
            claudeAuthValid: true,
            claudeAuthCheckedAt: new Date(Date.now() - 600_000).toISOString(),
          }),
        ],
      }),
    });
    renderApp('/pool');
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(
      'Claude rejected the token (401): run orch login on laptop',
    );
    expect(await screen.findByText(/fine: Claude login verified 10 min ago/)).toBeTruthy();
  });
});

describe('Pool member machines', () => {
  const member = (over: Record<string, unknown>) => ({
    userId: 'u2',
    login: 'bob',
    avatarUrl: null,
    online: true,
    paused: false,
    usageStale: false,
    resetAt: null,
    rateLimitedUntil: null,
    projects: [],
    runningTasks: [],
    ...over,
  });
  const base = {
    'GET /me': () => ({ json: me }),
    'GET /projects/mine': () => ({ json: [] }),
    'GET /projects/discover': () => ({ json: [] }),
    'GET /agents/mine': () => ({ json: [] }),
  };

  it('shows each machine and Paused when every online machine is paused', async () => {
    mockApi({
      ...base,
      'GET /pool': () => ({
        json: {
          estimate: true,
          members: [
            member({
              machines: [
                { name: 'laptop', online: true, paused: true },
                { name: 'desktop', online: false, paused: false },
              ],
            }),
          ],
        },
      }),
    });
    renderApp('/pool');
    const card = (await screen.findByText('bob')).closest('article')!;
    expect(card.textContent).toContain('laptop');
    expect(card.textContent).toContain('desktop');
    expect(within(card).getAllByText('Paused')).toHaveLength(2); // machine + member level
    expect(within(card).getAllByText('Offline').length).toBeGreaterThan(0);
  });

  it('no member-level Paused when an online machine is running', async () => {
    mockApi({
      ...base,
      'GET /pool': () => ({
        json: {
          estimate: true,
          members: [
            member({
              machines: [
                { name: 'laptop', online: true, paused: true },
                { name: 'desktop', online: true, paused: false },
              ],
            }),
          ],
        },
      }),
    });
    renderApp('/pool');
    const card = (await screen.findByText('bob')).closest('article')!;
    expect(within(card).getAllByText('Paused')).toHaveLength(1);
  });
});
