import type { AgentView } from '@orch/shared';
import { AgentUpdateState } from './AgentUpdate';

export function relativeTime(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return 'never';
  const s = Math.round((now - new Date(iso).getTime()) / 1000);
  if (s < 10) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

function hhmm(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function UsageEstimate({ usage }: { usage: AgentView['lastUsage'] }) {
  if (!usage) return <p className="hint">Estimate: no usage reported yet</p>;
  const margin = usage.usedFraction == null ? null : Math.round((1 - usage.usedFraction) * 100);
  return (
    <div className="usage">
      <span className="badge">Estimate</span>{' '}
      <span>≈ {Math.round(usage.weighted).toLocaleString('en-US')} tokens in the 5h window</span>
      {' · '}
      <span>{margin == null ? 'margin unknown' : `margin ≈ ${Math.max(0, margin)}%`}</span>
      {usage.windowResetAt && (
        <>
          {' · '}
          <span>resets at {hhmm(usage.windowResetAt)}</span>
        </>
      )}
      {usage.rateLimitedUntil && (
        <p className="hint">Rate limited until {hhmm(usage.rateLimitedUntil)}</p>
      )}
    </div>
  );
}

export function AgentCard({
  agent,
  busy,
  onTogglePause,
  onRevoke,
}: {
  agent: AgentView;
  busy: boolean;
  onTogglePause: (agent: AgentView) => void;
  onRevoke: (agent: AgentView) => void;
}) {
  return (
    <article
      className={`card agent${agent.paused ? ' paused' : ''}`}
      aria-label={agent.machineName}
    >
      <div className="row between">
        <h3>{agent.machineName}</h3>
        <span className={`badge ${agent.connected ? 'ok' : ''}`}>
          {agent.connected ? 'Online' : 'Offline'}
        </span>
      </div>
      <p className="hint">
        Version {agent.version ?? 'unknown'} · Last seen {relativeTime(agent.lastSeenAt)}
      </p>
      <AgentUpdateState agent={agent} />
      {agent.claudeAuthValid === false && (
        <p className="warning" role="alert">
          Claude login expired: run <code>orch login</code>
        </p>
      )}
      {agent.claudeAuthValid !== false && agent.claudeTokenPresent != null && (
        <p className="hint">
          {agent.claudeTokenPresent ? (
            'Claude: connected'
          ) : (
            <>
              Claude: not connected: run <code>orch login</code>
            </>
          )}
        </p>
      )}
      <UsageEstimate usage={agent.lastUsage} />
      {agent.paused && (
        <div className="warning" role="status">
          Paused: no new tasks will start on this machine
        </div>
      )}
      <div className="row">
        <button
          className={`pause-toggle ${agent.paused ? 'primary' : ''}`}
          role="switch"
          aria-checked={agent.paused}
          aria-label={`Pause ${agent.machineName}`}
          disabled={busy}
          onClick={() => onTogglePause(agent)}
        >
          {agent.paused ? 'Resume' : 'Pause'}
        </button>
        <button
          className="danger"
          aria-label={`Revoke ${agent.machineName}`}
          onClick={() => onRevoke(agent)}
        >
          Revoke
        </button>
      </div>
    </article>
  );
}
