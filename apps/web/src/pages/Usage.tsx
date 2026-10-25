import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import type { UsageBudgetRow, UsageDashboard, UsageRange, UsageTotals } from '@orch/shared';
import { fetchUsage } from '../api/endpoints';
import { errorMessage } from '../i18n/errors.ts';
import { formatNumber } from '../i18n/format.ts';
import { useRich, useT, type MessageKey } from '../i18n/index.ts';
import { UsageChart } from '../components/UsageChart';
import { formatDay, formatPercent, formatTokens } from '../usageFormat';
import '../usage.css';

const RANGES: Array<{ id: UsageRange; label: MessageKey }> = [
  { id: '7d', label: 'usage.range.d7' },
  { id: '30d', label: 'usage.range.d30' },
  { id: '90d', label: 'usage.range.d90' },
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
    <span className="usage-person">
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
  const t = useT();
  const max = Math.max(0, ...rows.map((r) => r.weighted));
  const id = `h-${title.toLowerCase().replace(/\s+/g, '-')}`;
  return (
    <section className="usage-block" aria-labelledby={id}>
      <h2 id={id}>{title}</h2>
      {rows.length === 0 ? (
        <p className="empty">{t('usage.empty.range')}</p>
      ) : (
        <div className="table-wrap" tabIndex={0} role="region" aria-label={caption}>
          <table className="usage-table">
            <caption className="sr-only">{caption}</caption>
            <thead>
              <tr>
                <th scope="col">{head}</th>
                <th scope="col" className="num">
                  {t('usage.cols.runs')}
                </th>
                <th scope="col" className="num">
                  {t('usage.cols.failed')}
                </th>
                <th scope="col" className="num">
                  {t('usage.cols.tokens')}
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={rowKey(r)}>
                  <th scope="row">{cell(r)}</th>
                  <td className="num">{formatNumber(r.runs)}</td>
                  <td className="num">
                    {r.failed > 0 ? formatNumber(r.failed) : <span className="dim">0</span>}
                  </td>
                  <td className="num tokens">
                    <Share value={r.weighted} max={max} />
                    <span
                      title={t('usage.tokensTitle.weighted', { count: Math.round(r.weighted) })}
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
  const t = useT();
  if (rows.length === 0) return null;
  return (
    <section className="usage-block" aria-labelledby="h-budgets">
      <h2 id="h-budgets">{t('usage.budget.title')}</h2>
      <p className="hint">{t('usage.budget.hint')}</p>
      <ul className="plain budgets">
        {rows.map((b) => {
          const f = b.usedFraction;
          return (
            <li key={b.projectId}>
              <div className="row between">
                <span className="name">{b.fullName}</span>
                <span className="hint">
                  {f === null
                    ? t('usage.budget.unknown', { percent: b.percent })
                    : t('usage.budget.used', {
                        used: formatTokens(b.used),
                        budget: formatTokens(b.budget ?? 0),
                        percent: b.percent,
                      })}
                </span>
              </div>
              <div
                className="meter"
                role="meter"
                aria-label={t('usage.budget.meter', { name: b.fullName })}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={f === null ? undefined : Math.min(100, Math.round(f * 100))}
                aria-valuetext={f === null ? t('usage.budget.valueUnknown') : formatPercent(f)}
                data-level={f === null ? 'none' : level(f)}
              >
                <span style={{ width: `${Math.min(100, (f ?? 0) * 100)}%` }} />
              </div>
              <span className="meter-value">
                {f === null ? t('usage.na') : formatPercent(f)}
                {f !== null && f >= 0.9 && (
                  <span className="badge stop">{t('usage.budget.nearLimit')}</span>
                )}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function Split({ data }: { data: UsageDashboard }) {
  const t = useT();
  const s = data.tokenSplit;
  if (!s) return null;
  const rows = [
    ['usage.split.input', s.input],
    ['usage.split.output', s.output],
    ['usage.split.cacheWrite', s.cacheWrite],
    ['usage.split.cacheRead', s.cacheRead],
  ] as const;
  const max = Math.max(...rows.map((r) => r[1]));
  return (
    <section className="usage-block" aria-labelledby="h-split">
      <h2 id="h-split">{t('usage.split.title')}</h2>
      <p className="hint">
        {t(data.scope === 'admin' ? 'usage.split.hintAdmin' : 'usage.split.hintOwn', {
          count: data.splitRetentionDays,
        })}
      </p>
      <dl className="token-split">
        {rows.map(([label, v]) => (
          <div key={label}>
            <dt>{t(label)}</dt>
            <dd>
              <Share value={v} max={max} />
              <span title={t('usage.tokensTitle.raw', { count: Math.round(v) })}>
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
  const t = useT();
  return (
    <div className="usage-skeleton" role="status" aria-label={t('usage.loading')}>
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
  const t = useT();
  const rich = useRich();
  const [range, setRange] = useState<UsageRange>('30d');
  const q = useQuery({
    queryKey: ['usage', range],
    queryFn: () => fetchUsage(range),
    placeholderData: keepPreviousData,
  });
  const d = q.data;
  const days = t(RANGES.find((r) => r.id === range)!.label);
  const lastDays = t('usage.range.last', { days });
  const rate = d && d.totals.runs > 0 ? d.totals.succeeded / d.totals.runs : null;
  const busiest = d?.budgets.reduce<UsageBudgetRow | null>(
    (best, b) => ((b.usedFraction ?? -1) > (best?.usedFraction ?? -1) ? b : best),
    null,
  );

  return (
    <section aria-busy={q.isFetching}>
      <header className="page-head">
        <div>
          <h1>{t('usage.title')}</h1>
          <p className="lede">{t(d?.scope === 'admin' ? 'usage.lede.admin' : 'usage.lede.own')}</p>
        </div>
        <div className="segmented" role="group" aria-label={t('usage.range.label')}>
          {RANGES.map((r) => (
            <button
              key={r.id}
              type="button"
              className="ghost"
              aria-pressed={range === r.id}
              onClick={() => setRange(r.id)}
            >
              {t(r.label)}
            </button>
          ))}
        </div>
      </header>

      {q.isLoading && <Skeleton />}
      {q.error && !d && <p className="error">{errorMessage(q.error)}</p>}

      {d && (
        <div className="usage-body" data-stale={q.isPlaceholderData || undefined}>
          <div className="tiles">
            <Tile
              label={t('usage.tiles.tokens')}
              value={formatTokens(d.totals.weighted)}
              title={t('usage.tokensTitle.weighted', { count: Math.round(d.totals.weighted) })}
              note={t('usage.tiles.tokensNote', { range: lastDays })}
            />
            <Tile
              label={t('usage.tiles.runs')}
              value={formatNumber(d.totals.runs)}
              note={`${t('usage.runs.succeeded', { count: d.totals.succeeded })}, ${t('usage.runs.failed', { count: d.totals.failed })}`}
            />
            <Tile
              label={t('usage.tiles.successRate')}
              value={rate === null ? t('usage.na') : formatPercent(rate)}
              note={
                rate === null ? t('usage.tiles.successRateNone') : t('usage.tiles.successRateNote')
              }
            />
            <Tile
              label={t('usage.tiles.busiest')}
              value={
                busiest?.usedFraction == null ? t('usage.na') : formatPercent(busiest.usedFraction)
              }
              note={busiest ? busiest.fullName : t('usage.tiles.busiestNone')}
            />
          </div>

          {d.totals.runs === 0 ? (
            <p className="empty">
              {rich(
                'usage.empty.runs',
                { strong: (c) => <strong>{c}</strong> },
                { range: lastDays },
              )}
            </p>
          ) : (
            <section className="usage-block chart-block" aria-labelledby="h-chart">
              <h2 id="h-chart">{t('usage.chart.title')}</h2>
              <UsageChart key={range} series={d.series} />
              <details className="chart-table">
                <summary>{t('usage.chart.viewTable')}</summary>
                <div
                  className="table-wrap"
                  tabIndex={0}
                  role="region"
                  aria-label={t('usage.chart.dailyUsage')}
                >
                  <table className="usage-table">
                    <caption className="sr-only">{t('usage.chart.tableCaption')}</caption>
                    <thead>
                      <tr>
                        <th scope="col">{t('usage.cols.day')}</th>
                        <th scope="col" className="num">
                          {t('usage.cols.runs')}
                        </th>
                        <th scope="col" className="num">
                          {t('usage.cols.failed')}
                        </th>
                        <th scope="col" className="num">
                          {t('usage.cols.tokens')}
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {[...d.series].reverse().map((p) => (
                        <tr key={p.day}>
                          <th scope="row">{formatDay(p.day, true)}</th>
                          <td className="num">{formatNumber(p.runs)}</td>
                          <td className="num">{formatNumber(p.failed)}</td>
                          <td className="num">{formatNumber(Math.round(p.weighted))}</td>
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
              title={t('usage.byProject.title')}
              caption={t('usage.byProject.caption')}
              head={t('usage.byProject.head')}
              rows={d.projects}
              rowKey={(r) => r.projectId}
              cell={(r) => <span className="name">{r.fullName}</span>}
            />
            <Breakdown
              title={t('usage.byMember.title')}
              caption={t('usage.byMember.caption')}
              head={t('usage.byMember.head')}
              rows={d.members}
              rowKey={(r) => r.userId}
              cell={(r) => <Person login={r.login} avatarUrl={r.avatarUrl} />}
            />
          </div>

          {d.topTasks.length > 0 && (
            <section className="usage-block" aria-labelledby="h-top">
              <h2 id="h-top">{t('usage.top.title')}</h2>
              <div
                className="table-wrap"
                tabIndex={0}
                role="region"
                aria-label={t('usage.top.label')}
              >
                <table className="usage-table">
                  <caption className="sr-only">{t('usage.top.caption')}</caption>
                  <thead>
                    <tr>
                      <th scope="col">{t('usage.cols.task')}</th>
                      <th scope="col" className="num">
                        {t('usage.cols.runs')}
                      </th>
                      <th scope="col" className="num">
                        {t('usage.cols.tokens')}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.topTasks.map((task) => (
                      <tr key={task.taskId}>
                        <th scope="row">
                          <a href={`/backlog?task=${task.taskId}`}>
                            #{task.issueNumber} {task.title}
                          </a>
                          <span className="hint block">{task.projectFullName}</span>
                        </th>
                        <td className="num">{formatNumber(task.runs)}</td>
                        <td className="num tokens">
                          <Share value={task.weighted} max={d.topTasks[0]!.weighted} />
                          <span>{formatTokens(task.weighted)}</span>
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
