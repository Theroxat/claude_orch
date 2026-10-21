import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockApi, me, renderApp } from '../test/helpers';

const agent = (over: Record<string, unknown> = {}) => ({
  id: 'a1',
  machineName: 'laptop',
  version: '0.2.0',
  connected: true,
  lastSeenAt: new Date(Date.now() - 5 * 60_000).toISOString(),
  lastUsage: {
    estimate: true,
    reportedAt: new Date().toISOString(),
    windowStart: '2026-10-21T08:00:00Z',
    windowResetAt: '2026-10-21T13:00:00Z',
    weighted: 12345,
    capacityEstimate: 100000,
    usedFraction: 0.4,
    rateLimitedUntil: null,
  },
  paused: false,
  revokedAt: null,
  ...over,
});

afterEach(() => vi.useRealTimers());

describe('My server', () => {
  it('generates the install command, copies it and shows the expiry', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const cmd = 'curl -fsSL http://x/install.sh | ORCH_TOKEN=tok123 sh';
    mockApi({
      'GET /me': () => ({ json: me }),
      'GET /agents/mine': () => ({ json: [] }),
      'POST /agents/enrollment-tokens': () => ({
        status: 201,
        json: {
          token: 'tok123',
          expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
          installCommand: cmd,
        },
      }),
    });
    renderApp('/my-server');
    expect(await screen.findByText(/orch status/)).toBeTruthy();
    expect(screen.queryByText(/docker compose/)).toBeNull();
    fireEvent.click(await screen.findByRole('button', { name: 'Generate install command' }));
    expect((await screen.findByTestId('install-command')).textContent).toBe(cmd);
    expect(screen.getByText(/Shown once/)).toBeTruthy();
    expect(screen.getByText(/connects your Claude account, and adds the/)).toBeTruthy();
    expect(screen.getAllByTestId('install-command')).toHaveLength(1);
    expect(screen.getByRole('timer').textContent).toMatch(/Expires in 1[45]:\d\d/);
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(cmd));
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeTruthy();
  });

  it('shows an expired state once the countdown ends', async () => {
    mockApi({
      'GET /me': () => ({ json: me }),
      'GET /agents/mine': () => ({ json: [] }),
      'POST /agents/enrollment-tokens': () => ({
        status: 201,
        json: {
          token: 't',
          expiresAt: new Date(Date.now() + 1500).toISOString(),
          installCommand: 'curl x | ORCH_TOKEN=t sh',
        },
      }),
    });
    renderApp('/my-server');
    fireEvent.click(await screen.findByRole('button', { name: 'Generate install command' }));
    expect((await screen.findByRole('timer')).textContent).toMatch(/Expires in 0:0/);
    await waitFor(() => expect(screen.getByRole('timer').textContent).toMatch(/expired/), {
      timeout: 4000,
    });
  });

  it('shows the Claude login state reported by the agent', async () => {
    mockApi({
      'GET /me': () => ({ json: me }),
      'GET /agents/mine': () => ({
        json: [
          agent({ id: 'a1', machineName: 'laptop', claudeTokenPresent: true }),
          agent({ id: 'a2', machineName: 'desktop', claudeTokenPresent: false }),
        ],
      }),
    });
    renderApp('/my-server');
    const ok = await screen.findByRole('article', { name: 'laptop' });
    expect(within(ok).getByText('Claude: connected')).toBeTruthy();
    const todo = await screen.findByRole('article', { name: 'desktop' });
    expect(todo.textContent).toContain('Claude: not connected: run orch login');
  });

  it('lists machines with the usage estimate label', async () => {
    mockApi({
      'GET /me': () => ({ json: me }),
      'GET /agents/mine': () => ({
        json: [agent(), agent({ id: 'a2', machineName: 'nas', connected: false, lastUsage: null })],
      }),
    });
    renderApp('/my-server');
    const card = await screen.findByRole('article', { name: 'laptop' });
    expect(within(card).getByText('Online')).toBeTruthy();
    expect(within(card).getByText(/0\.2\.0/)).toBeTruthy();
    expect(within(card).getByText(/5 min ago/)).toBeTruthy();
    expect(within(card).getByText('Estimate')).toBeTruthy();
    expect(within(card).getByText(/12,345 tokens/)).toBeTruthy();
    expect(within(card).getByText(/margin ≈ 60%/)).toBeTruthy();
    expect(within(card).getByText(/resets at \d\d:\d\d/)).toBeTruthy();
    const nas = screen.getByRole('article', { name: 'nas' });
    expect(within(nas).getByText('Offline')).toBeTruthy();
  });

  it('polls /agents/mine every 15 seconds', async () => {
    const calls = mockApi({
      'GET /me': () => ({ json: me }),
      'GET /agents/mine': () => ({ json: [agent()] }),
    });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderApp('/my-server');
    await screen.findByRole('article', { name: 'laptop' });
    const count = () => calls.filter((c) => c.path === '/agents/mine').length;
    const before = count();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_100);
    });
    expect(count()).toBeGreaterThan(before);
  });

  it('pauses optimistically', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    let paused = false;
    const calls = mockApi({
      'GET /me': () => ({ json: me }),
      'GET /agents/mine': () => ({ json: [agent({ paused })] }),
      'POST /agents/a1/pause': () => {
        paused = true;
        return { json: agent({ paused: true }) };
      },
    });
    const orig = globalThis.fetch;
    vi.stubGlobal('fetch', async (i: RequestInfo | URL, init?: RequestInit) => {
      if (String(i).endsWith('/pause')) await gate;
      return orig(i, init);
    });
    renderApp('/my-server');
    fireEvent.click(await screen.findByRole('switch', { name: 'Pause laptop' }));
    expect(await screen.findByText(/Paused: no new tasks will start on this machine/)).toBeTruthy();
    expect(screen.getByRole('switch', { name: 'Pause laptop' })).toBeTruthy();
    release();
    await waitFor(() => expect(calls.some((c) => c.path === '/agents/a1/pause')).toBe(true));
    expect(screen.getByText(/Paused: no new tasks/)).toBeTruthy();
  });

  it('rolls back the pause on error', async () => {
    const calls = mockApi({
      'GET /me': () => ({ json: me }),
      'GET /agents/mine': () => ({ json: [agent()] }),
      'POST /agents/a1/pause': () => ({
        status: 500,
        json: { error: { code: 'boom', message: 'Server exploded' } },
      }),
    });
    renderApp('/my-server');
    fireEvent.click(await screen.findByRole('switch', { name: 'Pause laptop' }));
    expect(await screen.findByText('Server exploded')).toBeTruthy();
    await waitFor(() => expect(screen.queryByText(/Paused: no new tasks/)).toBeNull());
    expect(screen.getByRole('switch', { name: 'Pause laptop' })).toBeTruthy();
    expect(calls.some((c) => c.path === '/agents/a1/pause')).toBe(true);
  });

  it('revokes only after confirmation', async () => {
    let revoked = false;
    const calls = mockApi({
      'GET /me': () => ({ json: me }),
      'GET /agents/mine': () => ({ json: revoked ? [] : [agent()] }),
      'DELETE /agents/a1': () => {
        revoked = true;
        return { status: 204 };
      },
    });
    renderApp('/my-server');
    fireEvent.click(await screen.findByRole('button', { name: 'Revoke laptop' }));
    const dialog = await screen.findByRole('dialog', { name: 'Revoke machine' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Revoke laptop' }));
    fireEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Confirm revoke' }),
    );
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE')).toBe(true));
    await waitFor(() => expect(screen.queryByRole('article', { name: 'laptop' })).toBeNull());
  });
});
