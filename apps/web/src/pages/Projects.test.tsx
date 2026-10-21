import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { mockApi, me, project, renderApp } from '../test/helpers';

const participant = (status: string) => ({
  user: { id: 'u2', githubLogin: 'alice', name: null, avatarUrl: null },
  participation: {
    id: 'pa1',
    projectId: 'p1',
    userId: 'u2',
    participating: true,
    budgetPercent: 30,
    mode: 'approval',
    status,
    approvedAt: null,
  },
});

describe('My projects', () => {
  it('renders the projects list with settings and pending participants', async () => {
    mockApi({
      'GET /me': () => ({ json: me }),
      'GET /projects/mine': () => ({ json: [project] }),
      'GET /projects/p1/participants': () => ({ json: [participant('pending')] }),
    });
    renderApp('/projects');
    const card = await screen.findByRole('article', { name: 'octo/repo' });
    expect(within(card).getByLabelText('Visibility')).toHaveProperty('value', 'ALL_MEMBERS');
    expect(within(card).getByLabelText('Who can participate')).toHaveProperty('value', 'GITHUB');
    expect(within(card).getByLabelText('Who can submit')).toHaveProperty('value', 'GITHUB');
    expect(within(card).getByLabelText(/Require participant approval/)).toHaveProperty(
      'checked',
      true,
    );
    expect(await within(card).findByText(/alice/)).toBeTruthy();
  });

  it('edits a setting inline and approves a participant', async () => {
    const calls = mockApi({
      'GET /me': () => ({ json: me }),
      'GET /projects/mine': () => ({ json: [project] }),
      'PATCH /projects/p1': () => ({ json: { ...project, visibility: 'COLLABORATORS' } }),
      'GET /projects/p1/participants': () => ({ json: [participant('pending')] }),
      'POST /projects/p1/participants/u2/approve': () => ({
        json: participant('active').participation,
      }),
    });
    renderApp('/projects');
    const card = await screen.findByRole('article', { name: 'octo/repo' });
    fireEvent.change(within(card).getByLabelText('Visibility'), {
      target: { value: 'COLLABORATORS' },
    });
    await waitFor(() =>
      expect(calls).toContainEqual({
        method: 'PATCH',
        path: '/projects/p1',
        body: { visibility: 'COLLABORATORS' },
      }),
    );
    fireEvent.click(await within(card).findByRole('button', { name: 'Approve alice' }));
    await waitFor(() =>
      expect(calls.some((c) => c.path === '/projects/p1/participants/u2/approve')).toBe(true),
    );
  });

  it('adds a repository from the dialog and links to the App install', async () => {
    let added = false;
    const calls = mockApi({
      'GET /me': () => ({ json: me }),
      'GET /projects/mine': () => ({ json: added ? [project] : [] }),
      'GET /projects/p1/participants': () => ({ json: [] }),
      'GET /github/install-url': () => ({
        json: { url: 'https://github.com/apps/orch/installations/new' },
      }),
      'GET /repos/available': () => ({
        json: [
          {
            githubRepoId: 1,
            fullName: 'octo/repo',
            private: true,
            installationId: 9,
            alreadyAdded: false,
          },
          {
            githubRepoId: 2,
            fullName: 'octo/old',
            private: false,
            installationId: 9,
            alreadyAdded: true,
          },
        ],
      }),
      'POST /projects': () => {
        added = true;
        return { status: 201, json: project };
      },
    });
    renderApp('/projects');
    fireEvent.click(await screen.findByRole('button', { name: 'Add repository' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add repository' });
    expect(await within(dialog).findByText('Added')).toBeTruthy();
    const install = await within(dialog).findByRole('link', { name: 'Install the GitHub App' });
    expect(install.getAttribute('href')).toBe('https://github.com/apps/orch/installations/new');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add octo/repo' }));
    await waitFor(() =>
      expect(calls).toContainEqual({
        method: 'POST',
        path: '/projects',
        body: { githubRepoId: 1 },
      }),
    );
    expect(await screen.findByRole('article', { name: 'octo/repo' })).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
