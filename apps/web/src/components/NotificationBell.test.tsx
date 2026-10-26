import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { me, mockApi, renderApp, switchToFrench, type Routes } from '../test/helpers';

const item = (over: Record<string, unknown> = {}) => ({
  id: 'n1',
  event: 'task_done',
  title: 'Task done: fix login',
  body: 'octo/repo#12 was merged',
  url: '/backlog?task=t1',
  projectId: 'p1',
  taskId: 't1',
  createdAt: new Date(Date.now() - 5 * 60_000).toISOString(),
  readAt: null,
  ...over,
});

const base = (unreadCount: number, items: unknown[] = []): Routes => ({
  'GET /me': () => ({ json: me }),
  'GET /onboarding': () => ({ json: { steps: [] } }),
  'GET /projects/mine': () => ({ json: [] }),
  'GET /backlog': () => ({ json: { columns: [] } }),
  'GET /notifications/unread-count': () => ({ json: { unreadCount } }),
  'GET /notifications?limit=30': () => ({ json: { items, unreadCount } }),
});

afterEach(() => vi.unstubAllGlobals());

describe('notification bell', () => {
  it('shows the unread count and caps it at 9+', async () => {
    mockApi(base(3));
    const { unmount } = renderApp('/projects');
    const bell = await screen.findByRole('button', { name: 'Notifications, 3 unread' });
    expect(bell.textContent).toBe('3');
    unmount();
    mockApi(base(14));
    renderApp('/projects');
    const capped = await screen.findByRole('button', { name: 'Notifications, 14 unread' });
    expect(capped.textContent).toBe('9+');
  });

  it('shows no badge without unread notifications', async () => {
    mockApi(base(0));
    renderApp('/projects');
    const bell = await screen.findByRole('button', { name: 'Notifications' });
    expect(bell.textContent).toBe('');
  });

  it('lists the notifications when opened and closes on Escape, returning focus', async () => {
    mockApi(
      base(1, [
        item(),
        item({ id: 'n2', title: 'Old one', body: 'older', readAt: '2026-01-01T00:00:00Z' }),
      ]),
    );
    renderApp('/projects');
    const bell = await screen.findByRole('button', { name: 'Notifications, 1 unread' });
    expect(bell.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(bell);
    const dialog = await screen.findByRole('dialog', { name: 'Notifications' });
    expect(bell.getAttribute('aria-expanded')).toBe('true');
    expect(bell.getAttribute('aria-controls')).toBe(dialog.id);
    expect(await within(dialog).findByText('Task done: fix login')).toBeTruthy();
    expect(within(dialog).getByText('octo/repo#12 was merged')).toBeTruthy();
    expect(within(dialog).getAllByText('5m ago')).toBeTruthy();
    expect(within(dialog).getAllByRole('img', { name: 'Unread' })).toHaveLength(1);
    expect(
      within(dialog).getByRole('link', { name: 'Notification settings' }).getAttribute('href'),
    ).toBe('/my-server#notifications');
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(bell);
  });

  it('closes on an outside click', async () => {
    mockApi(base(0, []));
    renderApp('/projects');
    fireEvent.click(await screen.findByRole('button', { name: 'Notifications' }));
    expect(await screen.findByText(/Nothing yet/)).toBeTruthy();
    fireEvent.pointerDown(document.body);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('marks an item read and follows its app path', async () => {
    const calls = mockApi({
      ...base(1, [item()]),
      'POST /notifications/read': () => ({ json: { unreadCount: 0 } }),
    });
    renderApp('/projects');
    fireEvent.click(await screen.findByRole('button', { name: 'Notifications, 1 unread' }));
    fireEvent.click(await screen.findByRole('button', { name: /Task done: fix login/ }));
    await waitFor(() =>
      expect(calls.find((c) => c.path === '/notifications/read')?.body).toEqual({ ids: ['n1'] }),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(await screen.findByRole('heading', { name: 'Backlog' })).toBeTruthy();
    expect(await screen.findByRole('button', { name: 'Notifications' })).toBeTruthy();
  });

  it('opens a pull request link in a new tab', async () => {
    const open = vi.fn();
    vi.stubGlobal('open', open);
    mockApi({
      ...base(1, [
        item({ event: 'pr_review', title: 'Review PR', url: 'https://github.com/o/r/pull/3' }),
      ]),
      'POST /notifications/read': () => ({ json: { unreadCount: 0 } }),
    });
    renderApp('/projects');
    fireEvent.click(await screen.findByRole('button', { name: 'Notifications, 1 unread' }));
    fireEvent.click(await screen.findByRole('button', { name: /Review PR/ }));
    expect(open).toHaveBeenCalledWith(
      'https://github.com/o/r/pull/3',
      '_blank',
      'noopener,noreferrer',
    );
  });

  it.each(['javascript:alert(1)', 'data:text/html,<script>1</script>', '//evil.example/x'])(
    'never opens a non-http(s) link: %s',
    async (url) => {
      const open = vi.fn();
      vi.stubGlobal('open', open);
      mockApi({
        ...base(1, [item({ title: 'Odd link', url })]),
        'POST /notifications/read': () => ({ json: { unreadCount: 0 } }),
      });
      renderApp('/projects');
      fireEvent.click(await screen.findByRole('button', { name: 'Notifications, 1 unread' }));
      fireEvent.click(await screen.findByRole('button', { name: /Odd link/ }));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(open).not.toHaveBeenCalled();
    },
  );

  it('marks everything read', async () => {
    const calls = mockApi({
      ...base(2, [item(), item({ id: 'n2', title: 'Second' })]),
      'POST /notifications/read': () => ({ json: { unreadCount: 0 } }),
    });
    renderApp('/projects');
    fireEvent.click(await screen.findByRole('button', { name: 'Notifications, 2 unread' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Mark all read' }));
    await waitFor(() =>
      expect(calls.find((c) => c.path === '/notifications/read')?.body).toEqual({ all: true }),
    );
    expect(await screen.findByRole('button', { name: 'Notifications' })).toBeTruthy();
  });

  it('shows an empty state', async () => {
    mockApi(base(0, []));
    renderApp('/projects');
    fireEvent.click(await screen.findByRole('button', { name: 'Notifications' }));
    expect(await screen.findByText(/Nothing yet/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Mark all read' }).hasAttribute('disabled')).toBe(
      true,
    );
  });

  it('speaks French: label with plural, panel texts', async () => {
    await switchToFrench();
    mockApi(base(2, [item()]));
    renderApp('/projects');
    const bell = await screen.findByRole('button', { name: 'Notifications, 2 non lues' });
    fireEvent.click(bell);
    const dialog = await screen.findByRole('dialog', { name: 'Notifications' });
    expect(within(dialog).getByRole('button', { name: 'Tout marquer comme lu' })).toBeTruthy();
    expect(await within(dialog).findByRole('img', { name: 'Non lue' })).toBeTruthy();
    expect(within(dialog).getByRole('link', { name: 'Paramètres des notifications' })).toBeTruthy();
  });
});
