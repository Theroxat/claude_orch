import { DEFAULT_NOTIFICATION_PREFERENCES } from '@orch/shared';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { me, mockApi, renderApp } from '../test/helpers';

const verified = {
  preferences: DEFAULT_NOTIFICATION_PREFERENCES,
  slack: { configured: false, hint: null },
  discord: { configured: false, hint: null },
  webhook: { configured: false, hint: null },
  email: { available: true, address: 'octo@example.com', status: 'verified' },
  push: { available: false, publicKey: null, subscriptions: 0 },
};
const common = {
  'GET /me': () => ({ json: me }),
};

afterEach(() => vi.unstubAllGlobals());

describe('confirm e-mail page', () => {
  it('does nothing on load and confirms only when the button is pressed', async () => {
    const calls = mockApi({
      ...common,
      'POST /notifications/email/confirm': () => ({ json: verified }),
    });
    renderApp('/confirm-email?token=abcdefghijklmnopqrstuvwxyz');
    const button = await screen.findByRole('button', { name: 'Confirm' });
    expect(calls.some((c) => c.path === '/notifications/email/confirm')).toBe(false);
    fireEvent.click(button);
    expect(await screen.findByText('E-mail address confirmed')).toBeTruthy();
    expect(screen.getByText('octo@example.com')).toBeTruthy();
    expect(calls.find((c) => c.path === '/notifications/email/confirm')?.body).toEqual({
      token: 'abcdefghijklmnopqrstuvwxyz',
    });
  });

  it('explains an invalid or expired link and lets the member retry', async () => {
    mockApi({
      ...common,
      'POST /notifications/email/confirm': () => ({
        status: 400,
        json: { error: { code: 'invalid_token', message: 'This link is invalid or has expired' } },
      }),
    });
    renderApp('/confirm-email?token=abcdefghijklmnopqrstuvwxyz');
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm' }));
    expect((await screen.findByRole('alert')).textContent).toContain('invalid or has expired');
    await waitFor(() =>
      expect((screen.getByRole('button', { name: 'Confirm' }) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
  });

  it('refuses a link without a token', async () => {
    mockApi(common);
    renderApp('/confirm-email');
    expect(await screen.findByText(/link is incomplete/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Confirm' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });
});
