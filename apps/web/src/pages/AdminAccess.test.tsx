import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockApi, me, renderApp } from '../test/helpers';

const grant = (over: Record<string, unknown> = {}) => ({
  id: 'g1',
  githubLogin: 'alice',
  githubUserId: null,
  avatarUrl: null,
  status: 'PENDING',
  note: 'let me in',
  requestedAt: '2026-10-20T10:00:00Z',
  decidedAt: null,
  decidedBy: null,
  ...over,
});
const access = {
  pending: [grant()],
  approved: [grant({ id: 'g2', githubLogin: 'bob', status: 'APPROVED', note: null })],
  denied: [],
  invites: [],
  configured: { logins: ['envuser'], orgs: ['acme'], admins: ['root'], allowAny: false },
};
const admin = { ...me, isAdmin: true };

afterEach(() => vi.restoreAllMocks());

describe('Admin access', () => {
  it('renders pending, members and configured sections', async () => {
    mockApi({
      'GET /me': () => ({ json: admin }),
      'GET /admin/access/pending-count': () => ({ json: { count: 1 } }),
      'GET /admin/access': () => ({ json: access }),
    });
    renderApp('/admin/access');
    expect(await screen.findByText('alice')).toBeTruthy();
    expect(screen.getByText('let me in')).toBeTruthy();
    expect(screen.getByText('bob')).toBeTruthy();
    expect(screen.getAllByText(/configured on the server/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/envuser/)).toBeTruthy();
    expect(screen.getByText(/acme/)).toBeTruthy();
  });

  it('avatar fallbacks load under the production CSP (img-src)', async () => {
    mockApi({
      'GET /me': () => ({ json: admin }),
      'GET /admin/access/pending-count': () => ({ json: { count: 1 } }),
      'GET /admin/access': () => ({ json: access }),
    });
    const { container } = renderApp('/admin/access');
    await screen.findByText('alice');
    // Tests run from apps/web.
    const caddy = readFileSync(resolve('../../deploy/server/routes.caddy'), 'utf8');
    const imgSrc = /img-src ([^;]+);/.exec(caddy)![1]!.split(' ');
    const imgs = [...container.querySelectorAll('img.avatar')] as HTMLImageElement[];
    expect(imgs.length).toBeGreaterThan(0);
    for (const img of imgs) {
      expect(imgSrc).toContain(new URL(img.src).origin);
    }
  });

  it('approves a pending request', async () => {
    const calls = mockApi({
      'GET /me': () => ({ json: admin }),
      'GET /admin/access/pending-count': () => ({ json: { count: 1 } }),
      'GET /admin/access': () => ({ json: access }),
      'POST /admin/access/grants/g1/approve': () => ({ json: { grant: grant() } }),
    });
    renderApp('/admin/access');
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === 'POST' && c.path.endsWith('/g1/approve'))).toBe(true),
    );
  });

  it('asks for confirmation before removing a member', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const calls = mockApi({
      'GET /me': () => ({ json: admin }),
      'GET /admin/access/pending-count': () => ({ json: { count: 1 } }),
      'GET /admin/access': () => ({ json: access }),
      'POST /admin/access/grants/g2/remove': () => ({ json: { grant: grant({ id: 'g2' }) } }),
    });
    renderApp('/admin/access');
    fireEvent.click(await screen.findByRole('button', { name: 'Remove' }));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(calls.some((c) => c.path.endsWith('/remove'))).toBe(false);
    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(calls.some((c) => c.path.endsWith('/g2/remove'))).toBe(true));
  });

  it('shows the nav item with a badge only for admins', async () => {
    mockApi({
      'GET /me': () => ({ json: admin }),
      'GET /admin/access/pending-count': () => ({ json: { count: 3 } }),
      'GET /admin/access': () => ({ json: access }),
    });
    const { unmount } = renderApp('/admin/access');
    expect(await screen.findByRole('link', { name: /Access/ })).toBeTruthy();
    expect(await screen.findByLabelText('3 pending access requests')).toBeTruthy();
    unmount();

    mockApi({ 'GET /me': () => ({ json: me }) });
    renderApp('/admin/access');
    expect(await screen.findByText('Admins only.')).toBeTruthy();
    expect(screen.queryByRole('link', { name: /Access/ })).toBeNull();
  });

  it('clears an old error once a later action succeeds', async () => {
    mockApi({
      'GET /me': () => ({ json: admin }),
      'GET /admin/access/pending-count': () => ({ json: { count: 1 } }),
      'GET /admin/access': () => ({ json: access }),
      'POST /admin/access/grants/g1/deny': () => ({
        status: 500,
        json: { error: { code: 'boom', message: 'Deny exploded' } },
      }),
      'POST /admin/access/grants': () => ({ json: { grant: grant({ githubLogin: 'carol' }) } }),
    });
    renderApp('/admin/access');
    fireEvent.click(await screen.findByRole('button', { name: 'Deny' }));
    expect(await screen.findByText('Deny exploded')).toBeTruthy();
    // A different action succeeds: the stale failure must go away.
    fireEvent.change(screen.getByLabelText('Add a GitHub login'), { target: { value: 'carol' } });
    fireEvent.click(screen.getByRole('button', { name: 'Pre-approve' }));
    await waitFor(() => expect(screen.queryByText('Deny exploded')).toBeNull());
    // A fresh failure still shows.
    fireEvent.click(screen.getByRole('button', { name: 'Deny' }));
    expect(await screen.findByText('Deny exploded')).toBeTruthy();
  });
});
