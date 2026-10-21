import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { mockApi, me, project, renderApp } from '../test/helpers';

const item = (myParticipation: unknown) => ({
  project,
  owner: { githubLogin: 'boss', avatarUrl: null },
  myRole: 'submitter',
  myParticipation,
});
const part = (over: object) => ({
  id: 'pa1',
  projectId: 'p1',
  userId: 'u1',
  participating: true,
  budgetPercent: 30,
  mode: 'approval',
  status: 'pending',
  approvedAt: null,
  ...over,
});

describe('Discover', () => {
  it('toggles participation and submits the payload', async () => {
    const calls = mockApi({
      'GET /me': () => ({ json: me }),
      'GET /projects/discover': () => ({ json: [item(null)] }),
      'PUT /projects/p1/participation': () => ({ json: part({}) }),
    });
    renderApp('/discover');
    const card = await screen.findByRole('article', { name: 'octo/repo' });
    const toggle = within(card).getByLabelText('Participate');
    expect(toggle).toHaveProperty('checked', false);
    fireEvent.click(toggle);
    fireEvent.change(within(card).getByLabelText(/Budget \(%/), { target: { value: '40' } });
    fireEvent.click(within(card).getByLabelText(/^Auto/));
    fireEvent.click(within(card).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(calls).toContainEqual({
        method: 'PUT',
        path: '/projects/p1/participation',
        body: { participating: true, budgetPercent: 40, mode: 'auto' },
      }),
    );
  });

  it('rejects an out-of-range budget and does not submit', async () => {
    const calls = mockApi({
      'GET /me': () => ({ json: me }),
      'GET /projects/discover': () => ({ json: [item(null)] }),
    });
    renderApp('/discover');
    const card = await screen.findByRole('article', { name: 'octo/repo' });
    fireEvent.change(within(card).getByLabelText(/Budget \(%/), { target: { value: '150' } });
    expect(within(card).getByRole('alert').textContent).toMatch(/between 0 and 100/);
    expect(within(card).getByRole('button', { name: 'Save' })).toHaveProperty('disabled', true);
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
  });

  it('shows the pending owner approval state and mode explanations', async () => {
    mockApi({
      'GET /me': () => ({ json: me }),
      'GET /projects/discover': () => ({ json: [item(part({}))] }),
    });
    renderApp('/discover');
    expect(await screen.findByText('Pending owner approval')).toBeTruthy();
    expect(screen.getByText(/start on my machine without asking/)).toBeTruthy();
    expect(screen.getByText(/I approve each request/)).toBeTruthy();
  });

  it('defaults to Approval and renders option names and descriptions as separate blocks', async () => {
    mockApi({
      'GET /me': () => ({ json: me }),
      'GET /projects/discover': () => ({ json: [item(null)] }),
    });
    renderApp('/discover');
    const card = await screen.findByRole('article', { name: 'octo/repo' });
    expect(within(card).getByLabelText(/^Approval/)).toHaveProperty('checked', true);
    expect(within(card).getByLabelText(/^Auto/)).toHaveProperty('checked', false);
    expect(within(card).getByText('Auto').tagName).toBe('STRONG');
    expect(within(card).getByText('Approval').tagName).toBe('STRONG');
    expect(within(card).getByText(/start on my machine/).className).toContain('hint');
  });

  it('defaults to Approval when the stored participation is off, even if its mode is auto', async () => {
    mockApi({
      'GET /me': () => ({ json: me }),
      'GET /projects/discover': () => ({
        json: [item(part({ participating: false, mode: 'auto' }))],
      }),
    });
    renderApp('/discover');
    const card = await screen.findByRole('article', { name: 'octo/repo' });
    expect(within(card).getByLabelText(/^Approval/)).toHaveProperty('checked', true);
    expect(within(card).getByLabelText(/^Auto/)).toHaveProperty('checked', false);
  });

  it('explains instead of showing the form when the user cannot participate', async () => {
    mockApi({
      'GET /me': () => ({ json: me }),
      'GET /projects/discover': () => ({
        json: [
          {
            ...item(null),
            canParticipate: false,
            cannotParticipateReason: 'NOT_GITHUB_COLLABORATOR',
          },
        ],
      }),
    });
    renderApp('/discover');
    const card = await screen.findByRole('article', { name: 'octo/repo' });
    expect(within(card).getByRole('note').textContent).toBe(
      "Only GitHub collaborators of octo/repo can join. Ask the owner (boss) to either add you as a collaborator on GitHub, or set 'Who can participate' to 'All orch users on this server' in My Projects.",
    );
    expect(within(card).queryByRole('button', { name: 'Save' })).toBeNull();
  });
});
