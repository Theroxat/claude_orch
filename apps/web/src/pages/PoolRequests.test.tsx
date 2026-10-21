import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { mockApi, me, project, renderApp, type Routes } from '../test/helpers';

const iso = (ms: number) => new Date(Date.now() + ms).toISOString();

const member = (over: Record<string, unknown> = {}) => ({
  userId: 'u2',
  login: 'alice',
  avatarUrl: null,
  online: true,
  paused: false,
  usageStale: false,
  resetAt: iso(2 * 3600_000 + 5 * 60_000),
  rateLimitedUntil: null,
  projects: [
    {
      projectId: 'p1',
      fullName: 'octo/repo',
      mode: 'AUTO',
      budgetPercent: 50,
      estimatedBudget: 1000,
      estimatedMargin: 400,
      marginFraction: 0.4,
    },
  ],
  runningTasks: [
    { taskId: 't9', projectId: 'p1', issueNumber: 9, title: 'Fix it', status: 'RUNNING' },
  ],
  ...over,
});

const offer = (over: Record<string, unknown> = {}) => ({
  id: 'o1',
  kind: 'CONSENT_REQUEST',
  status: 'PENDING',
  offeredAt: '2026-01-01T00:00:00Z',
  expiresAt: iso(5 * 60_000),
  task: {
    id: 't1',
    projectId: 'p1',
    projectFullName: 'octo/repo',
    issueNumber: 12,
    issueUrl: 'https://github.com/octo/repo/issues/12',
    title: 'Add login',
    body: '',
    acceptanceCriteria: [],
    size: 'L',
    model: 'OPUS',
    createdBy: { id: 'u3', githubLogin: 'bob', avatarUrl: null },
  },
  acceptCommand: 'orch accept o1',
  ...over,
});

function base(extra: Routes = {}): Routes {
  return {
    'GET /me': () => ({ json: me }),
    'GET /projects/mine': () => ({ json: [project] }),
    'GET /projects/discover': () => ({ json: [] }),
    'GET /offers/mine': () => ({ json: [] }),
    ...extra,
  };
}

describe('Pool links', () => {
  it('links running tasks straight to GitHub', async () => {
    mockApi(
      base({
        'GET /pool': () => ({
          json: {
            estimate: true,
            members: [
              member({
                runningTasks: [
                  {
                    taskId: 't9',
                    projectId: 'p1',
                    issueNumber: 9,
                    title: 'Fix it',
                    status: 'RUNNING',
                    projectFullName: 'octo/repo',
                    issueUrl: 'https://github.com/octo/repo/issues/9',
                  },
                ],
              }),
            ],
          },
        }),
      }),
    );
    renderApp('/pool');
    const alice = await screen.findByRole('article', { name: 'Member alice' });
    const link = within(alice).getByRole('link', { name: /#9 Fix it/ });
    expect(link.getAttribute('href')).toBe('https://github.com/octo/repo/issues/9');
    expect(within(alice).getByText(/octo\/repo/, { selector: 'span.hint' })).toBeTruthy();
  });
});

describe('Pool', () => {
  it('renders members with estimate, stale and paused states', async () => {
    mockApi(
      base({
        'GET /pool': () => ({
          json: {
            estimate: true,
            members: [
              member(),
              member({
                userId: 'u3',
                login: 'carol',
                online: false,
                paused: true,
                usageStale: true,
                rateLimitedUntil: iso(30 * 60_000),
                runningTasks: [],
                projects: [
                  {
                    projectId: 'p1',
                    fullName: 'octo/repo',
                    mode: 'APPROVAL',
                    budgetPercent: 10,
                    estimatedBudget: null,
                    estimatedMargin: null,
                    marginFraction: null,
                  },
                ],
              }),
            ],
          },
        }),
      }),
    );
    renderApp('/pool');
    const alice = await screen.findByRole('article', { name: 'Member alice' });
    expect(within(alice).getByText('Online')).toBeTruthy();
    expect(within(alice).getByText('Auto')).toBeTruthy();
    expect(within(alice).getByText(/Estimate: 40% margin left/)).toBeTruthy();
    expect(within(alice).getByText(/resets in 2h [45]m/)).toBeTruthy();
    expect(within(alice).getByRole('link', { name: /#9 Fix it/ })).toBeTruthy();
    expect(within(alice).queryByText(/Usage stale/)).toBeNull();
    const carol = screen.getByRole('article', { name: 'Member carol' });
    expect(within(carol).getByText('Offline')).toBeTruthy();
    expect(within(carol).getByText('Paused')).toBeTruthy();
    expect(within(carol).getByText('Approval')).toBeTruthy();
    expect(within(carol).getByText(/Usage stale/)).toBeTruthy();
    expect(within(carol).getByText(/Rate limited/)).toBeTruthy();
    expect(within(carol).getByText(/margin unknown/)).toBeTruthy();
  });

  it('filters by project', async () => {
    const calls = mockApi(
      base({
        'GET /pool': () => ({ json: { estimate: true, members: [member()] } }),
        'GET /pool?projectId=p1': () => ({
          json: { estimate: true, members: [member({ login: 'dave', userId: 'u7' })] },
        }),
      }),
    );
    renderApp('/pool');
    await screen.findByText('alice');
    await screen.findByRole('option', { name: 'octo/repo' });
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'p1' } });
    expect(await screen.findByText('dave')).toBeTruthy();
    expect(calls.some((c) => c.path === '/pool?projectId=p1')).toBe(true);
  });
});

describe('Requests requestedBy', () => {
  it('shows requestedBy, falling back to the task creator', async () => {
    mockApi(
      base({
        'GET /offers/mine': () => ({
          json: [
            offer({ requestedBy: { githubLogin: 'dave', avatarUrl: null } }),
            offer({ id: 'o2', task: { ...offer().task, issueNumber: 13 } }),
          ],
        }),
      }),
    );
    renderApp('/requests');
    const a = await screen.findByRole('article', { name: 'Request #12' });
    expect(within(a).getByText('requested by dave')).toBeTruthy();
    const b = screen.getByRole('article', { name: 'Request #13' });
    expect(within(b).getByText('requested by bob')).toBeTruthy();
  });
});

describe('Requests', () => {
  it('lists requests and accepts', async () => {
    let accepted = false;
    const calls = mockApi(
      base({
        'GET /offers/mine': () => ({ json: accepted ? [] : [offer()] }),
        'POST /offers/o1/accept': () => {
          accepted = true;
          return { json: offer({ status: 'ACCEPTED' }) };
        },
      }),
    );
    renderApp('/requests');
    const card = await screen.findByRole('article', { name: 'Request #12' });
    expect(within(card).getByText('octo/repo')).toBeTruthy();
    expect(within(card).getByRole('link', { name: '#12' }).getAttribute('href')).toBe(
      'https://github.com/octo/repo/issues/12',
    );
    expect(within(card).getByText('Add login', { exact: false })).toBeTruthy();
    expect(within(card).getByText('L')).toBeTruthy();
    expect(within(card).getByText('opus')).toBeTruthy();
    expect(within(card).getByText(/requested by bob/)).toBeTruthy();
    expect(within(card).getByText(/Expires in [45]:\d\d/)).toBeTruthy();
    fireEvent.click(within(card).getByRole('button', { name: 'Accept' }));
    await waitFor(() => expect(calls.some((c) => c.path === '/offers/o1/accept')).toBe(true));
    expect(await screen.findByText('No pending requests.')).toBeTruthy();
  });

  it('rejects', async () => {
    const calls = mockApi(
      base({
        'GET /offers/mine': () => ({ json: [offer()] }),
        'POST /offers/o1/reject': () => ({ json: offer({ status: 'REJECTED' }) }),
      }),
    );
    renderApp('/requests');
    fireEvent.click(await screen.findByRole('button', { name: 'Reject' }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === 'POST' && c.path === '/offers/o1/reject')).toBe(true),
    );
  });

  it.each([
    ['offer_closed', /no longer available/],
    ['paused', /agent is paused/],
    ['no_agent_online', /Your machine is offline: start your agent first/],
    ['concurrency', /already running a task/],
    ['not_participating', /no longer participate/],
  ])('maps 409 %s to a friendly message', async (code, re) => {
    mockApi(
      base({
        'GET /offers/mine': () => ({ json: [offer()] }),
        'POST /offers/o1/accept': () => ({
          status: 409,
          json: { error: { code, message: 'raw server text' } },
        }),
      }),
    );
    renderApp('/requests');
    fireEvent.click(await screen.findByRole('button', { name: 'Accept' }));
    expect(await screen.findByText(re)).toBeTruthy();
    expect(screen.queryByText('raw server text')).toBeNull();
  });

  it('shows the pending count in the nav', async () => {
    mockApi(base({ 'GET /offers/mine': () => ({ json: [offer(), offer({ id: 'o2' })] }) }));
    renderApp('/projects');
    const badge = await screen.findByLabelText('2 pending requests');
    expect(badge.textContent).toBe('2');
  });

  it('hides the nav badge when nothing is pending', async () => {
    mockApi(base());
    renderApp('/projects');
    await screen.findByRole('link', { name: 'Requests' });
    expect(screen.queryByLabelText(/pending requests/)).toBeNull();
  });
});

describe('New task dispatch selector', () => {
  const task = {
    id: 'n',
    projectId: 'p1',
    projectFullName: 'octo/repo',
    issueNumber: 5,
    issueUrl: 'u',
    title: 'T',
    body: '',
    acceptanceCriteria: [],
    size: 'M',
    model: 'SONNET',
    status: 'TODO',
    dependsOn: [],
    integrationBranch: null,
    baseBranch: 'main',
    branchName: null,
    prNumber: null,
    prUrl: null,
    origin: 'PLATFORM',
    createdBy: { id: 'u1', githubLogin: 'octo', avatarUrl: null },
    assignee: null,
    assigneeAgentId: null,
    canEdit: false,
    canApprove: false,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };
  const board = (role: string) => ({
    PROPOSED: [],
    TODO: [],
    BLOCKED: [],
    IN_PROGRESS: [],
    IN_REVIEW: [],
    DONE: [],
    access: {
      p1: { myRole: role, canSubmit: true, canPropose: true, canApprove: true },
    },
  });
  const routes = (role: string) =>
    base({
      'GET /tasks': () => ({ json: board(role) }),
      'GET /pool?projectId=p1': () => ({
        json: {
          estimate: true,
          members: [member(), member({ userId: 'u3', login: 'carol' })],
          projects: [{ projectId: 'p1', fullName: 'octo/repo', isOwner: role === 'owner' }],
        },
      }),
      'POST /projects/p1/tasks': () => ({ status: 201, json: task }),
    });

  async function openDialog() {
    const btn = await screen.findByRole('button', { name: 'New task' });
    await waitFor(() => expect((btn as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(btn);
    const dialog = await screen.findByRole('dialog', { name: 'New task' });
    fireEvent.change(within(dialog).getByLabelText('Title'), { target: { value: 'T' } });
    return dialog;
  }

  it('defaults to pool (no dispatch field)', async () => {
    const calls = mockApi(routes('owner'));
    renderApp('/backlog');
    const dialog = await openDialog();
    expect((within(dialog).getByLabelText('Send to') as HTMLSelectElement).value).toBe('pool');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create task' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    expect(calls.find((c) => c.method === 'POST')?.body).not.toHaveProperty('dispatch');
  });

  it('sends selected members', async () => {
    const calls = mockApi(routes('owner'));
    renderApp('/backlog');
    const dialog = await openDialog();
    fireEvent.change(within(dialog).getByLabelText('Send to'), { target: { value: 'members' } });
    fireEvent.click(await within(dialog).findByLabelText('carol'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create task' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    expect(calls.find((c) => c.method === 'POST')?.body).toMatchObject({
      dispatch: { mode: 'members', memberIds: ['u3'] },
    });
  });

  it('offers Everyone to owners and explains it', async () => {
    const calls = mockApi(routes('owner'));
    renderApp('/backlog');
    const dialog = await openDialog();
    fireEvent.change(within(dialog).getByLabelText('Send to'), { target: { value: 'broadcast' } });
    expect(within(dialog).getByText(/starts automatically for auto-mode members/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create task' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    expect(calls.find((c) => c.method === 'POST')?.body).toMatchObject({
      dispatch: { mode: 'broadcast' },
    });
  });

  it('hides Everyone when the pool says the caller is not the owner, despite an owner board role', async () => {
    mockApi({
      ...routes('owner'),
      'GET /pool?projectId=p1': () => ({
        json: {
          estimate: true,
          members: [member()],
          projects: [{ projectId: 'p1', fullName: 'octo/repo', isOwner: false }],
        },
      }),
    });
    renderApp('/backlog');
    const dialog = await openDialog();
    await waitFor(() => expect(within(dialog).getByRole('option', { name: 'Pool' })).toBeTruthy());
    expect(within(dialog).queryByRole('option', { name: 'Everyone' })).toBeNull();
  });

  it('hides Everyone for non-owners', async () => {
    mockApi(routes('submitter'));
    renderApp('/backlog');
    const dialog = await openDialog();
    expect(within(dialog).queryByRole('option', { name: 'Everyone' })).toBeNull();
    expect(within(dialog).getByRole('option', { name: 'Specific members' })).toBeTruthy();
  });
});
