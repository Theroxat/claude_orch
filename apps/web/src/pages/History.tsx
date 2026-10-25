import { keepPreviousData, useInfiniteQuery } from '@tanstack/react-query';
import type { FailureClass, HistoryItem, HistoryStatus, TaskUser } from '@orch/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { fetchHistory } from '../api/endpoints';
import { errorMessage } from '../i18n/errors.ts';
import { formatDate, formatNumber } from '../i18n/format.ts';
import { t as tg, useRich, useT, type MessageKey } from '../i18n/index.ts';
import { Icon } from '../ui/Icon';

const STATUS_LABEL = {
  DONE: 'history.status.DONE',
  IN_REVIEW: 'history.status.IN_REVIEW',
  IN_PROGRESS: 'history.status.IN_PROGRESS',
  TODO: 'history.status.TODO',
  CANCELLED: 'history.status.CANCELLED',
} as const satisfies Record<HistoryStatus, MessageKey>;
const STATUSES = (Object.keys(STATUS_LABEL) as HistoryStatus[]).map((value) => ({ value }));

const MODELS = [
  { value: 'SONNET', label: 'Sonnet' },
  { value: 'OPUS', label: 'Opus' },
];

const FAILURE_LABEL = {
  env: 'history.failure.env',
  claude_auth: 'history.failure.claude_auth',
  rate_limited: 'history.failure.rate_limited',
  timeout: 'history.failure.timeout',
  task: 'history.failure.task',
} as const satisfies Record<FailureClass, MessageKey>;

const COLUMNS = {
  status: 'history.columns.status',
  task: 'history.columns.task',
  runs: 'history.columns.runs',
  duration: 'history.columns.duration',
  tokens: 'history.columns.tokens',
  people: 'history.columns.people',
  created: 'history.columns.created',
} as const satisfies Record<string, MessageKey>;

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
  if (ms < 60_000)
    return tg('history.duration.seconds', { n: String(Math.max(1, Math.round(ms / 1000))) });
  const m = Math.round(ms / 60_000);
  if (m < 60) return tg('history.duration.minutes', { n: String(m) });
  const h = Math.floor(m / 60);
  return m % 60 === 0
    ? tg('history.duration.hours', { n: String(h) })
    : tg('history.duration.hoursMinutes', { h: String(h), m: String(m % 60).padStart(2, '0') });
}

export function formatTokens(n: number | null): string {
  if (n === null) return '-';
  if (n < 1000) return String(n);
  if (n < 1_000_000) {
    const k = formatNumber(n / 1000, {
      maximumFractionDigits: n < 10_000 ? 1 : 0,
      useGrouping: false,
    });
    return tg('history.tokens.thousands', { n: k });
  }
  const mil = formatNumber(n / 1_000_000, {
    maximumFractionDigits: n < 10_000_000 ? 2 : 1,
    useGrouping: false,
  });
  return tg('history.tokens.millions', { n: mil });
}

const formatDay = (iso: string) =>
  formatDate(iso, { day: 'numeric', month: 'short', year: 'numeric' });

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
  const t = useT();
  const rich = useRich();
  const share = item.durationMs && maxDuration > 0 ? item.durationMs / maxDuration : 0;
  const same = item.executor?.id === item.createdBy.id;
  return (
    <tr className="history-row" data-status={item.status}>
      <td className="h-status" data-label={t(COLUMNS.status)}>
        <span className="status-mark">
          <span className="lamp" aria-hidden="true" />
          {t(STATUS_LABEL[item.status])}
        </span>
      </td>
      <td className="h-task" data-label={t(COLUMNS.task)}>
        <span className="h-title">{item.title}</span>
        <span className="h-refs">
          <span className="h-repo">{item.projectFullName}</span>
          <a href={item.issueUrl} target="_blank" rel="noopener noreferrer">
            #{item.issueNumber}
            <span className="sr-only"> {t('history.issueOnGithub')}</span>
          </a>
          {item.prUrl && item.prNumber !== null && (
            <a href={item.prUrl} target="_blank" rel="noopener noreferrer">
              PR #{item.prNumber}
              <span className="sr-only"> {t('history.prOnGithub')}</span>
            </a>
          )}
          <span className="tag">{item.model === 'OPUS' ? 'opus' : 'sonnet'}</span>
          <span className="tag">{item.size}</span>
        </span>
      </td>
      <td className="h-runs" data-label={t(COLUMNS.runs)}>
        <span>{t('history.runs', { count: item.attempts })}</span>
        {item.lastFailureClass && (
          <span className="badge stop" title={t('history.lastFailureClass')}>
            {t(FAILURE_LABEL[item.lastFailureClass])}
          </span>
        )}
      </td>
      <td className="h-time" data-label={t(COLUMNS.duration)}>
        <span className="num">{formatDuration(item.durationMs)}</span>
        <span className="track" aria-hidden="true">
          <span style={{ width: `${Math.max(share, item.durationMs ? 0.04 : 0) * 100}%` }} />
        </span>
      </td>
      <td className="h-tokens num" data-label={t(COLUMNS.tokens)}>
        {formatTokens(item.tokens)}
      </td>
      <td className="h-people" data-label={t(COLUMNS.people)}>
        <Person user={item.createdBy} />
        {item.executor && !same && (
          <span className="ran-by">
            {rich('history.ranBy', {}, { person: <Person user={item.executor} /> })}
          </span>
        )}
      </td>
      <td className="h-date" data-label={t(COLUMNS.created)}>
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
  const t = useT();
  const rich = useRich();
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
          <h1>{t('history.title')}</h1>
          <p className="lede">{t('history.lede')}</p>
        </div>
      </header>

      <form
        className="history-filters"
        role="search"
        aria-label={t('history.filters.label')}
        onSubmit={(e) => e.preventDefault()}
      >
        <label className="field history-search">
          {t('history.filters.search')}
          <input
            type="search"
            value={text}
            placeholder={t('history.filters.searchPlaceholder')}
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
          {open ? t('history.filters.hide') : t('history.filters.more')}
          {activeCount > 0 && <span className="tag">{activeCount}</span>}
        </button>
        <div id="history-more-filters" className="history-more-filters" data-open={open}>
          <fieldset className="chips">
            <legend>{t('history.filters.status')}</legend>
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
                {t(STATUS_LABEL[s.value])}
              </button>
            ))}
          </fieldset>
          <fieldset className="chips">
            <legend>{t('history.filters.model')}</legend>
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
              {t('history.filters.project')}
              <select
                value={picked('project')[0] ?? ''}
                onChange={(e) =>
                  update((n) => {
                    n.delete('project');
                    if (e.target.value) n.append('project', e.target.value);
                  })
                }
              >
                <option value="">{t('history.filters.allProjects')}</option>
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
              {t('history.filters.createdBy')}
              <select
                value={filters.get('creator') ?? ''}
                onChange={(e) => setOne('creator', e.target.value)}
              >
                <option value="">{t('history.filters.anyone')}</option>
                {withCurrent(peopleOptions, filters.get('creator')).map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              {t('history.filters.runBy')}
              <select
                value={filters.get('executor') ?? ''}
                onChange={(e) => setOne('executor', e.target.value)}
              >
                <option value="">{t('history.filters.anyone')}</option>
                {withCurrent(peopleOptions, filters.get('executor')).map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              {t('history.filters.from')}
              <input
                type="date"
                value={filters.get('from') ?? ''}
                max={filters.get('to') ?? undefined}
                onChange={(e) => setOne('from', e.target.value)}
              />
            </label>
            <label className="field">
              {t('history.filters.until')}
              <input
                type="date"
                value={filters.get('to') ?? ''}
                min={filters.get('from') ?? undefined}
                onChange={(e) => setOne('to', e.target.value)}
              />
            </label>
            <button type="button" className="ghost" disabled={!active} onClick={clear}>
              {t('history.filters.clear')}
            </button>
          </div>
        </div>
      </form>

      <p className="sr-only" role="status" aria-live="polite">
        {query.isSuccess
          ? t(hasNextPage ? 'history.loadedMore' : 'history.loaded', { count: items.length })
          : ''}
      </p>

      {query.isPending && <SkeletonRows />}
      {query.isError && (
        <div className="empty" role="alert">
          <p>
            {rich(
              'history.loadError',
              { strong: (c) => <strong>{c}</strong> },
              { message: errorMessage(query.error) },
            )}
          </p>
          <button type="button" onClick={() => void query.refetch()}>
            {t('common.actions.retry')}
          </button>
        </div>
      )}
      {query.isSuccess && items.length === 0 && (
        <div className="empty">
          {active ? (
            <>
              <p>{rich('history.noMatch', { strong: (c) => <strong>{c}</strong> })}</p>
              <button type="button" onClick={clear}>
                {t('history.filters.clear')}
              </button>
            </>
          ) : (
            <p>{rich('history.empty', { strong: (c) => <strong>{c}</strong> })}</p>
          )}
        </div>
      )}
      {items.length > 0 && (
        <div className="history-scroll" data-stale={query.isPlaceholderData || undefined}>
          <table className="history-table">
            <caption className="sr-only">{t('history.caption')}</caption>
            <thead>
              <tr>
                <th scope="col">{t(COLUMNS.status)}</th>
                <th scope="col">{t(COLUMNS.task)}</th>
                <th scope="col">{t(COLUMNS.runs)}</th>
                <th scope="col">{t(COLUMNS.duration)}</th>
                <th scope="col">{t(COLUMNS.tokens)}</th>
                <th scope="col">{t(COLUMNS.people)}</th>
                <th scope="col">{t(COLUMNS.created)}</th>
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
            {isFetchingNextPage ? t('common.status.loading') : t('common.actions.loadMore')}
          </button>
        </div>
      )}
      {query.isFetchNextPageError && (
        <p className="error" role="alert">
          {query.error ? errorMessage(query.error) : t('history.moreError')}
        </p>
      )}
      {query.isSuccess && !hasNextPage && items.length > 0 && (
        <p className="hint history-end">
          <Icon name="check" /> {t('history.end')}
        </p>
      )}
    </section>
  );
}
