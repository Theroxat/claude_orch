import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { DispatchRequest, ProjectTaskAccess, TaskSize, TaskView } from '@orch/shared';
import { useState } from 'react';
import { createTask, fetchPool } from '../api/endpoints';
import { poolErrorMessage } from '../poolErrors';
import { Modal, closeModal } from '../ui/Modal';
import { useToast } from '../ui/Toast';

export type BoardProject = {
  id: string;
  fullName: string;
};

export function NewTaskDialog({
  projects,
  access,
  initialProjectId,
  tasks,
  onClose,
}: {
  projects: BoardProject[];
  access: Record<string, ProjectTaskAccess>;
  initialProjectId: string;
  tasks: TaskView[];
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const [projectId, setProjectId] = useState(initialProjectId);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [criteria, setCriteria] = useState('');
  const [size, setSize] = useState<TaskSize>('M');
  const [model, setModel] = useState<'SONNET' | 'OPUS'>('SONNET');
  const [deps, setDeps] = useState<string[]>([]);
  const [branch, setBranch] = useState('');
  const [sendTo, setSendTo] = useState<DispatchRequest['mode']>('pool');
  const [memberIds, setMemberIds] = useState<string[]>([]);
  const [invalid, setInvalid] = useState<string | null>(null);
  const projectAccess = access[projectId];
  const pool = useQuery({
    queryKey: ['pool', projectId],
    queryFn: () => fetchPool(projectId),
    enabled: projectId !== '',
    retry: false,
  });
  const isOwner =
    pool.data?.projects?.find((p) => p.projectId === projectId)?.isOwner ??
    pool.data?.members.some((m) =>
      m.projects.some((p) => p.projectId === projectId && p.isOwner === true),
    ) ??
    false;
  const mode = sendTo === 'broadcast' && !isOwner ? 'pool' : sendTo;
  const poolMembers = (pool.data?.members ?? []).filter((m) =>
    m.projects.some((p) => p.projectId === projectId),
  );
  const projectTasks = tasks.filter((t) => t.projectId === projectId);
  const create = useMutation({
    mutationFn: () =>
      createTask(projectId, {
        title: title.trim(),
        body: body.trim(),
        acceptanceCriteria: criteria
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean),
        size,
        model,
        dependsOn: deps,
        integrationBranch: branch.trim() === '' ? null : branch.trim(),
        ...(mode === 'members'
          ? { dispatch: { mode, memberIds } }
          : mode === 'broadcast'
            ? { dispatch: { mode } }
            : {}),
      }),
    onSuccess: async (t) => {
      toast(`#${t.issueNumber} created`);
      await qc.invalidateQueries({ queryKey: ['tasks'] });
      closeModal(onClose);
    },
  });
  const submit = () => {
    if (title.trim() === '') {
      setInvalid('Title is required.');
      return;
    }
    if (mode === 'members' && memberIds.length === 0) {
      setInvalid('Select at least one member.');
      return;
    }
    setInvalid(null);
    create.mutate();
  };
  return (
    <Modal label="New task" title="New task" onClose={onClose} wide>
      <label className="field">
        Project
        <select
          value={projectId}
          onChange={(e) => {
            setProjectId(e.target.value);
            setDeps([]);
            setMemberIds([]);
          }}
        >
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.fullName}
            </option>
          ))}
        </select>
      </label>
      {projectAccess && !projectAccess.canSubmit && projectAccess.canPropose && (
        <p className="hint">
          This task will be created as Proposed until a maintainer approves it.
        </p>
      )}
      <label className="field">
        Title
        <input value={title} onChange={(e) => setTitle(e.target.value)} />
      </label>
      <label className="field">
        Description
        <textarea rows={4} value={body} onChange={(e) => setBody(e.target.value)} />
      </label>
      <label className="field">
        Acceptance criteria (one per line)
        <textarea rows={3} value={criteria} onChange={(e) => setCriteria(e.target.value)} />
      </label>
      <div className="form-grid">
        <label className="field">
          Size
          <select value={size} onChange={(e) => setSize(e.target.value as TaskSize)}>
            <option value="S">S</option>
            <option value="M">M</option>
            <option value="L">L</option>
          </select>
        </label>
        <label className="field">
          Model
          <select value={model} onChange={(e) => setModel(e.target.value as 'SONNET' | 'OPUS')}>
            <option value="SONNET">sonnet</option>
            <option value="OPUS">opus</option>
          </select>
        </label>
      </div>
      <label className="field">
        Dependencies
        <select
          multiple
          value={deps}
          onChange={(e) => setDeps(Array.from(e.target.selectedOptions, (o) => o.value))}
        >
          {projectTasks.map((t) => (
            <option key={t.id} value={t.id}>
              #{t.issueNumber} {t.title}
            </option>
          ))}
        </select>
      </label>
      <div className="form-grid">
        <label className="field">
          Integration branch (optional)
          <input value={branch} onChange={(e) => setBranch(e.target.value)} />
        </label>
        <label className="field">
          Send to
          <select
            value={mode}
            onChange={(e) => setSendTo(e.target.value as DispatchRequest['mode'])}
          >
            <option value="pool">Pool</option>
            <option value="members">Specific members</option>
            {isOwner && <option value="broadcast">Everyone</option>}
          </select>
        </label>
      </div>
      {mode === 'pool' && (
        <p className="hint">The best available member in the pool gets the task.</p>
      )}
      {mode === 'members' && (
        <div className="checks" role="group" aria-label="Members">
          {pool.isLoading && <span className="hint">Loading members...</span>}
          {pool.error && (
            <p className="error" role="alert">
              {poolErrorMessage(pool.error)}
            </p>
          )}
          {pool.isSuccess && poolMembers.length === 0 && (
            <span className="hint">No member is lending capacity to this project yet.</span>
          )}
          {poolMembers.map((m) => (
            <label key={m.userId}>
              <input
                type="checkbox"
                checked={memberIds.includes(m.userId)}
                onChange={(e) =>
                  setMemberIds((ids) =>
                    e.target.checked ? [...ids, m.userId] : ids.filter((i) => i !== m.userId),
                  )
                }
              />
              {m.login}
            </label>
          ))}
        </div>
      )}
      {mode === 'broadcast' && (
        <p className="hint">
          Everyone: starts automatically for auto-mode members and sends a request to the others.
          The first acceptance wins.
        </p>
      )}
      {invalid && (
        <p className="error" role="alert">
          {invalid}
        </p>
      )}
      {create.error && <p className="error">{create.error.message}</p>}
      <div className="modal-actions">
        <button className="primary" disabled={create.isPending} onClick={submit}>
          Create task
        </button>
      </div>
    </Modal>
  );
}
