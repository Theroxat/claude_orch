import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { mockApi, me, renderApp } from '../test/helpers';

const view = (over: Record<string, unknown> = {}) => ({
  id: 'k1',
  name: 'laptop',
  prefix: 'orch_pat_AbCd',
  scopes: ['mcp'],
  createdAt: new Date(Date.now() - 3600_000).toISOString(),
  lastUsedAt: null,
  expiresAt: null,
  revokedAt: null,
  ...over,
});

const cmdOAuth = 'claude mcp add --transport http --scope user orch http://x/mcp';
const setupRoute = {
  'GET /mcp/setup': () => ({ json: { mcpUrl: 'http://x/mcp', mcpAddCommandOAuth: cmdOAuth } }),
  'GET /oauth/grants': () => ({ json: [] }),
};

describe('Claude Code page', () => {
  it('shows the OAuth command and copies it', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    mockApi({
      'GET /me': () => ({ json: me }),
      'GET /offers/mine': () => ({ json: [] }),
      ...setupRoute,
      'GET /tokens': () => ({ json: [] }),
      ...setupRoute,
    });
    renderApp('/claude-code');
    expect((await screen.findByTestId('mcp-oauth-command')).textContent).toBe(cmdOAuth);
    expect(await screen.findByText('No connected app yet.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Copy command' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(cmdOAuth));
    expect(await screen.findByRole('button', { name: 'Command copied' })).toBeTruthy();
  });

  it('lists a connected app and revokes it after confirmation', async () => {
    let revoked = false;
    const calls = mockApi({
      'GET /me': () => ({ json: me }),
      'GET /offers/mine': () => ({ json: [] }),
      ...setupRoute,
      'GET /tokens': () => ({ json: [] }),
      ...setupRoute,
      'GET /oauth/grants': () => ({
        json: revoked
          ? []
          : [
              {
                id: 'g1',
                clientName: 'Claude Code',
                redirectHost: 'localhost',
                createdAt: new Date(Date.now() - 3600_000).toISOString(),
                lastUsedAt: null,
              },
            ],
      }),
      'DELETE /oauth/grants/g1': () => {
        revoked = true;
        return { status: 204 };
      },
    });
    renderApp('/claude-code');
    const row = await screen.findByRole('article', { name: 'App Claude Code' });
    expect(within(row).getByText('localhost')).toBeTruthy();
    expect(within(row).getByText(/Last used never/)).toBeTruthy();
    fireEvent.click(within(row).getByRole('button', { name: 'Revoke' }));
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
    fireEvent.click(
      within(await screen.findByRole('dialog', { name: 'Revoke access' })).getByRole('button', {
        name: 'Confirm revoke',
      }),
    );
    await waitFor(() => expect(calls.some((c) => c.path === '/oauth/grants/g1')).toBe(true));
    expect(await screen.findByText('No connected app yet.')).toBeTruthy();
  });

  it('creates a token, shows the command once and copies it', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const cmd = 'claude mcp add --transport http --scope user orch http://x/mcp';
    let listed = false;
    const calls = mockApi({
      'GET /me': () => ({ json: me }),
      'GET /offers/mine': () => ({ json: [] }),
      ...setupRoute,
      'GET /tokens': () => ({ json: listed ? [view()] : [] }),
      'POST /tokens': () => {
        listed = true;
        return {
          status: 201,
          json: { ...view(), token: 'orch_pat_secret', mcpAddCommand: cmd },
        };
      },
    });
    renderApp('/claude-code');
    expect(await screen.findByText('No token yet.')).toBeTruthy();
    expect(screen.getByText('view_pool')).toBeTruthy();
    expect(screen.getByText('task_status')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Token name'), { target: { value: ' laptop ' } });
    fireEvent.change(screen.getByLabelText('Expires in days (optional)'), {
      target: { value: '30' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create token' }));
    expect((await screen.findByTestId('mcp-command')).textContent).toBe(cmd);
    expect(screen.getByText(/Shown once/)).toBeTruthy();
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({
      name: 'laptop',
      expiresInDays: 30,
    });
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(cmd));
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeTruthy();
    // The list never shows the token itself.
    const row = await screen.findByRole('article', { name: 'Token laptop' });
    expect(within(row).getByText(/orch_pat_AbCd/)).toBeTruthy();
    expect(screen.queryByText(/orch_pat_secret/)).toBeNull();
  });

  it('lists tokens and revokes after confirmation', async () => {
    let revoked = false;
    const calls = mockApi({
      'GET /me': () => ({ json: me }),
      'GET /offers/mine': () => ({ json: [] }),
      ...setupRoute,
      'GET /tokens': () => ({
        json: [
          view({ revokedAt: revoked ? new Date().toISOString() : null }),
          view({ id: 'k2', name: 'old', revokedAt: '2026-01-01T00:00:00Z' }),
        ],
      }),
      'DELETE /tokens/k1': () => {
        revoked = true;
        return { status: 204 };
      },
    });
    renderApp('/claude-code');
    const row = await screen.findByRole('article', { name: 'Token laptop' });
    expect(within(row).getByText('Active')).toBeTruthy();
    expect(within(row).getByText(/Last used never/)).toBeTruthy();
    const old = screen.getByRole('article', { name: 'Token old' });
    expect(within(old).getByText('Revoked')).toBeTruthy();
    expect(within(old).queryByRole('button', { name: 'Revoke' })).toBeNull();
    fireEvent.click(within(row).getByRole('button', { name: 'Revoke' }));
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
    fireEvent.click(
      within(await screen.findByRole('dialog', { name: 'Revoke token' })).getByRole('button', {
        name: 'Confirm revoke',
      }),
    );
    await waitFor(() => expect(calls.some((c) => c.path === '/tokens/k1')).toBe(true));
    await waitFor(() =>
      expect(
        within(screen.getByRole('article', { name: 'Token laptop' })).getByText('Revoked'),
      ).toBeTruthy(),
    );
  });
});
