import { useQuery } from '@tanstack/react-query';
import { fetchMyAgents, fetchOutdatedCount } from '../api/endpoints';
import { AGENTS_KEY, AgentUpdateActions, updateInProgress } from './AgentUpdate';
import { CopyButton } from './CopyButton';
import { useRich, useT } from '../i18n/index.ts';

const FALLBACK = 'cd ~/orch && docker compose pull && docker compose up -d';

export function AgentUpdateBanner() {
  const t = useT();
  const rich = useRich();
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
    <section className="update-banner" aria-label={t('layout.agentUpdate.label')}>
      {outdated.map((a) => (
        <div key={a.id} className="update-banner-item">
          <p>
            {rich(
              'layout.agentUpdate.outdated',
              { strong: (c) => <strong>{c}</strong> },
              { machine: a.machineName, from: a.version ?? '?', to: a.latestAgentVersion ?? '?' },
            )}
          </p>
          <AgentUpdateActions agent={a} />
        </div>
      ))}
      <details>
        <summary>{t('layout.agentUpdate.manual')}</summary>
        <div className="row">
          <code>orch update</code>
          <CopyButton text="orch update" />
        </div>
        <p className="hint">{t('layout.agentUpdate.ifFails')}</p>
        <div className="row">
          <code>{FALLBACK}</code>
          <CopyButton text={FALLBACK} />
        </div>
      </details>
    </section>
  );
}
