import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { mockApi, me, renderApp } from '../test/helpers';

const URL = 'https://github.com/apps/orch/installations/new';
const base = {
  'GET /me': () => ({ json: me }),
  'GET /projects/mine': () => ({ json: [] }),
  'GET /github/install-url': () => ({ json: { url: URL } }),
};

describe('Add repository onboarding', () => {
  it('shows the guide, install link and refetches on Refresh', async () => {
    let n = 0;
    const calls = mockApi({
      ...base,
      'GET /repos/available': () => {
        n++;
        return { json: [] };
      },
    });
    renderApp('/projects');
    fireEvent.click(await screen.findByRole('button', { name: 'Add your first repository' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add repository' });
    expect(await within(dialog).findByText('Install the GitHub App first')).toBeTruthy();
    const link = await within(dialog).findByRole('link', { name: 'Install the GitHub App' });
    expect(link.getAttribute('href')).toBe(URL);
    expect(link.getAttribute('target')).toBe('_blank');
    expect(within(dialog).getByText(/must be a repository admin/)).toBeTruthy();
    const before = n;
    fireEvent.click(within(dialog).getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(n).toBeGreaterThan(before));
    expect(calls.length).toBeGreaterThan(0);
  });

  it('shows only a discreet link when repositories exist', async () => {
    mockApi({
      ...base,
      'GET /repos/available': () => ({
        json: [
          {
            githubRepoId: 1,
            fullName: 'octo/repo',
            private: false,
            installationId: 9,
            alreadyAdded: false,
          },
        ],
      }),
    });
    renderApp('/projects');
    fireEvent.click(await screen.findByRole('button', { name: 'Add your first repository' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add repository' });
    expect(await within(dialog).findByText('octo/repo')).toBeTruthy();
    expect(within(dialog).queryByText('Install the GitHub App first')).toBeNull();
    expect(within(dialog).getByRole('link', { name: 'Install the GitHub App' })).toBeTruthy();
    expect(within(dialog).getByText(/Only repositories where you are an admin/)).toBeTruthy();
  });
});
