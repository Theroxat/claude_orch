import { useQuery } from '@tanstack/react-query';
import { fetchMyAgents, fetchOutdatedCount } from '../api/endpoints';
import { AGENTS_KEY, AgentUpdateActions, updateInProgress } from './AgentUpdate';
import { CopyButton } from './CopyButton';

const FALLBACK = 'cd ~/orch && docker compose pull && docker compose up -d';

export function AgentUpdateBanner() {
  const count =
    useQuery({
      queryKey: ['agents', 'outdated-count'],
      queryFn: fetchOutdatedCount,
      refetchInterval: 30_000,
    }).data?.count ?? 0;
  const agents = useQuery({
    queryKey: AGENTS_KEY,
    queryFn: fetchMyAgents,
    enabled: count > 0,
    refetchInterval: (q) => (q.state.data?.some(updateInProgress) ? 3_000 : 15_000),
  });
  const outdated = (agents.data ?? []).filter((a) => !a.revokedAt && a.updateAvailable);
  if (count === 0 || outdated.length === 0) return null;
  return (
    <section className="update-banner" aria-label="Agent update">
      {outdated.map((a) => (
        <div key={a.id} className="update-banner-item">
          <p>
            Your agent on <strong>{a.machineName}</strong> is out of date (v{a.version ?? '?'} → v
            {a.latestAgentVersion})
          </p>
          <AgentUpdateActions agent={a} />
        </div>
      ))}
      <details>
        <summary>How to update manually</summary>
        <div className="row">
          <code>orch update</code>
          <CopyButton text="orch update" />
        </div>
        <p className="hint">If that fails:</p>
        <div className="row">
          <code>{FALLBACK}</code>
          <CopyButton text={FALLBACK} />
        </div>
      </details>
    </section>
  );
}
