import { useQuery } from '@tanstack/react-query';
import type { PoolMember } from '@orch/shared';
import { useState } from 'react';
import { fetchDiscover, fetchMyAgents, fetchMyProjects, fetchPool } from '../api/endpoints';
import { poolErrorMessage } from '../poolErrors';
import { POLL_MS, relative } from '../time';
import { presenceProps, useChangeCount, usePresence, type Phase } from '../ui/presence';

function level(fraction: number): 'low' | 'mid' | 'high' {
  return fraction < 0.2 ? 'low' : fraction < 0.5 ? 'mid' : 'high';
}

function MemberCard({ m, phase }: { m: PoolMember; phase: Phase }) {
  const onlineChanges = useChangeCount(m.online);
  // Display-only freshness check; re-evaluated on every refetch.
  // eslint-disable-next-line react-hooks/purity
  const limited = m.rateLimitedUntil && new Date(m.rateLimitedUntil).getTime() > Date.now();
  return (
    <article
      className="card pool-member"
      aria-label={`Member ${m.login}`}
      {...presenceProps(phase)}
    >
      <div className="member-head">
        {m.avatarUrl ? (
          <img className="avatar large" src={m.avatarUrl} alt={m.login} />
        ) : (
          <span className="avatar large" data-initial={m.login.slice(0, 1)} />
        )}
        <strong>{m.login}</strong>
        <div className="states">
          <span
            key={onlineChanges}
            className={`badge ${m.online ? 'ok' : 'off'}`}
            data-changed={onlineChanges > 0 || undefined}
          >
            {m.online ? 'Online' : 'Offline'}
          </span>
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
            <span className="name">{p.fullName}</span>
            <span className={`badge ${p.mode === 'AUTO' ? 'ok' : 'pending'}`}>
              {p.mode === 'AUTO' ? 'Auto' : 'Approval'}
            </span>
          </div>
          {p.marginFraction !== null ? (
            <div className="gauge">
              <progress
                data-level={level(p.marginFraction)}
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
        <div className="running">
          <strong>Running</strong>
          <ul className="plain">
            {m.runningTasks.map((t) => (
              <li key={t.taskId}>
                {t.projectFullName && <span className="hint">{t.projectFullName} </span>}
                {t.issueUrl ? (
                  <a href={t.issueUrl} target="_blank" rel="noreferrer">
                    #{t.issueNumber} {t.title}
                  </a>
                ) : (
                  <a href={`/backlog?task=${t.taskId}`}>
                    #{t.issueNumber} {t.title}
                  </a>
                )}{' '}
                <span className="badge ok">{t.status}</span>
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
    retry: false,
  });
  const agents = useQuery({
    queryKey: ['agents', 'mine'],
    queryFn: fetchMyAgents,
    refetchInterval: POLL_MS,
  });
  const expired = (agents.data ?? []).filter((a) => !a.revokedAt && a.claudeAuthValid === false);
  const names = new Map<string, string>();
  for (const p of mine.data ?? []) names.set(p.id, p.fullName);
  for (const d of discover.data ?? []) {
    if (d.myRole !== 'none') names.set(d.project.id, d.project.fullName);
  }
  const members = usePresence(pool.data?.members, (m) => m.userId);
  return (
    <section>
      <header className="page-head">
        <div>
          <h1>Pool</h1>
          <p className="lede">
            Who is lending capacity right now, how much margin they have left, and what is running
            on their machines. All usage figures are estimates.
          </p>
        </div>
        <label className="field inline">
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
      </header>
      {expired.map((a) => (
        <p key={a.id} className="warning" role="alert">
          Claude login expired on {a.machineName}: run <code>orch login</code>. No task is offered
          to that machine until then.
        </p>
      ))}
      {pool.isLoading && <p className="hint">Loading...</p>}
      {pool.error && <p className="error">{poolErrorMessage(pool.error)}</p>}
      {pool.data && pool.data.members.length === 0 && (
        <p className="empty">No members in the pool yet.</p>
      )}
      <div className="pool-grid">
        {members.map(({ key, item, phase }) => (
          <MemberCard key={key} m={item} phase={phase} />
        ))}
      </div>
    </section>
  );
}
