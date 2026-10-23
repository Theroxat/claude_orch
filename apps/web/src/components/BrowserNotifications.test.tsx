import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { me, mockApi, renderApp, type Routes } from '../test/helpers';
import { keyBytes } from '../push/browser';

const settings = (push: Record<string, unknown> = {}) => ({
  preferences: Object.fromEntries(
    [
      'task_done',
      'task_failed',
      'task_needs_attention',
      'pr_review',
      'consent_request',
      'access_request',
      'participation_request',
    ].map((e) => [e, ['in_app']]),
  ),
  slack: { configured: false, hint: null },
  discord: { configured: false, hint: null },
  webhook: { configured: false, hint: null },
  email: { available: false, address: null },
  push: {
    available: true,
    publicKey: 'BEl62iUYgUivxIkv69yViEuiBIa-Ib9',
    subscriptions: 0,
    ...push,
  },
});

const base = (view: unknown): Routes => ({
  'GET /me': () => ({ json: me }),
  'GET /onboarding': () => ({ json: { steps: [] } }),
  'GET /agents/mine': () => ({ json: [] }),
  'GET /notifications/unread-count': () => ({ json: { unreadCount: 0 } }),
  'GET /notifications/settings': () => ({ json: view }),
});

const toggle = () => screen.findByRole('checkbox', { name: 'Enable browser notifications' });

let current: { endpoint: string; unsubscribe: ReturnType<typeof vi.fn> } | null;
const subscription = (endpoint = 'https://fcm.googleapis.com/fcm/send/abc') => ({
  endpoint,
  unsubscribe: vi.fn(async () => true),
  toJSON: () => ({ endpoint, keys: { p256dh: 'p256', auth: 'auth' } }),
});
const pushManager = {
  getSubscription: vi.fn(async () => current),
  subscribe: vi.fn<(options: unknown) => Promise<unknown>>(async () => (current = subscription())),
};
const registration = { active: {}, pushManager };
const register = vi.fn(async () => registration);
const getRegistration = vi.fn(async () => (current ? registration : undefined));
const notification = { permission: 'default', requestPermission: vi.fn(async () => 'granted') };

/** jsdom has no service workers, push or notifications: install fakes. */
function supportBrowser() {
  vi.stubGlobal('PushManager', class {});
  vi.stubGlobal('Notification', notification);
  Object.defineProperty(navigator, 'serviceWorker', {
    value: { register, getRegistration },
    configurable: true,
  });
}

beforeEach(() => {
  current = null;
  notification.permission = 'default';
  notification.requestPermission.mockClear().mockResolvedValue('granted');
  register.mockClear();
  pushManager.subscribe.mockClear();
});
afterEach(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, 'serviceWorker');
});

describe('browser notifications toggle', () => {
  it('explains when the browser cannot do push (and points iOS users to the Home Screen)', async () => {
    mockApi(base(settings()));
    renderApp('/my-server');
    expect(await screen.findByText(/add orch to the Home Screen/)).toBeTruthy();
    expect((await toggle()).hasAttribute('disabled')).toBe(true);
  });

  it('is unavailable, and says why, when the server has no VAPID keys', async () => {
    supportBrowser();
    mockApi(base(settings({ available: false, publicKey: null })));
    renderApp('/my-server');
    expect(await screen.findByText(/no push keys/)).toBeTruthy();
    expect((await toggle()).hasAttribute('disabled')).toBe(true);
    expect(
      (screen.getByRole('checkbox', { name: 'Task done on Browser' }) as HTMLInputElement).disabled,
    ).toBe(true);
  });

  it('asks permission, subscribes this browser and registers it on the server', async () => {
    supportBrowser();
    let subs = 0;
    const calls = mockApi({
      ...base(null),
      'GET /notifications/settings': () => ({ json: settings({ subscriptions: subs }) }),
      'POST /notifications/push/subscribe': () => {
        subs = 1;
        return { json: { subscriptions: 1 } };
      },
    });
    renderApp('/my-server');
    const box = (await toggle()) as HTMLInputElement;
    await waitFor(() => expect(box.disabled).toBe(false));
    expect(box.checked).toBe(false);
    // Nothing is asked before the click.
    expect(notification.requestPermission).not.toHaveBeenCalled();
    fireEvent.click(box);

    expect(await screen.findByText('Browser notifications enabled')).toBeTruthy();
    expect(notification.requestPermission).toHaveBeenCalledTimes(1);
    expect(register).toHaveBeenCalledWith('/push-sw.js', { scope: '/push-sw-scope/' });
    const opts = pushManager.subscribe.mock.calls[0]![0] as {
      userVisibleOnly: boolean;
      applicationServerKey: Uint8Array;
    };
    expect(opts.userVisibleOnly).toBe(true);
    expect(opts.applicationServerKey).toEqual(keyBytes('BEl62iUYgUivxIkv69yViEuiBIa-Ib9'));
    expect(calls.find((c) => c.path === '/notifications/push/subscribe')?.body).toEqual({
      endpoint: 'https://fcm.googleapis.com/fcm/send/abc',
      keys: { p256dh: 'p256', auth: 'auth' },
    });
    expect(((await toggle()) as HTMLInputElement).checked).toBe(true);
    // The Browser column of the matrix and the test button come alive.
    await waitFor(() =>
      expect(
        (screen.getByRole('checkbox', { name: 'Task done on Browser' }) as HTMLInputElement)
          .disabled,
      ).toBe(false),
    );
    expect(
      (screen.getByRole('button', { name: 'Send test to Browser' }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it('does not subscribe when the permission is refused, and explains how to unblock', async () => {
    supportBrowser();
    notification.requestPermission.mockResolvedValue('denied');
    const calls = mockApi(base(settings()));
    renderApp('/my-server');
    const box = (await toggle()) as HTMLInputElement;
    await waitFor(() => expect(box.disabled).toBe(false));
    fireEvent.click(box);
    expect(await screen.findByText(/blocked for this site/)).toBeTruthy();
    expect(register).not.toHaveBeenCalled();
    expect(calls.some((c) => c.path.includes('push/subscribe'))).toBe(false);
    expect(box.disabled).toBe(true);
  });

  it('starts blocked when the permission was denied earlier', async () => {
    supportBrowser();
    notification.permission = 'denied';
    mockApi(base(settings()));
    renderApp('/my-server');
    expect(await screen.findByText(/blocked for this site/)).toBeTruthy();
    expect(((await toggle()) as HTMLInputElement).disabled).toBe(true);
  });

  it('stays off, with a notice, when the permission prompt is dismissed', async () => {
    supportBrowser();
    notification.requestPermission.mockResolvedValue('default');
    mockApi(base(settings()));
    renderApp('/my-server');
    const box = (await toggle()) as HTMLInputElement;
    await waitFor(() => expect(box.disabled).toBe(false));
    fireEvent.click(box);
    expect(await screen.findByText('Browser notifications were not enabled')).toBeTruthy();
    expect(box.checked).toBe(false);
    expect(box.disabled).toBe(false);
  });

  it('turns off: forgets the browser on the server and unsubscribes locally', async () => {
    supportBrowser();
    current = subscription();
    const sub = current;
    const calls = mockApi({
      ...base(settings({ subscriptions: 1 })),
      'POST /notifications/push/unsubscribe': () => ({ json: { subscriptions: 0 } }),
    });
    renderApp('/my-server');
    const box = (await toggle()) as HTMLInputElement;
    await waitFor(() => expect(box.checked).toBe(true));
    fireEvent.click(box);
    expect(await screen.findByText('Browser notifications turned off')).toBeTruthy();
    expect(calls.find((c) => c.path === '/notifications/push/unsubscribe')?.body).toEqual({
      endpoint: 'https://fcm.googleapis.com/fcm/send/abc',
    });
    expect(sub.unsubscribe).toHaveBeenCalled();
    await waitFor(() => expect(box.checked).toBe(false));
  });

  it('reports a failure of the server registration without claiming success', async () => {
    supportBrowser();
    mockApi({
      ...base(settings()),
      'POST /notifications/push/subscribe': () => ({
        status: 400,
        json: { error: { code: 'invalid_push_endpoint', message: 'Not a known push service' } },
      }),
    });
    renderApp('/my-server');
    const box = (await toggle()) as HTMLInputElement;
    await waitFor(() => expect(box.disabled).toBe(false));
    fireEvent.click(box);
    expect(
      await screen.findByText(/Could not enable browser notifications: Not a known push service/),
    ).toBeTruthy();
    expect(screen.queryByText('Browser notifications enabled')).toBeNull();
  });

  it('sends a test to the browser', async () => {
    supportBrowser();
    current = subscription();
    const calls = mockApi({
      ...base(settings({ subscriptions: 1 })),
      'POST /notifications/test': () => ({ json: { ok: true } }),
    });
    renderApp('/my-server');
    fireEvent.click(await screen.findByRole('button', { name: 'Send test to Browser' }));
    expect(await screen.findByText('Test sent to Browser')).toBeTruthy();
    expect(calls.find((c) => c.path === '/notifications/test')?.body).toEqual({ channel: 'push' });
  });
});

describe('keyBytes', () => {
  it('decodes a base64url VAPID key', () => {
    expect(Array.from(keyBytes('AQID_-4'))).toEqual([1, 2, 3, 255, 238]);
  });

  it('detaches this browser from the member on log out', async () => {
    supportBrowser();
    current = subscription();
    const calls = mockApi({
      ...base(settings({ subscriptions: 1 })),
      'POST /notifications/push/unsubscribe': () => ({ json: { subscriptions: 0 } }),
      'POST /auth/logout': () => ({ status: 204 }),
    });
    renderApp('/my-server');
    fireEvent.click(await screen.findByRole('button', { name: 'Log out' }));
    const sub = current;
    await waitFor(() => expect(sub?.unsubscribe).toHaveBeenCalled());
    const paths = calls.map((c) => `${c.method} ${c.path}`);
    expect(paths).toContain('POST /notifications/push/unsubscribe');
    expect(paths.indexOf('POST /notifications/push/unsubscribe')).toBeLessThan(
      paths.indexOf('POST /auth/logout'),
    );
  });
});
