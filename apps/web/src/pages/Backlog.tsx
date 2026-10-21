import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ProjectTaskAccess, TaskStatus, TaskView } from '@orch/shared';
import { useState } from 'react';
import { useSearchParams } from 'react-router';
import {
  approveTask,
  fetchDiscover,
  fetchMyProjects,
  fetchTaskBoard,
  importTasks,
  retryTask,
} from '../api/endpoints';
import { NewTaskDialog, type BoardProject } from '../components/NewTaskDialog';
import { POLL_MS } from '../time';
import { TaskCard } from '../components/TaskCard';
import { presenceProps, usePresence } from '../ui/presence';
import { useToast } from '../ui/Toast';

function Column({
  status,
  label,
  tasks,
  access,
  approving,
  onApprove,
  retrying,
  onRetry,
  focusId,
}: {
  status: TaskStatus;
  label: string;
  tasks: TaskView[] | undefined;
  access: Record<string, ProjectTaskAccess>;
  approving: boolean;
  onApprove: (id: string) => void;
  retrying: boolean;
  onRetry: (id: string) => void;
  focusId: string | null;
}) {
  const cards = usePresence(tasks, (t) => t.id);
  return (
    <div className="kanban-col" data-status={status} role="region" aria-label={label}>
      <h2>
        <span className="lamp" aria-hidden="true" />
        {label} <span className="badge">{tasks?.length ?? 0}</span>
      </h2>
      {tasks?.length === 0 && <p className="col-empty">Nothing here</p>}
      {cards.map(({ key, item: t, phase }) => (
        <div key={key} className="task-slot" {...presenceProps(phase)}>
          <TaskCard
            task={t}
            canApprove={access[t.projectId]?.canApprove ?? false}
            approving={approving}
            onApprove={onApprove}
            retrying={retrying}
            onRetry={onRetry}
            highlighted={t.id === focusId}
          />
        </div>
      ))}
    </div>
  );
}

const COLUMNS: { status: TaskStatus; label: string }[] = [
  { status: 'PROPOSED', label: 'Proposed' },
  { status: 'TODO', label: 'To do' },
  { status: 'BLOCKED', label: 'Blocked' },
  { status: 'IN_PROGRESS', label: 'In progress' },
  { status: 'IN_REVIEW', label: 'In review' },
  { status: 'DONE', label: 'Done' },
];

const canCreateIn = (a: ProjectTaskAccess | undefined) => !!a && (a.canSubmit || a.canPropose);

export function Backlog() {
  const qc = useQueryClient();
  const toast = useToast();
  const [filter, setFilter] = useState('');
  const [creating, setCreating] = useState(false);
  const [params] = useSearchParams();
  const focusId = params.get('task');
  const [notice, setNotice] = useState<string | null>(null);
  // Only names are read from these lists; the rights come from board.access.
  const mine = useQuery({ queryKey: ['projects', 'mine'], queryFn: fetchMyProjects });
  const discover = useQuery({ queryKey: ['projects', 'discover'], queryFn: fetchDiscover });
  const board = useQuery({
    queryKey: ['tasks', filter || 'all'],
    queryFn: () => fetchTaskBoard(filter || undefined),
    refetchInterval: POLL_MS,
  });
  const access = board.data?.access ?? {};
  const approve = useMutation({
    mutationFn: approveTask,
    onSuccess: (t) => {
      toast(`#${t.issueNumber} approved and moved to To do`);
      return qc.invalidateQueries({ queryKey: ['tasks'] });
    },
  });
  const retry = useMutation({
    mutationFn: retryTask,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tasks'] }),
  });
  const imp = useMutation({
    mutationFn: importTasks,
    onSuccess: async (r) => {
      setNotice(`Imported ${r.imported.length} issue(s), ${r.alreadyImported} already imported.`);
      await qc.invalidateQueries({ queryKey: ['tasks'] });
    },
  });

  const names = new Map<string, string>();
  for (const p of mine.data ?? []) names.set(p.id, p.fullName);
  for (const d of discover.data ?? []) {
    if (d.myRole !== 'none') names.set(d.project.id, d.project.fullName);
  }
  const projects: BoardProject[] = [...names].map(([id, fullName]) => ({ id, fullName }));
  const selected = projects.find((p) => p.id === filter);
  const importTargets = (selected ? [selected] : projects).filter((p) => access[p.id]?.canSubmit);
  const newTaskEnabled = filter
    ? canCreateIn(access[filter])
    : projects.some((p) => canCreateIn(access[p.id]));
  const allTasks: TaskView[] = board.data ? COLUMNS.flatMap((c) => board.data[c.status]) : [];
  const focusMissing = !!focusId && !!board.data && !allTasks.some((t) => t.id === focusId);

  return (
    <section>
      <header className="page-head">
        <div>
          <h1>Backlog</h1>
          <p className="lede">
            Tasks are GitHub issues. Each one runs in its own container on a teammate&apos;s
            machine, then orch opens a pull request.
          </p>
        </div>
        <div className="page-actions">
          <label className="field inline">
            Project
            <select value={filter} onChange={(e) => setFilter(e.target.value)}>
              <option value="">All my projects</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.fullName}
                </option>
              ))}
            </select>
          </label>
          <button className="primary" disabled={!newTaskEnabled} onClick={() => setCreating(true)}>
            New task
          </button>
        </div>
      </header>
      <div className="board-tools">
        {importTargets.map((p) => (
          <button key={p.id} disabled={imp.isPending} onClick={() => imp.mutate(p.id)}>
            Import issues labeled <code>pool</code> ({p.fullName})
          </button>
        ))}
      </div>
      {notice && (
        <p className="notice reveal" key={notice} role="status">
          {notice}
        </p>
      )}
      {focusMissing && (
        <p className="notice" role="status">
          This task is not on the board (it may belong to a project you cannot see).
        </p>
      )}
      {imp.error && <p className="error">{imp.error.message}</p>}
      {approve.error && <p className="error">{approve.error.message}</p>}
      {retry.error && <p className="error">{retry.error.message}</p>}
      {board.isPending && <p className="hint">Loading...</p>}
      {board.error && <p className="error">{board.error.message}</p>}
      {board.data && (
        <div className="kanban">
          {COLUMNS.map((c) => (
            <Column
              key={c.status}
              status={c.status}
              label={c.label}
              tasks={board.data[c.status]}
              access={access}
              approving={approve.isPending}
              onApprove={(id) => approve.mutate(id)}
              retrying={retry.isPending}
              onRetry={(id) => retry.mutate(id)}
              focusId={focusId}
            />
          ))}
        </div>
      )}
      {creating && (
        <NewTaskDialog
          projects={projects.filter((p) => canCreateIn(access[p.id]))}
          access={access}
          initialProjectId={filter || projects.find((p) => canCreateIn(access[p.id]))?.id || ''}
          tasks={allTasks}
          onClose={() => setCreating(false)}
        />
      )}
    </section>
  );
}
