import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { mockApi, me, project, renderApp, type Routes } from '../test/helpers';

const user = { id: 'u2', githubLogin: 'alice', avatarUrl: 'https://img/a.png' };

const task = (over: Record<string, unknown> = {}) => ({
  id: 't1',
  projectId: 'p1',
  projectFullName: 'octo/repo',
  issueNumber: 1,
  issueUrl: 'https://github.com/octo/repo/issues/1',
  title: 'First task',
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
  createdBy: user,
  assignee: null,
  assigneeAgentId: null,
  canEdit: false,
  canApprove: false,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  ...over,
});

type Role = 'owner' | 'submitter' | 'proposer' | 'none';
const rights = (myRole: Role) => ({
  myRole,
  canSubmit: myRole === 'owner' || myRole === 'submitter',
  canPropose: myRole !== 'none',
  canApprove: myRole === 'owner' || myRole === 'submitter',
});

/** Default access: p1 owner, p2 submitter. */
const defaultAccess = { p1: rights('owner'), p2: rights('submitter') };

const board = (
  over: Record<string, unknown[]> = {},
  access: Record<string, ReturnType<typeof rights>> = defaultAccess,
) => ({
  PROPOSED: [],
  TODO: [],
  BLOCKED: [],
  IN_PROGRESS: [],
  IN_REVIEW: [],
  DONE: [],
  ...over,
  access,
});

const project2 = { ...project, id: 'p2', fullName: 'acme/lib' };
const discoverItem = (role: string) => ({
  project: project2,
  owner: { githubLogin: 'acme', avatarUrl: null },
  myRole: role,
  myParticipation: null,
});

function base(extra: Routes = {}): Routes {
  return {
    'GET /me': () => ({ json: me }),
    'GET /projects/mine': () => ({ json: [project] }),
    'GET /projects/discover': () => ({ json: [discoverItem('submitter')] }),
    ...extra,
  };
}

describe('Backlog', () => {
  it('groups tasks by column and shows card details', async () => {
    mockApi(
      base({
        'GET /tasks': () => ({
          json: board({
            TODO: [task()],
            IN_PROGRESS: [
              task({
                id: 't2',
                issueNumber: 2,
                title: 'Running',
                status: 'IN_PROGRESS',
                size: 'L',
                model: 'OPUS',
                assignee: user,
                assigneeMachineName: 'laptop',
              }),
            ],
            IN_REVIEW: [
              task({
                id: 't3',
                issueNumber: 3,
                title: 'Reviewed',
                status: 'IN_REVIEW',
                prNumber: 9,
                prUrl: 'https://github.com/octo/repo/pull/9',
              }),
            ],
            DONE: [task({ id: 't4', issueNumber: 4, title: 'Finished', status: 'DONE' })],
          }),
        }),
      }),
    );
    renderApp('/backlog');
    const todo = await screen.findByRole('region', { name: 'To do' });
    expect(within(todo).getByText('First task')).toBeTruthy();
    expect(within(todo).getByText('orch take 1')).toBeTruthy();
    expect(within(todo).getByRole('link', { name: '#1' }).getAttribute('href')).toBe(
      'https://github.com/octo/repo/issues/1',
    );
    const prog = screen.getByRole('region', { name: 'In progress' });
    expect(within(prog).getByText('Running')).toBeTruthy();
    expect(within(prog).getByText('L')).toBeTruthy();
    expect(within(prog).getByText('opus')).toBeTruthy();
    expect(within(prog).getByText(/assigned to alice/)).toBeTruthy();
    expect(within(prog).getByText('on laptop')).toBeTruthy();
    expect(within(prog).queryByText(/ag1/)).toBeNull();
    expect(within(todo).queryByText(/^on /)).toBeNull();
    expect(within(prog).queryByText(/orch take/)).toBeNull();
    const rev = screen.getByRole('region', { name: 'In review' });
    expect(within(rev).getByRole('link', { name: 'PR #9' }).getAttribute('href')).toBe(
      'https://github.com/octo/repo/pull/9',
    );
    expect(within(screen.getByRole('region', { name: 'Done' })).getByText('Finished')).toBeTruthy();
  });

  it('filters by project', async () => {
    const calls = mockApi(
      base({
        'GET /tasks': () => ({ json: board({ TODO: [task()] }) }),
        'GET /projects/p2/tasks': () => ({
          json: board({ TODO: [task({ id: 'x', title: 'Lib task', projectId: 'p2' })] }),
        }),
      }),
    );
    renderApp('/backlog');
    await screen.findByText('First task');
    fireEvent.change(await screen.findByLabelText('Project'), { target: { value: 'p2' } });
    expect(await screen.findByText('Lib task')).toBeTruthy();
    expect(screen.queryByText('First task')).toBeNull();
    expect(calls.some((c) => c.path === '/projects/p2/tasks')).toBe(true);
  });

  it('shows the blocked badge for unmet dependencies', async () => {
    mockApi(
      base({
        'GET /tasks': () => ({
          json: board({
            BLOCKED: [
              task({
                status: 'BLOCKED',
                dependsOn: [
                  { id: 'a', issueNumber: 7, title: 'dep', status: 'IN_PROGRESS' },
                  { id: 'b', issueNumber: 8, title: 'done dep', status: 'DONE' },
                ],
              }),
            ],
          }),
        }),
      }),
    );
    renderApp('/backlog');
    const col = await screen.findByRole('region', { name: 'Blocked' });
    expect(within(col).getByText('blocked by #7')).toBeTruthy();
  });

  it('approves a proposed task when allowed', async () => {
    let approved = false;
    const calls = mockApi(
      base({
        'GET /tasks': () => ({
          json: approved
            ? board({ TODO: [task({ id: 'p' })] })
            : board({
                PROPOSED: [task({ id: 'p', status: 'PROPOSED', canApprove: true })],
              }),
        }),
        'POST /tasks/p/approve': () => {
          approved = true;
          return { json: task({ id: 'p' }) };
        },
      }),
    );
    renderApp('/backlog');
    fireEvent.click(await screen.findByRole('button', { name: 'Approve #1' }));
    await waitFor(() => expect(calls.some((c) => c.path === '/tasks/p/approve')).toBe(true));
    const todo = await screen.findByRole('region', { name: 'To do' });
    await within(todo).findByText('First task');
  });

  it('hides Approve when board.access says no', async () => {
    mockApi(
      base({
        'GET /tasks': () => ({
          json: board(
            { PROPOSED: [task({ status: 'PROPOSED', canApprove: true })] },
            { p1: rights('proposer') },
          ),
        }),
      }),
    );
    renderApp('/backlog');
    await screen.findByText('First task');
    expect(screen.queryByRole('button', { name: /Approve/ })).toBeNull();
  });

  it('imports pool issues for a project', async () => {
    const calls = mockApi(
      base({
        'GET /tasks': () => ({ json: board() }),
        'POST /projects/p1/tasks/import': () => ({
          json: { imported: [task()], alreadyImported: 2 },
        }),
      }),
    );
    renderApp('/backlog');
    fireEvent.click(
      await screen.findByRole('button', { name: /Import issues labeled `pool` \(octo\/repo\)/ }),
    );
    expect(await screen.findByText(/Imported 1 issue\(s\), 2 already imported/)).toBeTruthy();
    expect(calls.some((c) => c.method === 'POST' && c.path === '/projects/p1/tasks/import')).toBe(
      true,
    );
  });

  it('validates and submits the new task dialog', async () => {
    const calls = mockApi(
      base({
        'GET /tasks': () => ({ json: board({ TODO: [task()] }) }),
        'POST /projects/p1/tasks': () => ({ status: 201, json: task({ id: 'n', issueNumber: 5 }) }),
      }),
    );
    renderApp('/backlog');
    await screen.findByText('First task');
    fireEvent.click(screen.getByRole('button', { name: 'New task' }));
    const dialog = await screen.findByRole('dialog', { name: 'New task' });
    expect(within(dialog).queryByText(/will be created as Proposed/)).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create task' }));
    expect(within(dialog).getByText('Title is required.')).toBeTruthy();
    expect(calls.some((c) => c.method === 'POST')).toBe(false);

    fireEvent.change(within(dialog).getByLabelText('Project'), { target: { value: 'p1' } });
    fireEvent.change(within(dialog).getByLabelText('Title'), { target: { value: ' Add login ' } });
    fireEvent.change(within(dialog).getByLabelText('Description'), { target: { value: 'Do it' } });
    fireEvent.change(within(dialog).getByLabelText(/Acceptance criteria/), {
      target: { value: 'works\n\n tested ' },
    });
    fireEvent.change(within(dialog).getByLabelText('Size'), { target: { value: 'L' } });
    fireEvent.change(within(dialog).getByLabelText('Model'), { target: { value: 'OPUS' } });
    const depSelect = within(dialog).getByLabelText('Dependencies') as HTMLSelectElement;
    const opt = within(dialog).getByRole('option', { name: '#1 First task' }) as HTMLOptionElement;
    opt.selected = true;
    fireEvent.change(depSelect);
    fireEvent.change(within(dialog).getByLabelText(/Integration branch/), {
      target: { value: 'integ/x' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create task' }));
    await waitFor(() =>
      expect(calls).toContainEqual({
        method: 'POST',
        path: '/projects/p1/tasks',
        body: {
          title: 'Add login',
          body: 'Do it',
          acceptanceCriteria: ['works', 'tested'],
          size: 'L',
          model: 'OPUS',
          dependsOn: ['t1'],
          integrationBranch: 'integ/x',
        },
      }),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('tells proposers the task will be created as Proposed and hides import', async () => {
    mockApi({
      'GET /me': () => ({ json: me }),
      'GET /projects/mine': () => ({ json: [] }),
      'GET /projects/discover': () => ({ json: [discoverItem('proposer')] }),
      'GET /tasks': () => ({ json: board({}, { p2: rights('proposer') }) }),
    });
    renderApp('/backlog');
    const btn = await screen.findByRole('button', { name: 'New task' });
    await waitFor(() => expect((btn as HTMLButtonElement).disabled).toBe(false));
    expect(screen.queryByRole('button', { name: /Import issues/ })).toBeNull();
    fireEvent.click(btn);
    const dialog = await screen.findByRole('dialog', { name: 'New task' });
    expect(within(dialog).getByText(/will be created as Proposed/)).toBeTruthy();
  });

  it('shows failures, needs-attention and retries only when canRetry', async () => {
    const calls = mockApi(
      base({
        'GET /tasks': () => ({
          json: board({
            TODO: [
              task({
                failedAttempts: 2,
                lastError: 'boom happened',
                needsAttention: true,
                needsAttentionReason: 'Repo setup failed: env file .env not found',
                canRetry: true,
              }),
              task({ id: 't9', issueNumber: 9, title: 'Other', canRetry: false }),
            ],
          }),
        }),
        'POST /tasks/t1/retry': () => ({ json: task({ status: 'TODO' }) }),
      }),
    );
    renderApp('/backlog');
    const card = await screen.findByRole('article', { name: 'Task #1' });
    const line = within(card).getByText(/Failed 2 times: last error: boom happened/);
    expect(line.getAttribute('title')).toContain('boom happened');
    expect(within(card).getByText(/Repo setup failed: env file/)).toBeTruthy();
    expect(screen.getAllByRole('button', { name: /^Retry/ })).toHaveLength(1);
    fireEvent.click(within(card).getByRole('button', { name: 'Retry #1' }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === 'POST' && c.path === '/tasks/t1/retry')).toBe(true),
    );
  });

  it('lazily loads why-not-running when the disclosure opens', async () => {
    const calls = mockApi(
      base({
        'GET /tasks': () => ({ json: board({ TODO: [task()] }) }),
        'GET /tasks/t1/why-not-running': () => ({
          json: {
            taskId: 't1',
            status: 'TODO',
            taskReasons: [{ code: 'dependencies', message: 'Waiting on #5' }],
            members: [
              {
                user,
                eligible: false,
                reasons: [{ code: 'member_paused', message: 'Agents are paused' }],
              },
              { user: { ...user, id: 'u3', githubLogin: 'bob' }, eligible: true, reasons: [] },
            ],
          },
        }),
      }),
    );
    renderApp('/backlog');
    const card = await screen.findByRole('article', { name: 'Task #1' });
    expect(calls.some((c) => c.path.includes('why-not-running'))).toBe(false);
    const details = card.querySelector('details')!;
    details.open = true;
    fireEvent(details, new Event('toggle'));
    expect(await within(card).findByText('Waiting on #5')).toBeTruthy();
    expect(within(card).getByText(/@alice:/).textContent).toContain('Agents are paused');
    expect(within(card).getByText(/@bob:/).textContent).toContain('eligible');
  });

  it('explains why members cannot be listed for a project the user does not participate in', async () => {
    const notVisible = () => ({
      status: 404,
      json: { error: { code: 'not_found', message: 'Project not found' } },
    });
    mockApi(
      base({
        'GET /tasks': () => ({ json: board({ TODO: [task()] }) }),
        'GET /pool?projectId=p2': notVisible,
        'GET /pool?projectId=p1': () => ({ json: { estimate: true, members: [] } }),
      }),
    );
    renderApp('/backlog');
    await screen.findByText('First task');
    fireEvent.click(screen.getByRole('button', { name: 'New task' }));
    const dialog = await screen.findByRole('dialog', { name: 'New task' });
    fireEvent.change(within(dialog).getByLabelText('Project'), { target: { value: 'p2' } });
    fireEvent.change(within(dialog).getByLabelText('Send to'), { target: { value: 'members' } });
    const alert = await within(dialog).findByText(/do not participate in this project/);
    expect(alert.getAttribute('role')).toBe('alert');
    expect(within(dialog).queryByText('Project not found')).toBeNull();
  });
});
