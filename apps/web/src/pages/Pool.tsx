import { useQuery } from '@tanstack/react-query';
import type { PoolMember } from '@orch/shared';
import { useState } from 'react';
import { fetchDiscover, fetchMyAgents, fetchMyProjects, fetchPool } from '../api/endpoints';
import { claudeCheckLine, claudeRejectedText } from '../components/AgentCard';
import { errorMessage } from '../i18n/errors.ts';
import { useRich, useT } from '../i18n/index.ts';
import { POLL_MS, relative } from '../time';
import { presenceProps, useChangeCount, usePresence, type Phase } from '../ui/presence';

function level(fraction: number): 'low' | 'mid' | 'high' {
  return fraction < 0.2 ? 'low' : fraction < 0.5 ? 'mid' : 'high';
}

function MemberCard({ m, phase }: { m: PoolMember; phase: Phase }) {
  const t = useT();
  const onlineChanges = useChangeCount(m.online);
  // Display-only freshness check; re-evaluated on every refetch.
  // eslint-disable-next-line react-hooks/purity
  const limited = m.rateLimitedUntil && new Date(m.rateLimitedUntil).getTime() > Date.now();
  // Per-machine state when the server sends it; "Paused" when every ONLINE machine is paused.
  const machines = m.machines ?? [];
  const onlineMachines = machines.filter((x) => x.online);
  const paused = m.paused || (onlineMachines.length > 0 && onlineMachines.every((x) => x.paused));
  return (
    <article
      className="card pool-member"
      aria-label={t('pool.member.aria', { login: m.login })}
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
            {m.online ? t('pool.member.online') : t('pool.member.offline')}
          </span>
          {paused && <span className="badge pending">{t('pool.member.paused')}</span>}
        </div>
      </div>
      {machines.length > 0 && (
        <ul
          className="plain machines"
          aria-label={t('pool.member.machinesAria', { login: m.login })}
        >
          {machines.map((x) => (
            <li key={x.name}>
              <span className="name">{x.name}</span>{' '}
              <span className={`badge ${x.online ? (x.paused ? 'pending' : 'ok') : 'off'}`}>
                {x.paused
                  ? x.online
                    ? t('pool.member.paused')
                    : t('pool.member.pausedOffline')
                  : x.online
                    ? t('pool.member.online')
                    : t('pool.member.offline')}
              </span>
            </li>
          ))}
        </ul>
      )}
      {m.usageStale && <p className="warning">{t('pool.member.usageStale')}</p>}
      {limited && m.rateLimitedUntil && (
        <p className="warning">
          {t('pool.member.rateLimited', { when: relative(m.rateLimitedUntil) })}
        </p>
      )}
      {m.resetAt && (
        <p className="hint">{t('pool.member.resets', { when: relative(m.resetAt) })}</p>
      )}
      {m.projects.map((p) => (
        <div key={p.projectId} className="pool-project">
          <div className="row between">
            <span className="name">{p.fullName}</span>
            <span className={`badge ${p.mode === 'AUTO' ? 'ok' : 'pending'}`}>
              {p.mode === 'AUTO' ? t('pool.member.auto') : t('pool.member.approval')}
            </span>
          </div>
          {p.marginFraction !== null ? (
            <div className="gauge">
              <progress
                data-level={level(p.marginFraction)}
                max={100}
                value={Math.round(Math.min(1, Math.max(0, p.marginFraction)) * 100)}
                aria-label={t('pool.member.marginAria', { name: p.fullName })}
              />
              <span className="hint">
                {t('pool.member.margin', { percent: Math.round(p.marginFraction * 100) })}
              </span>
            </div>
          ) : (
            <p className="hint">{t('pool.member.marginUnknown')}</p>
          )}
        </div>
      ))}
      {m.runningTasks.length > 0 && (
        <div className="running">
          <strong>{t('pool.member.running')}</strong>
          <ul className="plain">
            {m.runningTasks.map((rt) => (
              <li key={rt.taskId}>
                {rt.projectFullName && <span className="hint">{rt.projectFullName} </span>}
                {rt.issueUrl ? (
                  <a href={rt.issueUrl} target="_blank" rel="noreferrer">
                    #{rt.issueNumber} {rt.title}
                  </a>
                ) : (
                  <a href={`/backlog?task=${rt.taskId}`}>
                    #{rt.issueNumber} {rt.title}
                  </a>
                )}{' '}
                <span className="badge ok">{t(`pool.offerStatus.${rt.status}`)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </article>
  );
}

export function Pool() {
  const t = useT();
  const rich = useRich();
  const [filter, setFilter] = useState('');
  const mine = useQuery({ queryKey: ['projects', 'mine'], queryFn: fetchMyProjects });
  const discover = useQuery({ queryKey: ['projects', 'discover'], queryFn: fetchDiscover });
  const pool = useQuery({
    queryKey: ['pool', filter || 'all'],
    queryFn: () => fetchPool(filter || undefined),
    refetchInterval: POLL_MS,
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
          <h1>{t('pool.title')}</h1>
          <p className="lede">{t('pool.lede')}</p>
        </div>
        <label className="field inline">
          {t('pool.project')}
          <select value={filter} onChange={(e) => setFilter(e.target.value)}>
            <option value="">{t('pool.allProjects')}</option>
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
          {claudeRejectedText(a, <> {t('pool.expired.onMachine', { machine: a.machineName })}</>)}.{' '}
          {t('pool.expired.noTask')}
        </p>
      ))}
      {(agents.data ?? [])
        .filter((a) => !a.revokedAt && a.claudeAuthValid !== false && a.claudeAuthCheckedAt)
        .map((a) => (
          <p key={a.id} className="hint">
            {rich('pool.machineLine', {}, { machine: a.machineName, line: claudeCheckLine(a) })}
          </p>
        ))}
      {pool.isLoading && <p className="hint">{t('common.status.loading')}</p>}
      {pool.error && <p className="error">{errorMessage(pool.error)}</p>}
      {pool.data && pool.data.members.length === 0 && <p className="empty">{t('pool.empty')}</p>}
      <div className="pool-grid">
        {members.map(({ key, item, phase }) => (
          <MemberCard key={key} m={item} phase={phase} />
        ))}
      </div>
    </section>
  );
}
