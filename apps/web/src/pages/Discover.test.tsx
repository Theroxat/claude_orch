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
});
