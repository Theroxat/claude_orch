import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api/client';
import { ToastProvider } from './Toast';

afterEach(() => vi.unstubAllGlobals());

describe('429 handling', () => {
  it('shows one friendly notice when the server rate-limits a request', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { code: 'rate_limited', message: 'slow down' } }), {
            status: 429,
            headers: { 'Retry-After': '12' },
          }),
      ),
    );
    render(
      <ToastProvider>
        <p>app</p>
      </ToastProvider>,
    );
    await act(async () => {
      await api('GET', '/me').catch(() => undefined);
      await api('GET', '/me').catch(() => undefined);
    });
    expect(screen.getAllByText(/Too many requests. Please wait 12 s/)).toHaveLength(1);
  });
});
