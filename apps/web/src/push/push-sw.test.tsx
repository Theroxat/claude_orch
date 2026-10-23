import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

// vitest runs from apps/web
const source = readFileSync(resolve(process.cwd(), 'public/push-sw.js'), 'utf8');
const ORIGIN = 'https://orch.example.com';

type Listener = (event: Record<string, unknown>) => void;

/** Runs the worker script against a fake service worker global and returns its handlers. */
function boot(
  windows: Array<{ url: string; focus: () => Promise<unknown>; navigate?: unknown }> = [],
) {
  const listeners: Record<string, Listener> = {};
  const showNotification = vi.fn(async () => undefined);
  const openWindow = vi.fn(async () => null);
  const self = {
    location: { origin: ORIGIN },
    addEventListener: (type: string, fn: Listener) => (listeners[type] = fn),
    skipWaiting: vi.fn(),
    clients: { claim: vi.fn(), matchAll: vi.fn(async () => windows), openWindow },
    registration: { showNotification },
  };
  new Function('self', source)(self);
  const waited: Promise<unknown>[] = [];
  const dispatch = async (type: string, event: Record<string, unknown>) => {
    listeners[type]!({ ...event, waitUntil: (p: Promise<unknown>) => waited.push(p) });
    await Promise.all(waited);
  };
  return { dispatch, showNotification, openWindow, self };
}

const pushEvent = (payload: unknown) => ({
  data: {
    json: () => (typeof payload === 'string' ? JSON.parse(payload) : payload),
    text: () => String(payload),
  },
});
const click = (url: unknown) => ({
  notification: { close: vi.fn(), data: { url } },
});

describe('push service worker', () => {
  it('shows the notification with its text and an app path to open', async () => {
    const sw = boot();
    await sw.dispatch(
      'push',
      pushEvent({
        title: 'Task done',
        body: 'acme/api#1 merged',
        url: '/backlog?task=t1',
        tag: 'n1',
      }),
    );
    expect(sw.showNotification).toHaveBeenCalledWith(
      'Task done',
      expect.objectContaining({
        body: 'acme/api#1 merged',
        tag: 'n1',
        data: { url: '/backlog?task=t1' },
      }),
    );
  });

  it('falls back to "orch" and the home page for a payload it does not understand', async () => {
    const sw = boot();
    await sw.dispatch('push', pushEvent({}));
    expect(sw.showNotification).toHaveBeenCalledWith(
      'orch',
      expect.objectContaining({ body: '', data: { url: '/' } }),
    );
    await sw.dispatch('push', {
      data: {
        json: () => {
          throw new Error('bad');
        },
        text: () => 'plain text',
      },
    });
    expect(sw.showNotification).toHaveBeenLastCalledWith(
      'orch',
      expect.objectContaining({ body: 'plain text' }),
    );
    await sw.dispatch('push', {});
    expect(sw.showNotification).toHaveBeenCalledTimes(3);
  });

  it.each([
    { url: 'https://evil.example/phish', why: 'another origin' },
    { url: '//evil.example/x', why: 'protocol-relative' },
    { url: 'javascript:alert(1)', why: 'javascript: URL' },
    { url: 42, why: 'not a string' },
    { url: null, why: 'missing' },
  ])('never opens $why: the app opens instead', async ({ url }) => {
    const sw = boot();
    await sw.dispatch('push', pushEvent({ title: 't', url }));
    expect(sw.showNotification).toHaveBeenCalledWith(
      't',
      expect.objectContaining({ data: { url: '/' } }),
    );
    await sw.dispatch('notificationclick', click(url));
    expect(sw.openWindow).toHaveBeenCalledWith('/');
  });

  it('on click focuses an open orch window and navigates it', async () => {
    const focus = vi.fn(async () => undefined);
    const navigate = vi.fn(async () => undefined);
    const sw = boot([
      { url: 'https://other.example/', focus: vi.fn(), navigate: vi.fn() },
      { url: `${ORIGIN}/projects`, focus, navigate },
    ]);
    const e = click('/requests');
    await sw.dispatch('notificationclick', e);
    expect(e.notification.close).toHaveBeenCalled();
    expect(focus).toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith('/requests');
    expect(sw.openWindow).not.toHaveBeenCalled();
  });

  it('on click opens a window when none is open, or when navigating fails', async () => {
    const none = boot();
    await none.dispatch('notificationclick', click('/backlog?task=t1'));
    expect(none.openWindow).toHaveBeenCalledWith('/backlog?task=t1');

    const refuses = boot([
      {
        url: `${ORIGIN}/`,
        focus: vi.fn(async () => undefined),
        navigate: vi.fn(async () => {
          throw new Error('no');
        }),
      },
    ]);
    await refuses.dispatch('notificationclick', click('/pool'));
    expect(refuses.openWindow).toHaveBeenCalledWith('/pool');
  });

  it('activates at once and claims its clients', async () => {
    const sw = boot();
    await sw.dispatch('install', {});
    await sw.dispatch('activate', {});
    expect(sw.self.skipWaiting).toHaveBeenCalled();
    expect(sw.self.clients.claim).toHaveBeenCalled();
  });
});
