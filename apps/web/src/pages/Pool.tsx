import { useQuery } from '@tanstack/react-query';
import type { PoolMember } from '@orch/shared';
import { useState } from 'react';
import { fetchDiscover, fetchMyProjects, fetchPool } from '../api/endpoints';
import { POLL_MS, relative } from '../time';

function MemberCard({ m }: { m: PoolMember }) {
  const limited = m.rateLimitedUntil && new Date(m.rateLimitedUntil).getTime() > Date.now();
  return (
    <article className="card pool-member" aria-label={`Member ${m.login}`}>
      <div className="row between">
        <div className="row">
          {m.avatarUrl ? (
            <img className="avatar" src={m.avatarUrl} alt={m.login} />
          ) : (
            <span className="avatar" />
          )}
          <strong>{m.login}</strong>
        </div>
        <div className="row">
          <span className={`badge ${m.online ? 'ok' : ''}`}>{m.online ? 'Online' : 'Offline'}</span>
          {m.paused && <span className="badge pending">Paused</span>}
        </div>
      </div>
      {m.usageStale && (
        <p className="warning">Usage stale: no recent report, not eligible for auto requests.</p>
      )}
      {limited && m.rateLimitedUntil && (
        <p className="warning">Rate limited, retry {relative(m.rateLimitedUntil)}.</p>
      )}
      {m.resetAt && <p className="hint">Window resets {relative(m.resetAt)} (estimate)</p>}
      {m.projects.map((p) => (
        <div key={p.projectId} className="pool-project">
          <div className="row between">
            <span>{p.fullName}</span>
            <span className={`badge ${p.mode === 'AUTO' ? 'ok' : 'pending'}`}>
              {p.mode === 'AUTO' ? 'Auto' : 'Approval'}
            </span>
          </div>
          {p.marginFraction !== null ? (
            <div className="row">
              <progress
                max={100}
                value={Math.round(Math.min(1, Math.max(0, p.marginFraction)) * 100)}
                aria-label={`Estimate margin ${p.fullName}`}
              />
              <span className="hint">
                Estimate: {Math.round(p.marginFraction * 100)}% margin left
              </span>
            </div>
          ) : (
            <p className="hint">Estimate: margin unknown</p>
          )}
        </div>
      ))}
      {m.runningTasks.length > 0 && (
        <div>
          <strong>Running</strong>
          <ul className="plain">
            {m.runningTasks.map((t) => (
              <li key={t.taskId}>
                <a href={`/backlog?task=${t.taskId}`}>
                  #{t.issueNumber} {t.title}
                </a>{' '}
                <span className="badge">{t.status}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </article>
  );
}

export function Pool() {
  const [filter, setFilter] = useState('');
  const mine = useQuery({ queryKey: ['projects', 'mine'], queryFn: fetchMyProjects });
  const discover = useQuery({ queryKey: ['projects', 'discover'], queryFn: fetchDiscover });
  const pool = useQuery({
    queryKey: ['pool', filter || 'all'],
    queryFn: () => fetchPool(filter || undefined),
    refetchInterval: POLL_MS,
  });
  const names = new Map<string, string>();
  for (const p of mine.data ?? []) names.set(p.id, p.fullName);
  for (const d of discover.data ?? []) {
    if (d.myRole !== 'none') names.set(d.project.id, d.project.fullName);
  }
  return (
    <section>
      <div className="row between">
        <h1>Pool</h1>
        <label className="field">
          Project
          <select value={filter} onChange={(e) => setFilter(e.target.value)}>
            <option value="">All my projects</option>
            {[...names].map(([id, fullName]) => (
              <option key={id} value={id}>
                {fullName}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="hint">All usage figures are estimates.</p>
      {pool.isLoading && <p>Loading...</p>}
      {pool.error && <p className="error">{pool.error.message}</p>}
      {pool.data && pool.data.members.length === 0 && <p>No members in the pool yet.</p>}
      <div className="grid">
        {pool.data?.members.map((m) => (
          <MemberCard key={m.userId} m={m} />
        ))}
      </div>
    </section>
  );
}
