import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AgentView } from '@orch/shared';
import { useState } from 'react';
import { AGENTS_KEY } from '../components/AgentUpdate';
import { fetchMyAgents, pauseAgent, resumeAgent, revokeAgent } from '../api/endpoints';
import { AgentCard } from '../components/AgentCard';
import { NotificationSettings } from '../components/NotificationSettings';
import { InstallAgentCard } from '../components/InstallAgentCard';
import { TemplatesManager } from '../components/TemplatesManager';
import { Modal, closeModal } from '../ui/Modal';
import { usePresence } from '../ui/presence';
import { useToast } from '../ui/Toast';
import { useT } from '../i18n/index.ts';
import { errorMessage } from '../i18n/errors.ts';

const KEY = AGENTS_KEY;

export function MyServer() {
  const t = useT();
  const qc = useQueryClient();
  const toast = useToast();
  const [toRevoke, setToRevoke] = useState<AgentView | null>(null);
  const agents = useQuery({ queryKey: KEY, queryFn: fetchMyAgents, refetchInterval: 15_000 });

  const setPaused = (list: AgentView[] | undefined, id: string, paused: boolean) =>
    list?.map((a) => (a.id === id ? { ...a, paused } : a));

  const toggle = useMutation({
    mutationFn: (a: AgentView) => (a.paused ? resumeAgent(a.id) : pauseAgent(a.id)),
    onMutate: async (a) => {
      await qc.cancelQueries({ queryKey: KEY });
      const previous = qc.getQueryData<AgentView[]>(KEY);
      qc.setQueryData<AgentView[]>(KEY, (l) => setPaused(l, a.id, !a.paused));
      return { previous };
    },
    onError: (_e, _a, ctx) => qc.setQueryData(KEY, ctx?.previous),
    onSuccess: (_r, a) =>
      toast(
        a.paused
          ? t('server.toast.resumed', { machine: a.machineName })
          : t('server.toast.paused', { machine: a.machineName }),
        'info',
      ),
    onSettled: () => qc.invalidateQueries({ queryKey: KEY }),
  });

  const revoke = useMutation({
    mutationFn: (a: AgentView) => revokeAgent(a.id),
    onSuccess: async (_r, a) => {
      toast(t('server.toast.revoked', { machine: a.machineName }));
      closeModal(() => setToRevoke(null));
      await qc.invalidateQueries({ queryKey: KEY });
    },
  });

  const live = agents.data?.filter((a) => !a.revokedAt);
  const list = usePresence(live, (a) => a.id);

  return (
    <div>
      <header className="page-head">
        <div>
          <h1>{t('server.page.title')}</h1>
          <p className="lede">{t('server.page.lede')}</p>
        </div>
      </header>
      <InstallAgentCard />
      <div className="section-title">
        <h2>{t('server.page.machines')}</h2>
      </div>
      {agents.isPending && <p className="hint">{t('server.page.loading')}</p>}
      {agents.error && <p className="error">{errorMessage(agents.error)}</p>}
      {toggle.error && <p className="error">{errorMessage(toggle.error)}</p>}
      {agents.isSuccess && live?.length === 0 && <p className="empty">{t('server.page.empty')}</p>}
      {list.map(({ key, item: a, phase }) => (
        <AgentCard
          key={key}
          phase={phase}
          agent={a}
          busy={false}
          onTogglePause={(x) => toggle.mutate(x)}
          onRevoke={setToRevoke}
        />
      ))}
      <TemplatesManager scope="personal" />
      <NotificationSettings />
      {toRevoke && (
        <Modal
          label={t('server.revoke.label')}
          title={t('server.revoke.title', { machine: toRevoke.machineName })}
          onClose={() => setToRevoke(null)}
          closeButton={false}
          tone="danger"
        >
          <p>{t('server.revoke.body')}</p>
          {revoke.error && <p className="error">{errorMessage(revoke.error)}</p>}
          <div className="modal-actions">
            <button onClick={() => closeModal(() => setToRevoke(null))}>
              {t('common.actions.cancel')}
            </button>
            <button
              className="danger solid"
              disabled={revoke.isPending}
              onClick={() => revoke.mutate(toRevoke)}
            >
              {t('server.revoke.confirm')}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
