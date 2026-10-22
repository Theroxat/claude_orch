import { keepPreviousData, useInfiniteQuery } from '@tanstack/react-query';
import type { FailureClass, HistoryItem, HistoryStatus, TaskUser } from '@orch/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { fetchHistory } from '../api/endpoints';
import { Icon } from '../ui/Icon';

const STATUSES: { value: HistoryStatus; label: string }[] = [
  { value: 'DONE', label: 'Done' },
  { value: 'IN_REVIEW', label: 'In review' },
  { value: 'IN_PROGRESS', label: 'In progress' },
  { value: 'TODO', label: 'Back in queue' },
  { value: 'CANCELLED', label: 'Cancelled' },
];
const STATUS_LABEL = Object.fromEntries(STATUSES.map((s) => [s.value, s.label])) as Record<
  HistoryStatus,
  string
>;

const MODELS = [
  { value: 'SONNET', label: 'Sonnet' },
  { value: 'OPUS', label: 'Opus' },
];

const FAILURE_LABEL: Record<FailureClass, string> = {
  env: 'Repository setup',
  claude_auth: 'Claude login',
  rate_limited: 'Rate limit',
  timeout: 'Timeout',
  task: 'Task failed',
};

const LIST_KEYS = ['status', 'project', 'model'] as const;
const VALUE_KEYS = ['creator', 'executor', 'from', 'to', 'q'] as const;
const DEBOUNCE_MS = 300;

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_LIST = 20;
const isRealDay = (v: string) => {
  const d = new Date(`${v}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(v);
};
const ALLOWED: Record<(typeof LIST_KEYS)[number], Set<string> | null> = {
  status: new Set(STATUSES.map((s) => s.value)),
  model: new Set(MODELS.map((m) => m.value)),
  project: null,
};

/**
 * Only the keys the API knows, in a fixed order, with values it would accept: a hand-edited or
 * stale address never turns into a 400 error page. Also a stable cache key and a clean address bar.
 */
export function filtersOf(params: URLSearchParams): URLSearchParams {
  const out = new URLSearchParams();
  for (const k of LIST_KEYS) {
    const allowed = ALLOWED[k];
    const seen = new Set<string>();
    for (const v of params.getAll(k)) {
      if (!v || v.length > 64 || seen.has(v) || seen.size >= MAX_LIST) continue;
      if (allowed && !allowed.has(v)) continue;
      seen.add(v);
      out.append(k, v);
    }
  }
  for (const k of VALUE_KEYS) {
    const v = params.get(k)?.trim();
    if (!v) continue;
    if ((k === 'from' || k === 'to') && (!DAY_RE.test(v) || !isRealDay(v))) continue;
    out.set(k, k === 'q' ? v.slice(0, 200) : v.slice(0, 64));
  }
  return out;
}

export function formatDuration(ms: number | null): string {
  if (ms === null) return '-';
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s`;
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return m % 60 === 0 ? `${h}h` : `${h}h ${String(m % 60).padStart(2, '0')}m`;
}

export function formatTokens(n: number | null): string {
  if (n === null) return '-';
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0).replace(/\.0$/, '')}k`;
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 2 : 1).replace(/\.?0+$/, '')}M`;
}

const dateFmt = new Intl.DateTimeFormat('en', { day: 'numeric', month: 'short', year: 'numeric' });
const formatDay = (iso: string) => dateFmt.format(new Date(iso));

function Person({ user }: { user: TaskUser }) {
  return (
    <span className="person">
      {user.avatarUrl ? (
        <img className="avatar small" src={user.avatarUrl} alt="" loading="lazy" />
      ) : (
        <span className="avatar small" data-initial={user.githubLogin.slice(0, 1)} aria-hidden />
      )}
      {user.githubLogin}
    </span>
  );
}

function Row({ item, maxDuration }: { item: HistoryItem; maxDuration: number }) {
  const share = item.durationMs && maxDuration > 0 ? item.durationMs / maxDuration : 0;
  const same = item.executor?.id === item.createdBy.id;
  return (
    <tr className="history-row" data-status={item.status}>
      <td className="h-status" data-label="Status">
        <span className="status-mark">
          <span className="lamp" aria-hidden="true" />
          {STATUS_LABEL[item.status]}
        </span>
      </td>
      <td className="h-task" data-label="Task">
        <span className="h-title">{item.title}</span>
        <span className="h-refs">
          <span className="h-repo">{item.projectFullName}</span>
          <a href={item.issueUrl} target="_blank" rel="noopener noreferrer">
            #{item.issueNumber}
            <span className="sr-only"> issue on GitHub</span>
          </a>
          {item.prUrl && item.prNumber !== null && (
            <a href={item.prUrl} target="_blank" rel="noopener noreferrer">
              PR #{item.prNumber}
              <span className="sr-only"> on GitHub</span>
            </a>
          )}
          <span className="tag">{item.model === 'OPUS' ? 'opus' : 'sonnet'}</span>
          <span className="tag">{item.size}</span>
        </span>
      </td>
      <td className="h-runs" data-label="Runs">
        <span>
          {item.attempts} {item.attempts === 1 ? 'run' : 'runs'}
        </span>
        {item.lastFailureClass && (
          <span className="badge stop" title="Class of the last failed run">
            {FAILURE_LABEL[item.lastFailureClass]}
          </span>
        )}
      </td>
      <td className="h-time" data-label="Duration">
        <span className="num">{formatDuration(item.durationMs)}</span>
        <span className="track" aria-hidden="true">
          <span style={{ width: `${Math.max(share, item.durationMs ? 0.04 : 0) * 100}%` }} />
        </span>
      </td>
      <td className="h-tokens num" data-label="Tokens">
        {formatTokens(item.tokens)}
      </td>
      <td className="h-people" data-label="People">
        <Person user={item.createdBy} />
        {item.executor && !same && (
          <span className="ran-by">
            ran by <Person user={item.executor} />
          </span>
        )}
      </td>
      <td className="h-date" data-label="Created">
        <time dateTime={item.createdAt}>{formatDay(item.createdAt)}</time>
      </td>
    </tr>
  );
}

function SkeletonRows() {
  return (
    <ul className="history-skeleton" aria-hidden="true">
      {[0, 1, 2, 3, 4].map((i) => (
        <li key={i} />
      ))}
    </ul>
  );
}

export function History() {
  const [params, setParams] = useSearchParams();
  const filters = useMemo(() => filtersOf(params), [params]);
  const key = filters.toString();
  const q = filters.get('q') ?? '';
  const [text, setText] = useState(q);
  // The address changed from elsewhere (clear, back button): follow it, but never fight typing.
  const [seenQ, setSeenQ] = useState(q);
  if (seenQ !== q) {
    setSeenQ(q);
    if (text.trim() !== q) setText(q);
  }

  const update = useCallback(
    (change: (next: URLSearchParams) => void) =>
      setParams(
        (prev) => {
          const next = filtersOf(prev);
          change(next);
          return next;
        },
        { replace: true },
      ),
    [setParams],
  );

  // Debounced search; the URL stays the single source of truth for every other filter.
  useEffect(() => {
    if (text.trim() === q) return;
    const t = setTimeout(
      () =>
        update((n) => {
          if (text.trim()) n.set('q', text.trim());
          else n.delete('q');
        }),
      DEBOUNCE_MS,
    );
    return () => clearTimeout(t);
  }, [text, q, update]);

  const query = useInfiniteQuery({
    queryKey: ['history', key],
    queryFn: ({ pageParam }) => fetchHistory(new URLSearchParams(key), pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    placeholderData: keepPreviousData,
  });
  const items = useMemo(() => query.data?.pages.flatMap((p) => p.items) ?? [], [query.data]);
  const facets = query.data?.pages[0]?.facets;
  const maxDuration = Math.max(0, ...items.map((i) => i.durationMs ?? 0));

  const toggle = (k: (typeof LIST_KEYS)[number], v: string) =>
    update((n) => {
      const all = n.getAll(k);
      n.delete(k);
      for (const x of all.includes(v) ? all.filter((y) => y !== v) : [...all, v]) n.append(k, x);
    });
  const setOne = (k: (typeof VALUE_KEYS)[number], v: string) =>
    update((n) => {
      if (v) n.set(k, v);
      else n.delete(k);
    });
  const clear = () => {
    setText('');
    update((n) => {
      for (const k of [...n.keys()]) n.delete(k);
    });
  };
  const active = key !== '';
  const [open, setOpen] = useState(false);
  const activeCount = [...new Set(filters.keys())].filter((k) => k !== 'q').length;

  // Infinite scroll where the browser supports it; the button stays for everyone else.
  const sentinel = useRef<HTMLDivElement>(null);
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = query;
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !hasNextPage || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(
      (e) => {
        if (e.some((x) => x.isIntersecting) && !isFetchingNextPage) void fetchNextPage();
      },
      { rootMargin: '320px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage, items.length]);

  const picked = (k: 'status' | 'project' | 'model') => filters.getAll(k);
  const people = facets?.people ?? [];
  const withCurrent = (list: { value: string; label: string }[], v: string | null) =>
    v && !list.some((o) => o.value.toLowerCase() === v.toLowerCase())
      ? [...list, { value: v, label: v }]
      : list;
  const peopleOptions = people.map((p) => ({ value: p.githubLogin, label: p.githubLogin }));

  return (
    <section className="history">
      <header className="page-head">
        <div>
          <h1>History</h1>
          <p className="lede">
            Every task that has run, in the projects you can see. Filters are kept in the address,
            so you can share a view.
          </p>
        </div>
      </header>

      <form
        className="history-filters"
        role="search"
        aria-label="Filter task history"
        onSubmit={(e) => e.preventDefault()}
      >
        <label className="field history-search">
          Search
          <input
            type="search"
            value={text}
            placeholder="Title, issue number or PR number"
            onChange={(e) => setText(e.target.value)}
          />
        </label>
        <button
          type="button"
          className="ghost history-toggle"
          aria-expanded={open}
          aria-controls="history-more-filters"
          onClick={() => setOpen((o) => !o)}
        >
          {open ? 'Hide filters' : 'More filters'}
          {activeCount > 0 && <span className="tag">{activeCount}</span>}
        </button>
        <div id="history-more-filters" className="history-more-filters" data-open={open}>
          <fieldset className="chips">
            <legend>Status</legend>
            {STATUSES.map((s) => (
              <button
                key={s.value}
                type="button"
                className="chip"
                data-status={s.value}
                aria-pressed={picked('status').includes(s.value)}
                onClick={() => toggle('status', s.value)}
              >
                <span className="lamp" aria-hidden="true" />
                {s.label}
              </button>
            ))}
          </fieldset>
          <fieldset className="chips">
            <legend>Model</legend>
            {MODELS.map((m) => (
              <button
                key={m.value}
                type="button"
                className="chip"
                aria-pressed={picked('model').includes(m.value)}
                onClick={() => toggle('model', m.value)}
              >
                {m.label}
              </button>
            ))}
          </fieldset>
          <div className="history-selects">
            <label className="field">
              Project
              <select
                value={picked('project')[0] ?? ''}
                onChange={(e) =>
                  update((n) => {
                    n.delete('project');
                    if (e.target.value) n.append('project', e.target.value);
                  })
                }
              >
                <option value="">All projects</option>
                {(facets?.projects ?? []).map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.fullName}
                  </option>
                ))}
                {picked('project')[0] &&
                  !facets?.projects.some((p) => p.id === picked('project')[0]) && (
                    <option value={picked('project')[0]}>{picked('project')[0]}</option>
                  )}
              </select>
            </label>
            <label className="field">
              Created by
              <select
                value={filters.get('creator') ?? ''}
                onChange={(e) => setOne('creator', e.target.value)}
              >
                <option value="">Anyone</option>
                {withCurrent(peopleOptions, filters.get('creator')).map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              Run by
              <select
                value={filters.get('executor') ?? ''}
                onChange={(e) => setOne('executor', e.target.value)}
              >
                <option value="">Anyone</option>
                {withCurrent(peopleOptions, filters.get('executor')).map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              Created from
              <input
                type="date"
                value={filters.get('from') ?? ''}
                max={filters.get('to') ?? undefined}
                onChange={(e) => setOne('from', e.target.value)}
              />
            </label>
            <label className="field">
              Created until
              <input
                type="date"
                value={filters.get('to') ?? ''}
                min={filters.get('from') ?? undefined}
                onChange={(e) => setOne('to', e.target.value)}
              />
            </label>
            <button type="button" className="ghost" disabled={!active} onClick={clear}>
              Clear filters
            </button>
          </div>
        </div>
      </form>

      <p className="sr-only" role="status" aria-live="polite">
        {query.isSuccess
          ? `${items.length} ${items.length === 1 ? 'task' : 'tasks'} loaded${hasNextPage ? ', more available' : ''}`
          : ''}
      </p>

      {query.isPending && <SkeletonRows />}
      {query.isError && (
        <div className="empty" role="alert">
          <p>
            <strong>The history could not be loaded.</strong> {query.error.message}
          </p>
          <button type="button" onClick={() => void query.refetch()}>
            Try again
          </button>
        </div>
      )}
      {query.isSuccess && items.length === 0 && (
        <div className="empty">
          {active ? (
            <>
              <p>
                <strong>No task matches these filters.</strong> Widen the dates or remove a filter.
              </p>
              <button type="button" onClick={clear}>
                Clear filters
              </button>
            </>
          ) : (
            <p>
              <strong>Nothing has run yet.</strong> Tasks show up here once a teammate&apos;s agent
              starts them.
            </p>
          )}
        </div>
      )}
      {items.length > 0 && (
        <div className="history-scroll" data-stale={query.isPlaceholderData || undefined}>
          <table className="history-table">
            <caption className="sr-only">Task history, newest first</caption>
            <thead>
              <tr>
                <th scope="col">Status</th>
                <th scope="col">Task</th>
                <th scope="col">Runs</th>
                <th scope="col">Duration</th>
                <th scope="col">Tokens</th>
                <th scope="col">People</th>
                <th scope="col">Created</th>
              </tr>
            </thead>
            <tbody>
              {items.map((i) => (
                <Row key={i.id} item={i} maxDuration={maxDuration} />
              ))}
            </tbody>
          </table>
        </div>
      )}
      {hasNextPage && (
        <div className="history-more" ref={sentinel}>
          <button type="button" disabled={isFetchingNextPage} onClick={() => void fetchNextPage()}>
            {isFetchingNextPage ? 'Loading...' : 'Load more'}
          </button>
        </div>
      )}
      {query.isFetchNextPageError && (
        <p className="error" role="alert">
          {query.error?.message ?? 'More tasks could not be loaded.'}
        </p>
      )}
      {query.isSuccess && !hasNextPage && items.length > 0 && (
        <p className="hint history-end">
          <Icon name="check" /> That is every matching task.
        </p>
      )}
    </section>
  );
}
