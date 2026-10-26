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
import { errorMessage } from '../i18n/errors.ts';
import { useRich, useT, type MessageKey } from '../i18n/index.ts';

function Column({
  status,
  labelKey,
  tasks,
  access,
  approving,
  onApprove,
  retrying,
  onRetry,
  focusId,
}: {
  status: TaskStatus;
  labelKey: MessageKey;
  tasks: TaskView[] | undefined;
  access: Record<string, ProjectTaskAccess>;
  approving: boolean;
  onApprove: (id: string) => void;
  retrying: boolean;
  onRetry: (id: string) => void;
  focusId: string | null;
}) {
  const t = useT();
  const label = t(labelKey);
  const cards = usePresence(tasks, (x) => x.id);
  return (
    <div className="kanban-col" data-status={status} role="region" aria-label={label}>
      <h2>
        <span className="lamp" aria-hidden="true" />
        {label} <span className="badge">{tasks?.length ?? 0}</span>
      </h2>
      {tasks?.length === 0 && <p className="col-empty">{t('backlog.page.nothingHere')}</p>}
      {cards.map(({ key, item: task, phase }) => (
        <div key={key} className="task-slot" {...presenceProps(phase)}>
          <TaskCard
            task={task}
            canApprove={access[task.projectId]?.canApprove ?? false}
            approving={approving}
            onApprove={onApprove}
            retrying={retrying}
            onRetry={onRetry}
            highlighted={task.id === focusId}
          />
        </div>
      ))}
    </div>
  );
}

const COLUMNS: { status: TaskStatus; labelKey: MessageKey }[] = [
  { status: 'PROPOSED', labelKey: 'backlog.columns.proposed' },
  { status: 'TODO', labelKey: 'backlog.columns.todo' },
  { status: 'BLOCKED', labelKey: 'backlog.columns.blocked' },
  { status: 'IN_PROGRESS', labelKey: 'backlog.columns.inProgress' },
  { status: 'IN_REVIEW', labelKey: 'backlog.columns.inReview' },
  { status: 'DONE', labelKey: 'backlog.columns.done' },
];

const canCreateIn = (a: ProjectTaskAccess | undefined) => !!a && (a.canSubmit || a.canPropose);

export function Backlog() {
  const t = useT();
  const rich = useRich();
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
    onSuccess: (task) => {
      toast(t('backlog.page.approved', { number: String(task.issueNumber) }));
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
      setNotice(
        t('backlog.page.importResult', {
          count: r.imported.length,
          already: r.alreadyImported,
        }),
      );
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
  const focusMissing = !!focusId && !!board.data && !allTasks.some((x) => x.id === focusId);

  return (
    <section>
      <header className="page-head">
        <div>
          <h1>{t('backlog.page.title')}</h1>
          <p className="lede">{t('backlog.page.lede')}</p>
        </div>
        <div className="page-actions">
          <label className="field inline">
            {t('backlog.page.project')}
            <select value={filter} onChange={(e) => setFilter(e.target.value)}>
              <option value="">{t('backlog.page.allProjects')}</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.fullName}
                </option>
              ))}
            </select>
          </label>
          <button className="primary" disabled={!newTaskEnabled} onClick={() => setCreating(true)}>
            {t('backlog.page.newTask')}
          </button>
        </div>
      </header>
      <div className="board-tools">
        {importTargets.map((p) => (
          <button key={p.id} disabled={imp.isPending} onClick={() => imp.mutate(p.id)}>
            {rich(
              'backlog.page.importIssues',
              { code: (c) => <code>{c}</code> },
              { project: p.fullName },
            )}
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
          {t('backlog.page.notOnBoard')}
        </p>
      )}
      {imp.error && <p className="error">{errorMessage(imp.error)}</p>}
      {approve.error && <p className="error">{errorMessage(approve.error)}</p>}
      {retry.error && <p className="error">{errorMessage(retry.error)}</p>}
      {board.isPending && <p className="hint">{t('common.status.loading')}</p>}
      {board.error && <p className="error">{errorMessage(board.error)}</p>}
      {board.data && (
        <div className="kanban">
          {COLUMNS.map((c) => (
            <Column
              key={c.status}
              status={c.status}
              labelKey={c.labelKey}
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
