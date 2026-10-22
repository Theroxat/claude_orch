import { fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { me, mockApi, renderApp } from '../test/helpers';
import { niceMax } from '../components/UsageChart';
import { formatTokens } from '../usageFormat';

const totals = (runs: number, failed: number, weighted: number) => ({
  runs,
  succeeded: runs - failed,
  failed,
  weighted,
});

function dashboard(range: '7d' | '30d' | '90d', over: Record<string, unknown> = {}) {
  const n = range === '7d' ? 7 : range === '30d' ? 30 : 90;
  const series = Array.from({ length: n }, (_, i) => ({
    day: new Date(Date.UTC(2026, 9, 22) - (n - 1 - i) * 86_400_000).toISOString().slice(0, 10),
    ...(i === n - 1 ? totals(3, 1, 12_000) : i === n - 2 ? totals(1, 0, 2_500) : totals(0, 0, 0)),
    input: null,
    output: null,
    cacheWrite: null,
    cacheRead: null,
  }));
  return {
    estimate: true,
    range,
    from: series[0]!.day,
    to: '2026-10-23T00:00:00.000Z',
    scope: 'own',
    totals: totals(4, 1, 14_500),
    tokenSplit: { input: 9_000, output: 4_000, cacheWrite: 500, cacheRead: 1_000_000 },
    series,
    members: [
      { userId: 'u1', login: 'octo', name: null, avatarUrl: null, ...totals(3, 1, 12_000) },
      { userId: 'u2', login: 'mona', name: null, avatarUrl: null, ...totals(1, 0, 2_500) },
    ],
    projects: [{ projectId: 'p1', fullName: 'octo/repo', ...totals(4, 1, 14_500) }],
    topTasks: [
      {
        taskId: 't1',
        title: 'Rewrite parser',
        issueNumber: 12,
        projectId: 'p1',
        projectFullName: 'octo/repo',
        runs: 2,
        weighted: 11_000,
      },
    ],
    budgets: [
      {
        projectId: 'p1',
        fullName: 'octo/repo',
        percent: 40,
        budget: 40_000,
        used: 38_000,
        usedFraction: 0.95,
      },
    ],
    splitRetentionDays: 30,
    ...over,
  };
}

const base = { 'GET /me': () => ({ json: me }) };

describe('Usage', () => {
  it('renders tiles, chart, budget and breakdown tables from the API', async () => {
    mockApi({
      ...base,
      'GET /usage?range=30d': () => ({ json: dashboard('30d') }),
    });
    renderApp('/usage');
    expect(await screen.findByRole('heading', { name: 'Usage' })).toBeTruthy();
    const tokens = await screen.findByRole('group', { name: 'Tokens' });
    expect(within(tokens).getByText('14.5k')).toBeTruthy();
    const runs = screen.getByRole('group', { name: 'Task runs' });
    expect(within(runs).getByText('4')).toBeTruthy();
    expect(within(runs).getByText('3 succeeded, 1 failed')).toBeTruthy();
    expect(
      within(screen.getByRole('group', { name: 'Success rate' })).getByText('75%'),
    ).toBeTruthy();

    const members = screen.getByRole('table', { name: 'Usage per member' });
    expect(within(members).getByText('octo')).toBeTruthy();
    expect(within(members).getByText('mona')).toBeTruthy();
    const projects = screen.getByRole('table', { name: 'Usage per project' });
    expect(within(projects).getByText('octo/repo')).toBeTruthy();
    expect(within(projects).getByText('14.5k')).toBeTruthy();
    expect(screen.getByText('#12 Rewrite parser')).toBeTruthy();

    const meter = screen.getByRole('meter', { name: 'Budget used by octo/repo' });
    expect(meter.getAttribute('aria-valuenow')).toBe('95');
    expect(meter.getAttribute('data-level')).toBe('stop');
    expect(screen.getByText('Near limit')).toBeTruthy();
    expect(screen.getByText('Cache read')).toBeTruthy();
  });

  it('offers the chart as a table of the same numbers', async () => {
    mockApi({ ...base, 'GET /usage?range=30d': () => ({ json: dashboard('30d') }) });
    renderApp('/usage');
    await screen.findByRole('group', { name: 'Tokens' });
    const table = screen.getByRole('table', { name: 'Weighted tokens and runs per day' });
    // 30 days plus the header row; newest day first.
    expect(within(table).getAllByRole('row')).toHaveLength(31);
    expect(within(table).getAllByRole('row')[1]!.textContent).toContain('12,000');
  });

  it('reads a day when the keyboard moves along the chart', async () => {
    mockApi({
      ...base,
      'GET /usage?range=30d': () => ({ json: dashboard('30d') }),
      'GET /usage?range=7d': () => ({ json: dashboard('7d') }),
    });
    renderApp('/usage');
    await screen.findByRole('group', { name: 'Tokens' });
    fireEvent.click(screen.getByRole('button', { name: '7 days' }));
    const chart = await screen.findByRole('group', { name: /Weighted tokens per day over 7 days/ });
    fireEvent.keyDown(chart, { key: 'End' });
    expect(screen.getByText('12k tokens, 3 runs, 1 failed')).toBeTruthy();
    fireEvent.keyDown(chart, { key: 'Escape' });
    expect(screen.getByText(/peak 12k on/)).toBeTruthy();
  });

  it('refetches when the range changes', async () => {
    const calls = mockApi({
      ...base,
      'GET /usage?range=30d': () => ({ json: dashboard('30d') }),
      'GET /usage?range=90d': () => ({
        json: dashboard('90d', { totals: totals(9, 2, 99_000) }),
      }),
    });
    renderApp('/usage');
    const pressed = (name: string) =>
      screen.getByRole('button', { name }).getAttribute('aria-pressed');
    await screen.findByRole('group', { name: 'Tokens' });
    expect(pressed('30 days')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: '90 days' }));
    expect(await screen.findByText('99k')).toBeTruthy();
    expect(pressed('90 days')).toBe('true');
    expect(pressed('30 days')).toBe('false');
    expect(calls.map((c) => c.path)).toContain('/usage?range=90d');
  });

  it('shows an empty state and hides the optional blocks', async () => {
    mockApi({
      ...base,
      'GET /usage?range=30d': () => ({
        json: dashboard('30d', {
          totals: totals(0, 0, 0),
          series: dashboard('30d').series.map((d) => ({ ...d, ...totals(0, 0, 0) })),
          members: [],
          projects: [],
          topTasks: [],
          budgets: [],
          tokenSplit: null,
        }),
      }),
    });
    renderApp('/usage');
    expect(await screen.findByText(/No finished runs in the last 30 days/)).toBeTruthy();
    expect(screen.queryByRole('meter')).toBeNull();
    expect(screen.queryByText('Cache read')).toBeNull();
    expect(screen.getAllByText('Nothing to show for this range.')).toHaveLength(2);
  });

  it('shows the error when the API fails', async () => {
    mockApi({
      ...base,
      'GET /usage?range=30d': () => ({
        status: 500,
        json: { error: { code: 'boom', message: 'Usage is unavailable' } },
      }),
    });
    renderApp('/usage');
    expect(await screen.findByText('Usage is unavailable')).toBeTruthy();
  });

  it('adds the Usage station to the rail', async () => {
    mockApi({ ...base, 'GET /usage?range=30d': () => ({ json: dashboard('30d') }) });
    renderApp('/usage');
    const link = await screen.findByRole('link', { name: 'Usage' });
    expect(link.getAttribute('href')).toBe('/usage');
    expect(link.className).toContain('active');
  });
});

describe('helpers', () => {
  it('formats compact token counts', () => {
    expect(formatTokens(950)).toBe('950');
    expect(formatTokens(12_300)).toBe('12.3k');
    expect(formatTokens(4_100_000)).toBe('4.1M');
    expect(formatTokens(1_000)).toBe('1k');
  });
  it('rounds the axis top to a readable step', () => {
    expect(niceMax(0)).toBe(1);
    expect(niceMax(12_000)).toBe(20_000);
    expect(niceMax(4_800)).toBe(5_000);
    expect(niceMax(2_300)).toBe(2_500);
  });
});
