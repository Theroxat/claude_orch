import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { me, mockApi, renderApp } from '../test/helpers';

const onboarding = {
  steps: [{ id: 'github_app_installed', state: 'todo', done: false }],
};
const routes = (version: string) => ({
  'GET /me': () => ({ json: me }),
  'GET /healthz': () => ({ json: { status: 'ok', version } }),
  'GET /onboarding': () => ({ json: onboarding }),
  'GET /projects/mine': () => ({ json: [] }),
});

describe('version footer', () => {
  it('shows the release version linking to its GitHub release on every page', async () => {
    mockApi(routes('0.4.3'));
    renderApp('/projects');
    const link = await screen.findByRole('link', { name: 'orch v0.4.3' });
    expect(link.getAttribute('href')).toBe(
      'https://github.com/Theroxat/claude_orch/releases/tag/v0.4.3',
    );
  });

  it('shows a dev build as plain text, without a link', async () => {
    mockApi(routes('dev'));
    renderApp('/projects');
    expect(await screen.findByText('orch dev')).toBeTruthy();
    expect(screen.queryByRole('link', { name: /orch dev/ })).toBeNull();
  });

  it('is shown on the welcome wizard too', async () => {
    mockApi(routes('0.4.3'));
    renderApp('/welcome');
    expect(await screen.findByRole('link', { name: 'orch v0.4.3' })).toBeTruthy();
  });
});
