import type { AgentView } from '@orch/shared';
import type { ReactNode } from 'react';
import { AgentUpdateState } from './AgentUpdate';
import { formatNumber } from '../i18n/format.ts';
import { t, useRich, useT } from '../i18n/index.ts';
import { presenceProps, useChangeCount, type Phase } from '../ui/presence';

export function relativeTime(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return t('server.time.never');
  const s = Math.round((now - new Date(iso).getTime()) / 1000);
  if (s < 10) return t('server.time.justNow');
  if (s < 60) return t('server.time.secondsAgo', { n: s });
  if (s < 3600) return t('server.time.minutesAgo', { n: Math.floor(s / 60) });
  if (s < 86400) return t('server.time.hoursAgo', { n: Math.floor(s / 3600) });
  return t('server.time.daysAgo', { n: Math.floor(s / 86400) });
}

function hhmm(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

const code = (c: ReactNode) => <code>{c}</code>;

function ClaudeRejected({
  agent,
  where,
}: {
  agent: Pick<AgentView, 'claudeAuthError'>;
  where: ReactNode;
}) {
  const rich = useRich();
  const key =
    agent.claudeAuthError === 'unauthorized'
      ? 'server.claude.rejected'
      : agent.claudeAuthError === 'no_token'
        ? 'server.claude.noToken'
        : 'server.claude.expired';
  return <>{rich(key, { code }, { where })}</>;
}

/** Copy for a refused Claude login: depends on the class of the agent's last real check. */
export function claudeRejectedText(
  agent: Pick<AgentView, 'claudeAuthError'>,
  where: ReactNode = null,
): ReactNode {
  return <ClaudeRejected agent={agent} where={where} />;
}

type CheckAgent = Pick<
  AgentView,
  'claudeAuthValid' | 'claudeAuthCheckedAt' | 'claudeAuthError' | 'claudeTokenPresent'
>;

function ClaudeCheck({ agent }: { agent: CheckAgent }) {
  const t = useT();
  const rich = useRich();
  if (agent.claudeAuthCheckedAt) {
    const when = relativeTime(agent.claudeAuthCheckedAt);
    return agent.claudeAuthError
      ? t('server.claude.couldNotVerify', { error: agent.claudeAuthError, when })
      : t('server.claude.verified', { when });
  }
  return rich(
    agent.claudeTokenPresent ? 'server.claude.notVerified' : 'server.claude.notConnected',
    { code },
  );
}

/** Non-blocking state of a login the server still considers valid; null when nothing to say. */
export function claudeCheckLine(agent: CheckAgent): ReactNode {
  if (agent.claudeAuthValid === false) return null;
  if (!agent.claudeAuthCheckedAt && typeof agent.claudeTokenPresent !== 'boolean') return null;
  return <ClaudeCheck agent={agent} />;
}

export function UsageEstimate({ usage }: { usage: AgentView['lastUsage'] }) {
  const t = useT();
  if (!usage) return <p className="hint">{t('server.usage.none')}</p>;
  const margin = usage.usedFraction == null ? null : Math.round((1 - usage.usedFraction) * 100);
  return (
    <div className="usage">
      <span className="badge">{t('server.usage.estimate')}</span>
      <span>{t('server.usage.tokens', { tokens: formatNumber(Math.round(usage.weighted)) })}</span>
      <span>
        {margin == null
          ? t('server.usage.marginUnknown')
          : t('server.usage.margin', { margin: Math.max(0, margin) })}
      </span>
      {usage.windowResetAt && (
        <span>{t('server.usage.resetsAt', { time: hhmm(usage.windowResetAt) })}</span>
      )}
      {usage.rateLimitedUntil && (
        <p className="hint">
          {t('server.usage.rateLimitedUntil', { time: hhmm(usage.rateLimitedUntil) })}
        </p>
      )}
    </div>
  );
}

export function AgentCard({
  agent,
  busy,
  onTogglePause,
  onRevoke,
  phase = 'idle',
}: {
  agent: AgentView;
  phase?: Phase;
  busy: boolean;
  onTogglePause: (agent: AgentView) => void;
  onRevoke: (agent: AgentView) => void;
}) {
  const t = useT();
  const connectedChanges = useChangeCount(agent.connected);
  return (
    <article
      className={`card agent${agent.paused ? ' paused' : ''}`}
      aria-label={agent.machineName}
      {...presenceProps(phase)}
    >
      <div className="card-head">
        <h3>{agent.machineName}</h3>
        <span
          key={connectedChanges}
          className={`badge ${agent.connected ? 'ok' : 'off'}`}
          data-changed={connectedChanges > 0 || undefined}
        >
          {agent.connected ? t('server.agent.online') : t('server.agent.offline')}
        </span>
      </div>
      <p className="agent-meta">
        <span>
          {t('server.agent.version', {
            version: agent.version ?? t('server.agent.versionUnknown'),
          })}
        </span>
        <span>{t('server.agent.lastSeen', { when: relativeTime(agent.lastSeenAt) })}</span>
      </p>
      <AgentUpdateState agent={agent} />
      {agent.claudeAuthValid === false && (
        <p className="warning" role="alert">
          {claudeRejectedText(agent)}
        </p>
      )}
      {claudeCheckLine(agent) && <p className="hint">{claudeCheckLine(agent)}</p>}
      <UsageEstimate usage={agent.lastUsage} />
      {agent.paused && (
        <div className="warning" role="status">
          {t('server.agent.pausedNotice')}
        </div>
      )}
      <div className="card-foot">
        <button
          className={`pause-toggle ${agent.paused ? 'primary' : ''}`}
          role="switch"
          aria-checked={agent.paused}
          aria-label={t('server.agent.pauseLabel', { machine: agent.machineName })}
          disabled={busy}
          onClick={() => onTogglePause(agent)}
        >
          {agent.paused ? t('server.agent.resume') : t('server.agent.pause')}
        </button>
        <button
          className="danger"
          aria-label={t('server.agent.revokeLabel', { machine: agent.machineName })}
          onClick={() => onRevoke(agent)}
        >
          {t('server.agent.revoke')}
        </button>
      </div>
    </article>
  );
}
