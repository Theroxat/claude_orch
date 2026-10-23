import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { me, mockApi, renderApp, type Routes } from '../test/helpers';

const settings = (over: Record<string, unknown> = {}) => ({
  preferences: {
    task_done: ['in_app', 'slack'],
    task_failed: ['in_app'],
    task_needs_attention: ['in_app'],
    pr_review: ['in_app'],
    consent_request: ['in_app'],
    access_request: ['in_app'],
    participation_request: ['in_app'],
  },
  slack: { configured: true, hint: 'https://hooks.slack.com/…a1b2' },
  discord: { configured: false, hint: null },
  webhook: { configured: false, hint: null },
  email: { available: true, address: 'octo@example.com', status: 'verified' },
  push: { available: false, publicKey: null, subscriptions: 0 },
  ...over,
});

const base = (view: unknown = settings()): Routes => ({
  'GET /me': () => ({ json: me }),
  'GET /onboarding': () => ({ json: { steps: [] } }),
  'GET /agents/mine': () => ({ json: [] }),
  'GET /notifications/unread-count': () => ({ json: { unreadCount: 0 } }),
  'GET /notifications/settings': () => ({ json: view }),
});

afterEach(() => vi.unstubAllGlobals());

const box = (name: string) => screen.getByRole('checkbox', { name }) as HTMLInputElement;

describe('notification settings', () => {
  it('shows masked hints and the saved preferences', async () => {
    mockApi(base());
    renderApp('/my-server#notifications');
    expect(await screen.findByText('https://hooks.slack.com/…a1b2')).toBeTruthy();
    expect((screen.getByLabelText('E-mail address') as HTMLInputElement).value).toBe(
      'octo@example.com',
    );
    expect(box('Task done on Slack').checked).toBe(true);
    expect(box('Task failed on Slack').checked).toBe(false);
    expect(box('Task done on In the app').checked).toBe(true);
    // Discord is not set up: its column is disabled.
    expect(box('Task done on Discord').disabled).toBe(true);
    expect(box('Task done on Slack').disabled).toBe(false);
  });

  it('disables the e-mail column and explains why when the server has no SMTP', async () => {
    mockApi(base(settings({ email: { available: false, address: null, status: 'none' } })));
    renderApp('/my-server');
    expect(await screen.findByText(/no mail settings/)).toBeTruthy();
    expect(box('Task done on E-mail').disabled).toBe(true);
    expect((screen.getByLabelText('E-mail address') as HTMLInputElement).disabled).toBe(true);
  });

  it('saves the preferences and only the changed targets', async () => {
    const calls = mockApi({
      ...base(),
      'PUT /notifications/settings': () => ({ json: settings() }),
    });
    renderApp('/my-server');
    await screen.findByText('https://hooks.slack.com/…a1b2');
    fireEvent.click(box('Task failed on Slack'));
    fireEvent.click(box('Task done on In the app'));
    fireEvent.change(screen.getByLabelText('Discord webhook URL'), {
      target: { value: ' https://discord.com/api/webhooks/1/x ' },
    });
    fireEvent.change(screen.getByLabelText('E-mail address'), {
      target: { value: 'new@example.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save notification settings' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    const put = calls.find((c) => c.method === 'PUT');
    expect(put?.body).toEqual({
      preferences: {
        ...settings().preferences,
        task_done: ['slack'],
        task_failed: ['in_app', 'slack'],
      },
      discordWebhookUrl: 'https://discord.com/api/webhooks/1/x',
      email: 'new@example.com',
    });
    expect(await screen.findByText('Notification settings saved')).toBeTruthy();
  });

  it('shows the server error for an invalid webhook URL', async () => {
    mockApi({
      ...base(),
      'PUT /notifications/settings': () => ({
        status: 400,
        json: {
          error: { code: 'invalid_webhook_url', message: 'Webhook URLs must be public https URLs' },
        },
      }),
    });
    renderApp('/my-server');
    fireEvent.change(await screen.findByLabelText('JSON webhook URL'), {
      target: { value: 'http://10.0.0.1/hook' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save notification settings' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('Webhook URLs must be public https URLs');
    expect(screen.getByLabelText('JSON webhook URL').getAttribute('aria-invalid')).toBe('true');
  });

  it('removes a configured webhook', async () => {
    const calls = mockApi({
      ...base(),
      'PUT /notifications/settings': () => ({
        json: settings({ slack: { configured: false, hint: null } }),
      }),
    });
    renderApp('/my-server');
    fireEvent.click(await screen.findByRole('button', { name: 'Remove Slack' }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({ slackWebhookUrl: null }),
    );
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Remove Slack' })).toBeNull());
  });

  it('sends a test and toasts the result', async () => {
    const calls = mockApi({
      ...base(),
      'POST /notifications/test': (b) =>
        (b as { channel: string }).channel === 'slack'
          ? { json: { ok: true } }
          : { json: { ok: false, error: 'HTTP 404' } },
    });
    renderApp('/my-server');
    fireEvent.click(await screen.findByRole('button', { name: 'Send test to Slack' }));
    expect(await screen.findByText('Test sent to Slack')).toBeTruthy();
    expect(calls.find((c) => c.path === '/notifications/test')?.body).toEqual({ channel: 'slack' });
    fireEvent.click(screen.getByRole('button', { name: 'Send test to E-mail' }));
    expect(await screen.findByText('Test to E-mail failed: HTTP 404')).toBeTruthy();
    // Discord has no target yet.
    expect(
      (screen.getByRole('button', { name: 'Send test to Discord' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('shows a verified badge and no resend button for a confirmed address', async () => {
    mockApi(base());
    renderApp('/my-server');
    expect(await screen.findByText('Verified')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Resend confirmation' })).toBeNull();
    expect(box('Task done on E-mail').disabled).toBe(false);
  });

  it('shows a pending badge, keeps e-mail off and resends the confirmation', async () => {
    const calls = mockApi({
      ...base(
        settings({ email: { available: true, address: 'octo@example.com', status: 'pending' } }),
      ),
      'POST /notifications/email/resend': () => ({ json: { ok: true } }),
    });
    renderApp('/my-server');
    expect(await screen.findByText('Pending confirmation')).toBeTruthy();
    expect(screen.queryByText('Verified')).toBeNull();
    // Nothing can be sent to it yet: no test, no event routing.
    expect(box('Task done on E-mail').disabled).toBe(true);
    expect(
      (screen.getByRole('button', { name: 'Send test to E-mail' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Resend confirmation' }));
    expect(await screen.findByText(/Confirmation e-mail sent/)).toBeTruthy();
    expect(calls.some((c) => c.method === 'POST' && c.path === '/notifications/email/resend')).toBe(
      true,
    );
  });

  it('toasts the rate limit when resending too often', async () => {
    mockApi({
      ...base(
        settings({ email: { available: true, address: 'octo@example.com', status: 'pending' } }),
      ),
      'POST /notifications/email/resend': () => ({
        status: 429,
        json: { error: { code: 'rate_limited', message: 'Too many confirmation e-mails' } },
      }),
    });
    renderApp('/my-server');
    fireEvent.click(await screen.findByRole('button', { name: 'Resend confirmation' }));
    expect(await screen.findByText('Too many confirmation e-mails')).toBeTruthy();
  });
});
