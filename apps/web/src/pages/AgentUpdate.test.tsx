import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { mockApi, me, renderApp } from '../test/helpers';

const upd = (status: string, code: string | null = null, detail: string | null = null) => ({
  status,
  targetVersion: '0.4.3',
  code,
  detail,
  requestedAt: null,
  updatedAt: null,
});
const outdated = (over: Record<string, unknown> = {}) => ({
  id: 'a1',
  machineName: 'laptop',
  version: '0.4.1',
  connected: true,
  lastSeenAt: new Date().toISOString(),
  lastUsage: null,
  paused: false,
  revokedAt: null,
  latestAgentVersion: '0.4.3',
  updateAvailable: true,
  canSelfUpdate: true,
  update: null,
  ...over,
});
const routes = (list: { updateAvailable?: boolean }[], extra = {}) => ({
  'GET /me': () => ({ json: me }),
  'GET /agents/mine': () => ({ json: list }),
  'GET /agents/outdated-count': () => ({
    json: { count: list.filter((a) => a.updateAvailable).length },
  }),
  ...extra,
});

describe('Agent update', () => {
  it('shows the banner and the per-agent state, and hides without outdated agents', async () => {
    mockApi(routes([outdated()]));
    const { unmount } = renderApp('/my-server');
    expect(await screen.findByText(/is out of date/)).toBeTruthy();
    expect(screen.getByText(/v0\.4\.1 → v0\.4\.3/)).toBeTruthy();
    expect(screen.getByText('v0.4.1 · update available: v0.4.3')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: /^Update now/ })).toHaveLength(2);
    expect(screen.getByText('How to update manually')).toBeTruthy();
    expect(screen.getAllByText('orch update').length).toBeGreaterThan(0);
    unmount();
    mockApi(routes([outdated({ updateAvailable: false, version: '0.4.3' })]));
    renderApp('/my-server');
    expect(await screen.findByText('Up to date')).toBeTruthy();
    expect(screen.queryByText(/is out of date/)).toBeNull();
  });

  it('posts the update with whenIdle false', async () => {
    let current = outdated();
    const calls = mockApi({
      ...routes([outdated()]),
      'GET /agents/mine': () => ({ json: [current] }),
      'POST /agents/a1/update': () => {
        current = outdated({ update: upd('pending') });
        return { status: 202, json: current };
      },
    });
    renderApp('/my-server');
    const btns = await screen.findAllByRole('button', { name: 'Update now laptop' });
    fireEvent.click(btns[0]!);
    await waitFor(() =>
      expect(calls.find((c) => c.path === '/agents/a1/update')?.body).toEqual({ whenIdle: false }),
    );
    expect((await screen.findAllByText('Update requested')).length).toBeGreaterThan(0);
  });

  it('offers Update when idle after a busy failure', async () => {
    const failed = outdated({ update: upd('failed', 'busy', 'tasks running') });
    const calls = mockApi(
      routes([failed], { 'POST /agents/a1/update': () => ({ status: 202, json: failed }) }),
    );
    renderApp('/my-server');
    expect((await screen.findAllByText('Update failed: tasks running')).length).toBeGreaterThan(0);
    const idle = await screen.findAllByRole('button', { name: 'Update when idle laptop' });
    fireEvent.click(idle[0]!);
    await waitFor(() =>
      expect(calls.find((c) => c.path === '/agents/a1/update')?.body).toEqual({ whenIdle: true }),
    );
  });

  it('shows an API error inline', async () => {
    mockApi(
      routes([outdated()], {
        'POST /agents/a1/update': () => ({
          status: 409,
          json: { error: { code: 'agent_offline', message: 'Agent is offline' } },
        }),
      }),
    );
    renderApp('/my-server');
    fireEvent.click((await screen.findAllByRole('button', { name: 'Update now laptop' }))[0]!);
    expect((await screen.findAllByText('Agent is offline')).length).toBeGreaterThan(0);
  });

  it('shows deferred status, disables the button, and a manual note when unsupported', async () => {
    mockApi(routes([outdated({ update: upd('deferred') })]));
    const { unmount } = renderApp('/my-server');
    expect(
      (await screen.findAllByText('Waiting for running tasks to finish')).length,
    ).toBeGreaterThan(0);
    for (const b of screen.getAllByRole('button', { name: 'Update now laptop' })) {
      expect((b as HTMLButtonElement).disabled).toBe(true);
    }
    unmount();
    mockApi(routes([outdated({ canSelfUpdate: false })]));
    renderApp('/my-server');
    expect((await screen.findAllByText(/update it manually/)).length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: /^Update now/ })).toBeNull();
  });
});
