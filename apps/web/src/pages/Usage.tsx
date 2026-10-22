import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import type { UsageBudgetRow, UsageDashboard, UsageRange, UsageTotals } from '@orch/shared';
import { fetchUsage } from '../api/endpoints';
import { UsageChart } from '../components/UsageChart';
import { formatDay, formatPercent, formatTokens } from '../usageFormat';
import '../usage.css';

const RANGES: Array<{ id: UsageRange; label: string }> = [
  { id: '7d', label: '7 days' },
  { id: '30d', label: '30 days' },
  { id: '90d', label: '90 days' },
];

const level = (fraction: number) => (fraction < 0.7 ? 'ok' : fraction < 0.9 ? 'warn' : 'stop');

function Tile({
  label,
  value,
  note,
  title,
}: {
  label: string;
  value: ReactNode;
  note?: ReactNode;
  title?: string;
}) {
  return (
    <div className="usage-tile" role="group" aria-label={label}>
      <span className="tile-label">{label}</span>
      <strong className="tile-value" title={title}>
        {value}
      </strong>
      {note && <span className="tile-note">{note}</span>}
    </div>
  );
}

/** A share-of-total bar for a table row. Decorative: the number beside it carries the value. */
function Share({ value, max }: { value: number; max: number }) {
  return (
    <span className="share" aria-hidden="true">
      <span style={{ width: `${max > 0 ? Math.max(2, (value / max) * 100) : 0}%` }} />
    </span>
  );
}

function Person({ login, avatarUrl }: { login: string; avatarUrl: string | null }) {
  return (
    <span className="person">
      {avatarUrl ? (
        <img className="avatar small" src={avatarUrl} alt="" />
      ) : (
        <span className="avatar small" data-initial={login.slice(0, 1)} aria-hidden="true" />
      )}
      {login}
    </span>
  );
}

function Breakdown<T extends UsageTotals>({
  title,
  caption,
  head,
  rows,
  cell,
  rowKey,
}: {
  title: string;
  caption: string;
  head: string;
  rows: T[];
  cell: (r: T) => ReactNode;
  rowKey: (r: T) => string;
}) {
  const max = Math.max(0, ...rows.map((r) => r.weighted));
  return (
    <section className="usage-block" aria-labelledby={`h-${title}`}>
      <h2 id={`h-${title}`}>{title}</h2>
      {rows.length === 0 ? (
        <p className="empty">Nothing to show for this range.</p>
      ) : (
        <div className="table-wrap" tabIndex={0} role="region" aria-label={caption}>
          <table className="usage-table">
            <caption className="sr-only">{caption}</caption>
            <thead>
              <tr>
                <th scope="col">{head}</th>
                <th scope="col" className="num">
                  Runs
                </th>
                <th scope="col" className="num">
                  Failed
                </th>
                <th scope="col" className="num">
                  Tokens
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={rowKey(r)}>
                  <th scope="row">{cell(r)}</th>
                  <td className="num">{r.runs}</td>
                  <td className="num">
                    {r.failed > 0 ? r.failed : <span className="dim">0</span>}
                  </td>
                  <td className="num tokens">
                    <Share value={r.weighted} max={max} />
                    <span
                      title={`${Math.round(r.weighted).toLocaleString('en-US')} weighted tokens`}
                    >
                      {formatTokens(r.weighted)}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function Budgets({ rows }: { rows: UsageBudgetRow[] }) {
  if (rows.length === 0) return null;
  return (
    <section className="usage-block" aria-labelledby="h-budgets">
      <h2 id="h-budgets">Budget in this 5-hour window</h2>
      <p className="hint">What each project has taken from the share of capacity you gave it.</p>
      <ul className="plain budgets">
        {rows.map((b) => {
          const f = b.usedFraction;
          return (
            <li key={b.projectId}>
              <div className="row between">
                <span className="name">{b.fullName}</span>
                <span className="hint">
                  {f === null
                    ? `${b.percent}% of capacity, budget unknown`
                    : `${formatTokens(b.used)} of ${formatTokens(b.budget ?? 0)} (${b.percent}% of capacity)`}
                </span>
              </div>
              <div
                className="meter"
                role="meter"
                aria-label={`Budget used by ${b.fullName}`}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={f === null ? undefined : Math.min(100, Math.round(f * 100))}
                aria-valuetext={f === null ? 'unknown' : formatPercent(f)}
                data-level={f === null ? 'none' : level(f)}
              >
                <span style={{ width: `${Math.min(100, (f ?? 0) * 100)}%` }} />
              </div>
              <span className="meter-value">
                {f === null ? 'n/a' : formatPercent(f)}
                {f !== null && f >= 0.9 && <span className="badge stop">Near limit</span>}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function Split({ data }: { data: UsageDashboard }) {
  const s = data.tokenSplit;
  if (!s) return null;
  const rows = [
    ['Input', s.input],
    ['Output', s.output],
    ['Cache write', s.cacheWrite],
    ['Cache read', s.cacheRead],
  ] as const;
  const max = Math.max(...rows.map((r) => r[1]));
  return (
    <section className="usage-block" aria-labelledby="h-split">
      <h2 id="h-split">Token types</h2>
      <p className="hint">
        Raw counts from {data.scope === 'admin' ? 'every' : 'your'} agent
        {data.scope === 'admin' ? '' : 's'}, personal use included. Kept {data.splitRetentionDays}{' '}
        days.
      </p>
      <dl className="split">
        {rows.map(([label, v]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>
              <Share value={v} max={max} />
              <span title={`${Math.round(v).toLocaleString('en-US')} tokens`}>
                {formatTokens(v)}
              </span>
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function Skeleton() {
  return (
    <div className="usage-skeleton" role="status" aria-label="Loading usage">
      <div className="tiles">
        {[0, 1, 2, 3].map((i) => (
          <span key={i} className="sk" />
        ))}
      </div>
      <span className="sk tall" />
    </div>
  );
}

export function Usage() {
  const [range, setRange] = useState<UsageRange>('30d');
  const q = useQuery({
    queryKey: ['usage', range],
    queryFn: () => fetchUsage(range),
    placeholderData: keepPreviousData,
  });
  const d = q.data;
  const days = RANGES.find((r) => r.id === range)!.label;
  const rate = d && d.totals.runs > 0 ? d.totals.succeeded / d.totals.runs : null;
  const busiest = d?.budgets.reduce<UsageBudgetRow | null>(
    (best, b) => ((b.usedFraction ?? -1) > (best?.usedFraction ?? -1) ? b : best),
    null,
  );

  return (
    <section aria-busy={q.isFetching}>
      <header className="page-head">
        <div>
          <h1>Usage</h1>
          <p className="lede">
            Tokens and task runs{d?.scope === 'admin' ? ' across all members' : ' you can see'}:
            your own runs, plus everything that ran in projects you own. All figures are estimates.
          </p>
        </div>
        <div className="segmented" role="group" aria-label="Time range">
          {RANGES.map((r) => (
            <button
              key={r.id}
              type="button"
              className="ghost"
              aria-pressed={range === r.id}
              onClick={() => setRange(r.id)}
            >
              {r.label}
            </button>
          ))}
        </div>
      </header>

      {q.isLoading && <Skeleton />}
      {q.error && !d && <p className="error">{q.error.message}</p>}

      {d && (
        <div className="usage-body" data-stale={q.isPlaceholderData || undefined}>
          <div className="tiles">
            <Tile
              label="Tokens"
              value={formatTokens(d.totals.weighted)}
              title={`${Math.round(d.totals.weighted).toLocaleString('en-US')} weighted tokens`}
              note={`weighted, last ${days}`}
            />
            <Tile
              label="Task runs"
              value={d.totals.runs}
              note={`${d.totals.succeeded} succeeded, ${d.totals.failed} failed`}
            />
            <Tile
              label="Success rate"
              value={rate === null ? 'n/a' : formatPercent(rate)}
              note={rate === null ? 'no finished run yet' : 'of finished runs'}
            />
            <Tile
              label="Busiest budget"
              value={busiest?.usedFraction == null ? 'n/a' : formatPercent(busiest.usedFraction)}
              note={busiest ? busiest.fullName : 'you have no active participation'}
            />
          </div>

          {d.totals.runs === 0 ? (
            <p className="empty">
              <strong>No finished runs in the last {days}.</strong> Runs show up here once a task
              succeeds or fails on one of your projects. Try a longer range.
            </p>
          ) : (
            <section className="usage-block chart-block" aria-labelledby="h-chart">
              <h2 id="h-chart">Tokens per day</h2>
              <UsageChart key={range} series={d.series} />
              <details className="chart-table">
                <summary>View as a table</summary>
                <div className="table-wrap" tabIndex={0} role="region" aria-label="Daily usage">
                  <table className="usage-table">
                    <caption className="sr-only">Weighted tokens and runs per day</caption>
                    <thead>
                      <tr>
                        <th scope="col">Day</th>
                        <th scope="col" className="num">
                          Runs
                        </th>
                        <th scope="col" className="num">
                          Failed
                        </th>
                        <th scope="col" className="num">
                          Tokens
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {[...d.series].reverse().map((p) => (
                        <tr key={p.day}>
                          <th scope="row">{formatDay(p.day, true)}</th>
                          <td className="num">{p.runs}</td>
                          <td className="num">{p.failed}</td>
                          <td className="num">{Math.round(p.weighted).toLocaleString('en-US')}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </details>
            </section>
          )}

          <Budgets rows={d.budgets} />

          <div className="usage-split-grid">
            <Breakdown
              title="By project"
              caption="Usage per project"
              head="Project"
              rows={d.projects}
              rowKey={(r) => r.projectId}
              cell={(r) => <span className="name">{r.fullName}</span>}
            />
            <Breakdown
              title="By member"
              caption="Usage per member"
              head="Member"
              rows={d.members}
              rowKey={(r) => r.userId}
              cell={(r) => <Person login={r.login} avatarUrl={r.avatarUrl} />}
            />
          </div>

          {d.topTasks.length > 0 && (
            <section className="usage-block" aria-labelledby="h-top">
              <h2 id="h-top">Most expensive tasks</h2>
              <div className="table-wrap" tabIndex={0} role="region" aria-label="Top tasks">
                <table className="usage-table">
                  <caption className="sr-only">Tasks that used the most tokens</caption>
                  <thead>
                    <tr>
                      <th scope="col">Task</th>
                      <th scope="col" className="num">
                        Runs
                      </th>
                      <th scope="col" className="num">
                        Tokens
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.topTasks.map((t) => (
                      <tr key={t.taskId}>
                        <th scope="row">
                          <a href={`/backlog?task=${t.taskId}`}>
                            #{t.issueNumber} {t.title}
                          </a>
                          <span className="hint block">{t.projectFullName}</span>
                        </th>
                        <td className="num">{t.runs}</td>
                        <td className="num tokens">
                          <Share value={t.weighted} max={d.topTasks[0]!.weighted} />
                          <span>{formatTokens(t.weighted)}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          <Split data={d} />
        </div>
      )}
    </section>
  );
}
