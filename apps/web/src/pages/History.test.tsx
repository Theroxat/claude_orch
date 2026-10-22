import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { mockApi, me, renderApp, type Routes } from '../test/helpers';
import { filtersOf, formatDuration, formatTokens } from './History';

const alice = { id: 'u2', githubLogin: 'alice', avatarUrl: null };
const bob = { id: 'u3', githubLogin: 'bob', avatarUrl: null };

const item = (over: Record<string, unknown> = {}) => ({
  id: 't1',
  projectId: 'p1',
  projectFullName: 'octo/repo',
  issueNumber: 12,
  issueUrl: 'https://github.com/octo/repo/issues/12',
  title: 'Fix login redirect',
  status: 'DONE',
  model: 'SONNET',
  size: 'M',
  prNumber: 30,
  prUrl: 'https://github.com/octo/repo/pull/30',
  attempts: 2,
  lastFailureClass: 'timeout',
  durationMs: 75 * 60_000,
  tokens: 1_250_000,
  createdBy: alice,
  executor: bob,
  createdAt: '2026-03-01T10:00:00Z',
  finishedAt: '2026-03-01T11:15:00Z',
  ...over,
});

const facets = {
  projects: [
    { id: 'p1', fullName: 'octo/repo' },
    { id: 'p2', fullName: 'acme/lib' },
  ],
  people: [alice, bob],
};

const historyCalls = (calls: { path: string }[]) =>
  calls.filter((c) => c.path.startsWith('/tasks/history')).map((c) => c.path);

function base(extra: Routes = {}): Routes {
  return { 'GET /me': () => ({ json: me }), ...extra };
}

describe('filtersOf', () => {
  it('drops values the API would reject and caps lengths', () => {
    const f = filtersOf(
      new URLSearchParams(
        'status=DONE&status=NOPE&status=DONE&model=GPT&model=OPUS&from=yesterday&to=2026-02-31&creator=%20&q=' +
          'x'.repeat(300) +
          '&evil=1&limit=9999&cursor=zzz',
      ),
    );
    expect(f.getAll('status')).toEqual(['DONE']);
    expect(f.getAll('model')).toEqual(['OPUS']);
    expect(f.has('from')).toBe(false);
    expect(f.has('to')).toBe(false);
    expect(f.has('creator')).toBe(false);
    expect(f.get('q')).toHaveLength(200);
    expect(f.has('evil')).toBe(false);
    expect(f.has('limit')).toBe(false);
    expect(f.has('cursor')).toBe(false);
  });
  it('keeps valid dates', () => {
    expect(filtersOf(new URLSearchParams('from=2026-03-01&to=2026-03-05')).toString()).toBe(
      'from=2026-03-01&to=2026-03-05',
    );
  });
});

describe('format helpers', () => {
  it('formats durations and token counts', () => {
    expect(formatDuration(null)).toBe('-');
    expect(formatDuration(30_000)).toBe('30s');
    expect(formatDuration(12 * 60_000)).toBe('12m');
    expect(formatDuration(65 * 60_000)).toBe('1h 05m');
    expect(formatDuration(120 * 60_000)).toBe('2h');
    expect(formatTokens(null)).toBe('-');
    expect(formatTokens(950)).toBe('950');
    expect(formatTokens(1_250)).toBe('1.3k');
    expect(formatTokens(48_000)).toBe('48k');
    expect(formatTokens(1_250_000)).toBe('1.25M');
  });
});

describe('History', () => {
  it('shows a task row with links, runs, failure class and people', async () => {
    mockApi(
      base({
        'GET /tasks/history': () => ({
          json: { items: [item()], nextCursor: null, facets },
        }),
      }),
    );
    renderApp('/history');
    const row = (await screen.findByText('Fix login redirect')).closest('tr')!;
    const r = within(row);
    expect(r.getByRole('link', { name: /#12/ }).getAttribute('href')).toBe(
      'https://github.com/octo/repo/issues/12',
    );
    expect(r.getByRole('link', { name: /PR #30/ }).getAttribute('href')).toBe(
      'https://github.com/octo/repo/pull/30',
    );
    expect(r.getByText('2 runs')).toBeTruthy();
    expect(r.getByText('Timeout')).toBeTruthy();
    expect(r.getByText('1h 15m')).toBeTruthy();
    expect(r.getByText('1.25M')).toBeTruthy();
    expect(r.getByText('alice')).toBeTruthy();
    expect(r.getByText('bob')).toBeTruthy();
    expect(screen.getByText('That is every matching task.')).toBeTruthy();
    expect(screen.getByRole('navigation', { name: 'Main' }).textContent).toContain('History');
  });

  it('has a toggle for the extra filters that reflects its state', async () => {
    mockApi(
      base({
        'GET /tasks/history?status=DONE': () => ({
          json: { items: [item()], nextCursor: null, facets },
        }),
      }),
    );
    renderApp('/history?status=DONE');
    const toggle = await screen.findByRole('button', { name: /More filters/ });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.textContent).toContain('1');
    fireEvent.click(toggle);
    expect(screen.getByRole('button', { name: /Hide filters/ }).getAttribute('aria-expanded')).toBe(
      'true',
    );
  });

  it('starts from the filters in the address and sends them to the API', async () => {
    const calls = mockApi(
      base({
        'GET /tasks/history?status=DONE&project=p2&model=OPUS&creator=alice&from=2026-03-01&q=login':
          () => ({ json: { items: [item()], nextCursor: null, facets } }),
      }),
    );
    renderApp(
      '/history?q=login&from=2026-03-01&creator=alice&model=OPUS&project=p2&status=DONE&junk=1',
    );
    await screen.findByText('Fix login redirect');
    expect(historyCalls(calls)).toEqual([
      '/tasks/history?status=DONE&project=p2&model=OPUS&creator=alice&from=2026-03-01&q=login',
    ]);
    expect(screen.getByRole('button', { name: 'Done' }).getAttribute('aria-pressed')).toBe('true');
    expect((screen.getByLabelText('Search') as HTMLInputElement).value).toBe('login');
  });

  it('updates the request when a filter changes, and debounces the search', async () => {
    const calls = mockApi(
      base({
        'GET /tasks/history': () => ({ json: { items: [item()], nextCursor: null, facets } }),
        'GET /tasks/history?status=IN_REVIEW': () => ({
          json: {
            items: [item({ id: 't2', title: 'Review me', status: 'IN_REVIEW' })],
            nextCursor: null,
            facets,
          },
        }),
        'GET /tasks/history?status=IN_REVIEW&creator=bob': () => ({
          json: { items: [], nextCursor: null, facets },
        }),
        'GET /tasks/history?status=IN_REVIEW&creator=bob&q=abc': () => ({
          json: { items: [], nextCursor: null, facets },
        }),
      }),
    );
    renderApp('/history');
    await screen.findByText('Fix login redirect');

    fireEvent.click(screen.getByRole('button', { name: 'In review' }));
    await screen.findByText('Review me');
    expect(screen.getByRole('button', { name: 'In review' }).getAttribute('aria-pressed')).toBe(
      'true',
    );

    fireEvent.change(screen.getByLabelText('Created by'), { target: { value: 'bob' } });
    await screen.findByText('No task matches these filters.');

    const before = historyCalls(calls).length;
    const search = screen.getByLabelText('Search');
    fireEvent.change(search, { target: { value: 'a' } });
    fireEvent.change(search, { target: { value: 'ab' } });
    fireEvent.change(search, { target: { value: 'abc' } });
    expect(historyCalls(calls).length).toBe(before);
    await waitFor(() =>
      expect(historyCalls(calls)).toContain('/tasks/history?status=IN_REVIEW&creator=bob&q=abc'),
    );
    expect(historyCalls(calls).length).toBe(before + 1);

    fireEvent.click(screen.getAllByRole('button', { name: 'Clear filters' })[0]!);
    await screen.findByText('Fix login redirect');
    expect((search as HTMLInputElement).value).toBe('');
  });

  it('loads more with the cursor', async () => {
    const calls = mockApi(
      base({
        'GET /tasks/history': () => ({
          json: { items: [item()], nextCursor: 'c1', facets },
        }),
        'GET /tasks/history?cursor=c1': () => ({
          json: {
            items: [item({ id: 't9', title: 'Older task', issueNumber: 3 })],
            nextCursor: null,
          },
        }),
      }),
    );
    renderApp('/history');
    await screen.findByText('Fix login redirect');
    expect(screen.queryByText('Older task')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await screen.findByText('Older task');
    expect(screen.getByText('Fix login redirect')).toBeTruthy();
    expect(historyCalls(calls)).toEqual(['/tasks/history', '/tasks/history?cursor=c1']);
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
  });

  it('shows an empty state and an error with retry', async () => {
    let fail = true;
    mockApi(
      base({
        'GET /tasks/history': () =>
          fail
            ? { status: 500, json: { error: { code: 'boom', message: 'Server exploded' } } }
            : { json: { items: [], nextCursor: null, facets } },
      }),
    );
    renderApp('/history');
    expect((await screen.findByRole('alert')).textContent).toContain('Server exploded');
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByText('Nothing has run yet.');
  });
});
