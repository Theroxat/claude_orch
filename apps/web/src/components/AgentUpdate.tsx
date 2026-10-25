import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { AgentView } from '@orch/shared';
import { updateAgent } from '../api/endpoints';
import { t, useT } from '../i18n/index.ts';
import { errorMessage } from '../i18n/errors.ts';

export const AGENTS_KEY = ['agents', 'mine'];

const IN_PROGRESS = ['pending', 'deferred', 'pulling', 'restarting'];

export const updateInProgress = (a: AgentView) =>
  !!a.update && IN_PROGRESS.includes(a.update.status);

export function updateStatusText(a: AgentView): string | null {
  const u = a.update;
  if (!u) return null;
  switch (u.status) {
    case 'pending':
      return t('server.update.requested');
    case 'deferred':
      return t('server.update.deferred');
    case 'pulling':
      return t('server.update.pulling', { version: u.targetVersion });
    case 'restarting':
      return t('server.update.restarting');
    case 'failed':
      return t('server.update.failed', {
        detail: u.detail ?? u.code ?? t('server.update.unknownError'),
      });
    case 'done':
      return t('server.update.done');
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
  const t = useT();
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
          aria-label={t('server.update.statusLabel', { machine: agent.machineName })}
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
              aria-label={t('server.update.nowLabel', { machine: agent.machineName })}
              onClick={() => run(false)}
            >
              {t('server.update.now')}
            </button>
            {busyFail && (
              <button
                disabled={disabled}
                aria-label={t('server.update.whenIdleLabel', { machine: agent.machineName })}
                onClick={() => run(true)}
              >
                {t('server.update.whenIdle')}
              </button>
            )}
          </div>
        ) : (
          <p className="hint">{t('server.update.manual')}</p>
        ))}
      {m.error && <p className="error">{errorMessage(m.error)}</p>}
    </div>
  );
}

/** Per-agent version line for the My Server card. Nothing extra for dev versions. */
export function AgentUpdateState({ agent }: { agent: AgentView }) {
  const t = useT();
  const upToDate = !agent.updateAvailable && !!agent.latestAgentVersion && !!agent.version;
  return (
    <>
      {agent.updateAvailable && (
        <p className="hint">
          {t('server.update.available', {
            version: agent.version ?? '?',
            latest: agent.latestAgentVersion ?? '',
          })}
        </p>
      )}
      {upToDate && !agent.update && <p className="hint">{t('server.update.upToDate')}</p>}
      {(agent.updateAvailable || agent.update) && <AgentUpdateActions agent={agent} />}
    </>
  );
}
