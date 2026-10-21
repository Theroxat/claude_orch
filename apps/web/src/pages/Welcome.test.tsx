import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { me, mockApi, renderApp, project } from '../test/helpers';

const IDS = [
  'github_app_installed',
  'project_added',
  'participation_set',
  'agent_connected',
  'claude_connected',
  'mcp_connected',
];
type S = 'done' | 'todo' | 'unknown';
const onboarding = (states: S[]) => ({
  steps: IDS.map((id, i) => ({ id, state: states[i]!, done: states[i] === 'done' })),
});
const ALL_TODO: S[] = ['todo', 'todo', 'todo', 'todo', 'todo', 'todo'];
const CMD = 'claude mcp add --transport http --scope user orch https://orch.example.com/mcp';
const INSTALL = 'curl -fsSL https://orch.example.com/install.sh | sh -s -- --token T0K';
const discoverItem = {
  project: project,
  owner: { githubLogin: 'alice', avatarUrl: null },
  myRole: 'submitter',
  myParticipation: null,
};

function routes(
  get: () => S[],
  extra: Record<string, () => { json?: unknown; status?: number }> = {},
) {
  return {
    'GET /me': () => ({ json: me }),
    'GET /onboarding': () => ({ json: onboarding(get()) }),
    'GET /projects/mine': () => ({ json: [] }),
    'GET /projects/discover': () => ({ json: [discoverItem] }),
    'GET /repos/available': () => ({ json: [] }),
    'GET /github/install-url': () => ({
      json: { url: 'https://github.com/apps/x/installations/new' },
    }),
    'GET /agents/mine': () => ({ json: [] }),
    'GET /mcp/setup': () => ({
      json: { mcpUrl: 'https://orch.example.com/mcp', mcpAddCommandOAuth: CMD },
    }),
    'POST /agents/enrollment-tokens': () => ({
      json: {
        token: 'T0K',
        installCommand: INSTALL,
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
      },
    }),
    'POST /onboarding/complete': () => ({ json: { ...me, onboardingCompletedAt: 'now' } }),
    'POST /onboarding/dismiss': () => ({ json: { ...me, onboardingDismissedAt: 'now' } }),
    ...extra,
  };
}

const title = () => screen.findByRole('heading', { level: 1 });
const click = (name: string | RegExp) => fireEvent.click(screen.getByRole('button', { name }));

afterEach(() => vi.useRealTimers());

describe('setup wizard', () => {
  it('shows the cannot-join explanation in the wizard', async () => {
    mockApi(
      routes(() => ALL_TODO, {
        'GET /projects/discover': () => ({
          json: [
            {
              ...discoverItem,
              canParticipate: false,
              cannotParticipateReason: 'NOT_GITHUB_COLLABORATOR',
            },
          ],
        }),
      }),
    );
    renderApp('/welcome');
    await screen.findByRole('button', { name: "I'm joining a teammate's project" });
    click("I'm joining a teammate's project");
    expect(
      await screen.findByText(/Only GitHub collaborators of octo\/repo can join/),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
  });

  it('shows step 1 of 7 and branches on the welcome choice', async () => {
    mockApi(routes(() => ALL_TODO));
    renderApp('/welcome');
    expect((await title()).textContent).toBe('Welcome to orch');
    expect(screen.getByText('Step 1 of 7')).toBeTruthy();
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('1');
    click("I'm joining a teammate's project");
    expect((await title()).textContent).toBe('Join a project');
    expect(screen.getByText('Step 2 of 7')).toBeTruthy();
    expect(await screen.findByRole('article', { name: 'octo/repo' })).toBeTruthy();
    click('Skip for now');
    expect((await title()).textContent).toBe('Add your repository');
    expect(screen.getByText('Step 3 of 7')).toBeTruthy();
  });

  it('owner path shows the repository step first, with the install button', async () => {
    mockApi(routes(() => ALL_TODO));
    renderApp('/welcome');
    await title();
    click('I want to add my own repository');
    expect((await title()).textContent).toBe('Add your repository');
    const link = await screen.findByRole('link', { name: 'Install the GitHub App' });
    expect(link.getAttribute('target')).toBe('_blank');
  });

  it('offers the owner an optional participation in their own pool once the repo is added', async () => {
    const calls = mockApi(
      routes(() => ['done', 'done', 'todo', 'todo', 'todo', 'todo'], {
        'GET /projects/mine': () => ({ json: [project] }),
        'GET /projects/p1/participants': () => ({ json: [] }),
        'PUT /projects/p1/participation': () => ({
          json: {
            id: 'pa1',
            projectId: 'p1',
            userId: 'u1',
            participating: true,
            budgetPercent: 20,
            mode: 'approval',
            status: 'active',
            approvedAt: 'now',
          },
        }),
      }),
    );
    renderApp('/welcome');
    await title();
    click('I want to add my own repository');
    expect((await title()).textContent).toBe('Add your repository');
    const pool = await screen.findByRole('group', {
      name: /Optional: lend your own capacity to octo\/repo/,
    });
    fireEvent.click(within(pool).getByLabelText('Participate'));
    fireEvent.click(within(pool).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(calls).toContainEqual({
        method: 'PUT',
        path: '/projects/p1/participation',
        body: { participating: true, budgetPercent: 20, mode: 'approval' },
      }),
    );
  });

  it('moves focus to the step title and supports Back', async () => {
    mockApi(routes(() => ALL_TODO));
    renderApp('/welcome');
    await title();
    click('I want to add my own repository');
    const h = await title();
    await waitFor(() => expect(document.activeElement).toBe(h));
    click('Back');
    expect((await title()).textContent).toBe('Welcome to orch');
    expect((screen.getByRole('button', { name: 'Back' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows the install command and auto-advances when the machine connects', async () => {
    let state: S[] = ['done', 'done', 'done', 'todo', 'todo', 'todo'];
    mockApi(
      routes(() => state, {
        'GET /agents/mine': () => ({
          json: [
            {
              id: 'a1',
              machineName: 'laptop',
              version: '0.3.0',
              connected: true,
              lastSeenAt: null,
              lastUsage: null,
              paused: false,
              revokedAt: null,
            },
          ],
        }),
      }),
    );
    renderApp('/welcome');
    await title();
    click('I want to add my own repository');
    await title();
    click('Skip for now');
    await title();
    click('Skip for now');
    expect((await title()).textContent).toBe('Install your machine');
    fireEvent.click(screen.getByRole('button', { name: 'Generate install command' }));
    expect((await screen.findByTestId('install-command')).textContent).toBe(INSTALL);
    expect(screen.getByText(/needs Docker/)).toBeTruthy();
    expect(screen.getByRole('status').textContent).toContain('Waiting for your machine to connect');
    state = ['done', 'done', 'done', 'done', 'todo', 'todo'];
    fireEvent.focus(window);
    window.dispatchEvent(new Event('visibilitychange'));
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toContain('Connected: laptop'),
    );
    await waitFor(
      async () => expect((await title()).textContent).toBe('Connect Claude on your machine'),
      { timeout: 4000 },
    );
    expect(screen.getByText('orch login')).toBeTruthy();
  });

  it('shows the MCP command, example prompt, and a done step ends with the cheat sheet', async () => {
    const calls = mockApi(routes(() => ['done', 'done', 'done', 'done', 'done', 'todo']));
    renderApp('/welcome');
    await title();
    click('I want to add my own repository');
    for (let i = 0; i < 4; i++) {
      await title();
      click('Skip for now');
    }
    expect((await title()).textContent).toBe('Connect Claude Code (MCP)');
    expect((await screen.findByTestId('mcp-oauth-command')).textContent).toBe(CMD);
    expect(screen.getByText(/Split this feature into small tasks/)).toBeTruthy();
    click('Skip for now');
    expect((await title()).textContent).toBe("You're all set");
    expect(screen.getByText('Step 7 of 7')).toBeTruthy();
    for (const n of ['Backlog', 'Pool', 'Projects'])
      expect(screen.getByRole('link', { name: n })).toBeTruthy();
    expect(screen.getByText('orch attach <n>')).toBeTruthy();
    await waitFor(() =>
      expect(calls.some((c) => c.method === 'POST' && c.path === '/onboarding/complete')).toBe(
        true,
      ),
    );
  });

  it('marks steps that are already done and lets the user continue', async () => {
    mockApi(routes(() => ['done', 'done', 'done', 'done', 'done', 'done']));
    renderApp('/welcome');
    await title();
    click("I'm joining a teammate's project");
    await title();
    await screen.findByText('Already done. You can continue.');
    click('Continue');
    expect((await title()).textContent).toBe('Add your repository');
  });

  it('Exit setup dismisses server-side and leaves the wizard', async () => {
    const calls = mockApi(routes(() => ALL_TODO));
    renderApp('/welcome');
    await title();
    click('Exit setup');
    await waitFor(() =>
      expect(calls.some((c) => c.method === 'POST' && c.path === '/onboarding/dismiss')).toBe(true),
    );
    expect(await screen.findByRole('heading', { name: 'My projects' })).toBeTruthy();
  });
});

describe('first-visit redirect', () => {
  it('redirects once to /welcome and records it', async () => {
    const calls = mockApi(routes(() => ALL_TODO));
    renderApp('/projects');
    await waitFor(() =>
      expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Welcome to orch'),
    );
    await waitFor(() =>
      expect(calls.filter((c) => c.path === '/onboarding/dismiss')).toHaveLength(1),
    );
    // Leaving the wizard afterwards does not bounce back.
    click('Exit setup');
    expect(await screen.findByRole('heading', { name: 'My projects' })).toBeTruthy();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(screen.queryByRole('heading', { name: 'Welcome to orch' })).toBeNull();
    expect(within(document.body).getByRole('link', { name: 'Setup wizard' })).toBeTruthy();
  });

  it.each([
    ['dismissed', { onboardingDismissedAt: '2026-01-01T00:00:00Z' }],
    ['completed', { onboardingCompletedAt: '2026-01-01T00:00:00Z' }],
  ])('does not redirect when already %s', async (_n, extra) => {
    mockApi(routes(() => ALL_TODO, { 'GET /me': () => ({ json: { ...me, ...extra } }) }));
    renderApp('/projects');
    expect(await screen.findByRole('heading', { name: 'My projects' })).toBeTruthy();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(screen.queryByRole('heading', { name: 'Welcome to orch' })).toBeNull();
  });

  it('does not redirect when everything is already set up', async () => {
    mockApi(routes(() => ['done', 'done', 'done', 'done', 'done', 'done']));
    renderApp('/projects');
    expect(await screen.findByRole('heading', { name: 'My projects' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Welcome to orch' })).toBeNull();
  });

  it('Getting started card links to the wizard', async () => {
    mockApi(
      routes(() => ALL_TODO, {
        'GET /me': () => ({ json: { ...me, onboardingDismissedAt: 'x' } }),
      }),
    );
    renderApp('/projects');
    const card = await screen.findByRole('region', { name: 'Getting started' });
    expect(
      within(card).getByRole('link', { name: 'Open the setup wizard' }).getAttribute('href'),
    ).toBe('/welcome');
  });
});
