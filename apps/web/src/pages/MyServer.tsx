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

const KEY = AGENTS_KEY;

export function MyServer() {
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
      toast(a.paused ? `${a.machineName} resumed` : `${a.machineName} paused`, 'info'),
    onSettled: () => qc.invalidateQueries({ queryKey: KEY }),
  });

  const revoke = useMutation({
    mutationFn: (a: AgentView) => revokeAgent(a.id),
    onSuccess: async (_r, a) => {
      toast(`${a.machineName} revoked`);
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
          <h1>My server</h1>
          <p className="lede">
            The machines that run tasks with your Claude subscription. Pause one to stop new tasks
            from starting there.
          </p>
        </div>
      </header>
      <InstallAgentCard />
      <div className="section-title">
        <h2>My machines</h2>
      </div>
      {agents.isPending && <p className="hint">Loading machines...</p>}
      {agents.error && <p className="error">{agents.error.message}</p>}
      {toggle.error && <p className="error">{toggle.error.message}</p>}
      {agents.isSuccess && live?.length === 0 && (
        <p className="empty">No machine yet. Generate an install command above.</p>
      )}
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
          label="Revoke machine"
          title={`Revoke ${toRevoke.machineName}?`}
          onClose={() => setToRevoke(null)}
          closeButton={false}
          tone="danger"
        >
          <p>
            The agent will be disconnected and its credentials invalidated. To use this machine
            again you must install the agent again.
          </p>
          {revoke.error && <p className="error">{revoke.error.message}</p>}
          <div className="modal-actions">
            <button onClick={() => closeModal(() => setToRevoke(null))}>Cancel</button>
            <button
              className="danger solid"
              disabled={revoke.isPending}
              onClick={() => revoke.mutate(toRevoke)}
            >
              Confirm revoke
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
