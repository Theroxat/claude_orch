import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DISMISS_KEY } from './GettingStarted';
import { me, mockApi, renderApp } from '../test/helpers';

const IDS = [
  'github_app_installed',
  'project_added',
  'participation_set',
  'agent_connected',
  'claude_connected',
  'mcp_connected',
];
const onboarding = (states: Array<'done' | 'todo' | 'unknown'>) => ({
  steps: IDS.map((id, i) => ({ id, state: states[i]!, done: states[i] === 'done' })),
});
const base = (states: Array<'done' | 'todo' | 'unknown'>) => ({
  'GET /me': () => ({ json: me }),
  'GET /projects/mine': () => ({ json: [] }),
  'GET /onboarding': () => ({ json: onboarding(states) }),
});

afterEach(() => {
  localStorage.clear();
  vi.useRealTimers();
});

describe('Getting started', () => {
  it('renders mixed states with checkmarks and actions only for open steps', async () => {
    mockApi(base(['done', 'done', 'todo', 'todo', 'unknown', 'todo']));
    renderApp('/projects');
    const card = await screen.findByRole('region', { name: 'Getting started' });
    expect(within(card).getAllByRole('img', { name: 'Done' })).toHaveLength(2);
    expect(within(card).getAllByRole('img', { name: 'To do' })).toHaveLength(3);
    expect(within(card).getAllByRole('img', { name: 'Unknown' })).toHaveLength(1);
    expect(within(card).queryByRole('button', { name: 'Install the GitHub App' })).toBeNull();
    expect(within(card).getByText(/The agent runs tasks/)).toBeTruthy();
    expect(within(card).queryByRole('button', { name: 'Hide' })).toBeNull();
  });

  it('shows the nav progress', async () => {
    mockApi(base(['done', 'done', 'todo', 'todo', 'unknown', 'todo']));
    renderApp('/projects');
    const pill = await screen.findByLabelText(/Getting started: 2 of 6/);
    expect(pill.textContent).toBe('2/6');
  });

  it('wires the action buttons', async () => {
    const open = vi.fn();
    vi.stubGlobal('open', open);
    mockApi({
      ...base(['todo', 'todo', 'todo', 'todo', 'todo', 'todo']),
      'GET /github/install-url': () => ({
        json: { url: 'https://github.com/apps/x/installations/new' },
      }),
      'GET /repos/available': () => ({ json: [] }),
    });
    renderApp('/projects');
    const card = await screen.findByRole('region', { name: 'Getting started' });
    fireEvent.click(within(card).getByRole('button', { name: 'Install the GitHub App' }));
    await waitFor(() =>
      expect(open).toHaveBeenCalledWith(
        'https://github.com/apps/x/installations/new',
        '_blank',
        'noopener',
      ),
    );
    expect(
      within(card).getAllByRole('link', { name: 'Join a project' })[0]!.getAttribute('href'),
    ).toBe('/discover');
    expect(
      within(card).getByRole('link', { name: 'Install your machine' }).getAttribute('href'),
    ).toBe('/my-server');
    expect(
      within(card).getByRole('link', { name: 'Connect Claude Code (MCP)' }).getAttribute('href'),
    ).toBe('/claude-code');
    fireEvent.click(within(card).getByRole('button', { name: 'Connect Claude on your machine' }));
    expect(within(card).getByText('orch login')).toBeTruthy();
    fireEvent.click(within(card).getByRole('button', { name: 'Add a repository' }));
    expect(await screen.findByRole('dialog', { name: 'Add repository' })).toBeTruthy();
  });

  it('can be dismissed once nothing is left to do, and stays dismissed', async () => {
    mockApi(base(['done', 'done', 'done', 'done', 'unknown', 'done']));
    const first = renderApp('/projects');
    const card = await screen.findByRole('region', { name: 'Getting started' });
    fireEvent.click(within(card).getByRole('button', { name: 'Hide' }));
    expect(localStorage.getItem(DISMISS_KEY)).toBe('1');
    expect(screen.queryByRole('region', { name: 'Getting started' })).toBeNull();
    first.unmount();

    renderApp('/projects');
    expect(await screen.findByRole('button', { name: 'Show getting started' })).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Getting started' })).toBeNull();
  });

  it('ignores a dismiss flag while steps are still open, and survives broken storage', async () => {
    localStorage.setItem(DISMISS_KEY, '1');
    mockApi(base(['done', 'todo', 'todo', 'todo', 'unknown', 'todo']));
    renderApp('/projects');
    expect(await screen.findByRole('region', { name: 'Getting started' })).toBeTruthy();
  });

  it('refetches on window focus', async () => {
    const calls = mockApi(base(['todo', 'todo', 'todo', 'todo', 'todo', 'todo']));
    renderApp('/projects');
    await screen.findByRole('region', { name: 'Getting started' });
    const count = () => calls.filter((c) => c.path === '/onboarding').length;
    const before = count();
    fireEvent.focus(window);
    window.dispatchEvent(new Event('visibilitychange'));
    await waitFor(() => expect(count()).toBeGreaterThan(before));
  });
});
