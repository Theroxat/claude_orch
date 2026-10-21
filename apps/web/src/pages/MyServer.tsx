import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AgentView } from '@orch/shared';
import { useState } from 'react';
import { AGENTS_KEY } from '../components/AgentUpdate';
import { fetchMyAgents, pauseAgent, resumeAgent, revokeAgent } from '../api/endpoints';
import { AgentCard } from '../components/AgentCard';
import { InstallAgentCard } from '../components/InstallAgentCard';

const KEY = AGENTS_KEY;

export function MyServer() {
  const qc = useQueryClient();
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
    onSettled: () => qc.invalidateQueries({ queryKey: KEY }),
  });

  const revoke = useMutation({
    mutationFn: (a: AgentView) => revokeAgent(a.id),
    onSuccess: async () => {
      setToRevoke(null);
      await qc.invalidateQueries({ queryKey: KEY });
    },
  });

  const list = (agents.data ?? []).filter((a) => !a.revokedAt);

  return (
    <div>
      <h1>My server</h1>
      <InstallAgentCard />
      <h2>My machines</h2>
      {agents.isPending && <p className="hint">Loading machines...</p>}
      {agents.error && <p className="error">{agents.error.message}</p>}
      {toggle.error && <p className="error">{toggle.error.message}</p>}
      {agents.isSuccess && list.length === 0 && (
        <p className="hint">No machine yet. Generate an install command above.</p>
      )}
      {list.map((a) => (
        <AgentCard
          key={a.id}
          agent={a}
          busy={false}
          onTogglePause={(x) => toggle.mutate(x)}
          onRevoke={setToRevoke}
        />
      ))}
      {toRevoke && (
        <div className="modal-backdrop">
          <div className="modal" role="dialog" aria-label="Revoke machine">
            <h2>Revoke {toRevoke.machineName}?</h2>
            <p>
              The agent will be disconnected and its credentials invalidated. To use this machine
              again you must install the agent again.
            </p>
            {revoke.error && <p className="error">{revoke.error.message}</p>}
            <div className="row">
              <button onClick={() => setToRevoke(null)}>Cancel</button>
              <button
                className="danger"
                disabled={revoke.isPending}
                onClick={() => revoke.mutate(toRevoke)}
              >
                Confirm revoke
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
