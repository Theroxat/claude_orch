import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { AgentView } from '@orch/shared';
import { updateAgent } from '../api/endpoints';

export const AGENTS_KEY = ['agents', 'mine'];

const IN_PROGRESS = ['pending', 'deferred', 'pulling', 'restarting'];

export const updateInProgress = (a: AgentView) =>
  !!a.update && IN_PROGRESS.includes(a.update.status);

export function updateStatusText(a: AgentView): string | null {
  const u = a.update;
  if (!u) return null;
  switch (u.status) {
    case 'pending':
      return 'Update requested';
    case 'deferred':
      return 'Waiting for running tasks to finish';
    case 'pulling':
      return `Downloading v${u.targetVersion}`;
    case 'restarting':
      return 'Restarting...';
    case 'failed':
      return `Update failed: ${u.detail ?? u.code ?? 'unknown error'}`;
    case 'done':
      return 'Updated';
    default:
      return null;
  }
}

/** Starts a one-click update and writes the returned agent into the shared agents cache. */
export function useAgentUpdate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, whenIdle }: { id: string; whenIdle: boolean }) => updateAgent(id, whenIdle),
    onSuccess: (view) =>
      qc.setQueryData<AgentView[]>(AGENTS_KEY, (l) => l?.map((a) => (a.id === view.id ? view : a))),
    onSettled: () => qc.invalidateQueries({ queryKey: AGENTS_KEY }),
  });
}

/** Status line and actions (Update now / Update when idle) for one agent. */
export function AgentUpdateActions({ agent }: { agent: AgentView }) {
  const m = useAgentUpdate();
  const inProgress = updateInProgress(agent);
  const status = updateStatusText(agent);
  const busyFail = agent.update?.status === 'failed' && agent.update.code === 'busy';
  const disabled = m.isPending || inProgress;
  const run = (whenIdle: boolean) => m.mutate({ id: agent.id, whenIdle });
  return (
    <div className="agent-update">
      {status && (
        <p
          className={agent.update?.status === 'failed' ? 'error' : 'hint'}
          role="status"
          aria-label={`Update status ${agent.machineName}`}
        >
          {status}
        </p>
      )}
      {agent.updateAvailable &&
        (agent.canSelfUpdate ? (
          <div className="row">
            <button
              className="primary"
              disabled={disabled}
              aria-label={`Update now ${agent.machineName}`}
              onClick={() => run(false)}
            >
              Update now
            </button>
            {busyFail && (
              <button
                disabled={disabled}
                aria-label={`Update when idle ${agent.machineName}`}
                onClick={() => run(true)}
              >
                Update when idle
              </button>
            )}
          </div>
        ) : (
          <p className="hint">
            Your agent is offline or too old for one-click update; update it manually
          </p>
        ))}
      {m.error && <p className="error">{m.error.message}</p>}
    </div>
  );
}

/** Per-agent version line for the My Server card. Nothing extra for dev versions. */
export function AgentUpdateState({ agent }: { agent: AgentView }) {
  const upToDate = !agent.updateAvailable && !!agent.latestAgentVersion && !!agent.version;
  return (
    <>
      {agent.updateAvailable && (
        <p className="hint">
          v{agent.version ?? '?'} · update available: v{agent.latestAgentVersion}
        </p>
      )}
      {upToDate && !agent.update && <p className="hint">Up to date</p>}
      {(agent.updateAvailable || agent.update) && <AgentUpdateActions agent={agent} />}
    </>
  );
}
