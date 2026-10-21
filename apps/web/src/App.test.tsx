import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { mockApi, me, renderApp } from './test/helpers';

describe('auth gate', () => {
  it('redirects unauthenticated users to the login page', async () => {
    mockApi({
      'GET /me': () => ({ status: 401, json: { error: { code: 'unauthorized', message: 'no' } } }),
    });
    renderApp('/projects');
    const link = await screen.findByRole('link', { name: 'Sign in with GitHub' });
    expect(link.getAttribute('href')).toBe('/api/auth/github/login?next=%2Fprojects');
  });

  it('shows the layout with nav and user when signed in', async () => {
    mockApi({ 'GET /me': () => ({ json: me }), 'GET /projects/mine': () => ({ json: [] }) });
    renderApp('/pool');
    expect(await screen.findByRole('heading', { name: 'Pool' })).toBeTruthy();
    for (const n of ['Projects', 'Discover', 'Pool', 'Backlog', 'My Server'])
      expect(screen.getByRole('link', { name: n })).toBeTruthy();
    await waitFor(() => expect(screen.getByText('Octo Cat')).toBeTruthy());
    expect(screen.getByRole('button', { name: 'Log out' })).toBeTruthy();
  });
});

describe('unknown routes', () => {
  it('shows a not-found page with a link home', async () => {
    mockApi({ 'GET /me': () => ({ json: me }), 'GET /projects/mine': () => ({ json: [] }) });
    renderApp('/no/such/page');
    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Back to orch' }).getAttribute('href')).toBe('/');
  });
});
