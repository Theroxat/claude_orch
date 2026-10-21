import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { mockApi, me, project, renderApp } from '../test/helpers';

const participant = (status: string, over: object = {}, who = { id: 'u2', login: 'alice' }) => ({
  user: { id: who.id, githubLogin: who.login, name: null, avatarUrl: null },
  participation: {
    id: `pa-${who.id}`,
    projectId: 'p1',
    userId: who.id,
    participating: true,
    budgetPercent: 30,
    mode: 'approval',
    status,
    approvedAt: null,
    ...over,
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
    expect(within(card).getByText(/collaborators on the GitHub repository/)).toBeTruthy();
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

  it('lets the owner join their own pool; their row stays out of the approval lists', async () => {
    const calls = mockApi({
      'GET /me': () => ({ json: me }),
      'GET /projects/mine': () => ({ json: [project] }),
      'GET /projects/p1/participants': () => ({ json: [] }),
      'PUT /projects/p1/participation': () => ({
        json: participant('active', { mode: 'auto' }, { id: 'u1', login: 'octo' }).participation,
      }),
    });
    renderApp('/projects');
    const card = await screen.findByRole('article', { name: 'octo/repo' });
    const pool = await within(card).findByRole('group', {
      name: 'Participate in my pool: octo/repo',
    });
    expect(within(pool).getByText(/approved automatically/)).toBeTruthy();
    fireEvent.click(within(pool).getByLabelText('Participate'));
    fireEvent.click(within(pool).getByLabelText(/Auto/));
    fireEvent.click(within(pool).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(calls).toContainEqual({
        method: 'PUT',
        path: '/projects/p1/participation',
        body: { participating: true, budgetPercent: 20, mode: 'auto' },
      }),
    );
  });

  it('shows the owner row as active in the pool form, not as a pending request', async () => {
    mockApi({
      'GET /me': () => ({ json: me }),
      'GET /projects/mine': () => ({ json: [project] }),
      'GET /projects/p1/participants': () => ({
        json: [participant('active', {}, { id: 'u1', login: 'octo' })],
      }),
    });
    renderApp('/projects');
    const card = await screen.findByRole('article', { name: 'octo/repo' });
    const pool = await within(card).findByRole('group', { name: /Participate in my pool/ });
    expect(within(pool).getByText('Active')).toBeTruthy();
    expect(within(pool).getByLabelText('Participate')).toHaveProperty('checked', true);
    expect(within(card).getByText('No pending requests.')).toBeTruthy();
    expect(within(card).queryByRole('button', { name: 'Reject octo' })).toBeNull();
  });

  it('rejects with an optional reason from a dialog', async () => {
    const calls = mockApi({
      'GET /me': () => ({ json: me }),
      'GET /projects/mine': () => ({ json: [project] }),
      'GET /projects/p1/participants': () => ({ json: [participant('pending')] }),
      'POST /projects/p1/participants/u2/reject': () => ({
        json: participant('rejected', { rejectionReason: 'Not yet' }).participation,
      }),
    });
    renderApp('/projects');
    const card = await screen.findByRole('article', { name: 'octo/repo' });
    fireEvent.click(await within(card).findByRole('button', { name: 'Reject alice' }));
    const dialog = await screen.findByRole('dialog', { name: 'Reject participant' });
    fireEvent.change(within(dialog).getByLabelText(/Reason/), { target: { value: ' Not yet ' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm reject' }));
    await waitFor(() =>
      expect(calls).toContainEqual({
        method: 'POST',
        path: '/projects/p1/participants/u2/reject',
        body: { reason: 'Not yet' },
      }),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('flags re-applications and lets the owner undo a rejection', async () => {
    const bob = { id: 'u3', login: 'bob' };
    const calls = mockApi({
      'GET /me': () => ({ json: me }),
      'GET /projects/mine': () => ({ json: [{ ...project, requireParticipantApproval: false }] }),
      'GET /projects/p1/participants': () => ({
        json: [
          participant('pending', {
            rejectionReason: 'too busy',
            previouslyRejectedAt: '2026-10-01T00:00:00Z',
          }),
          participant('rejected', { rejectionReason: 'spam' }, bob),
        ],
      }),
      'POST /projects/p1/participants/u3/undo-rejection': () => ({
        json: participant('active', {}, bob).participation,
      }),
    });
    renderApp('/projects');
    const card = await screen.findByRole('article', { name: 'octo/repo' });
    expect(await within(card).findByText('previously rejected (too busy)')).toBeTruthy();
    expect(within(card).getByText(/Approval is off/)).toBeTruthy();
    expect(within(card).getByRole('heading', { name: 'Rejected members' })).toBeTruthy();
    expect(within(card).getByText('spam')).toBeTruthy();
    fireEvent.click(within(card).getByRole('button', { name: 'Undo rejection of bob: approve' }));
    await waitFor(() =>
      expect(calls).toContainEqual({
        method: 'POST',
        path: '/projects/p1/participants/u3/undo-rejection',
        body: { to: 'approved' },
      }),
    );
    expect(
      within(card).getByRole('button', { name: 'Undo rejection of bob: back to pending' }),
    ).toBeTruthy();
  });
});
