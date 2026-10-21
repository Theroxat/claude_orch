import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
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

  it('does not show a removed project as already added when the dialog is reopened', async () => {
    const project = {
      id: 'p1',
      githubRepoId: 1,
      fullName: 'octo/repo',
      isPrivate: false,
      defaultBranch: 'main',
      visibility: 'ALL_MEMBERS',
      requireParticipantApproval: true,
      whoCanParticipate: 'GITHUB',
      whoCanSubmit: 'GITHUB',
      ownerId: 'u1',
      createdAt: '2026-01-01T00:00:00Z',
    };
    const repo = (alreadyAdded: boolean) => ({
      githubRepoId: 1,
      fullName: 'octo/repo',
      private: false,
      installationId: 9,
      alreadyAdded,
    });
    let removed = false;
    mockApi({
      ...base,
      'GET /projects/mine': () => ({ json: removed ? [] : [project] }),
      'GET /projects/p1/participants': () => ({ json: [] }),
      'DELETE /projects/p1': () => {
        removed = true;
        return { json: {} };
      },
      'GET /repos/available': () => ({ json: [repo(!removed)] }),
    });
    vi.stubGlobal('confirm', () => true);
    renderApp('/projects');
    fireEvent.click(await screen.findByRole('button', { name: 'Add repository' }));
    let dialog = await screen.findByRole('dialog', { name: 'Add repository' });
    expect(await within(dialog).findByText('Added')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    fireEvent.click(await screen.findByRole('button', { name: 'Remove' }));
    await screen.findByText('Add your first repository to the pool');
    fireEvent.click(screen.getByRole('button', { name: 'Add repository' }));
    dialog = await screen.findByRole('dialog', { name: 'Add repository' });
    // The cached "Added" row must never be rendered, even for one frame.
    expect(within(dialog).queryByText('Added')).toBeNull();
    expect(await within(dialog).findByRole('button', { name: 'Add octo/repo' })).toBeTruthy();
  });
});
