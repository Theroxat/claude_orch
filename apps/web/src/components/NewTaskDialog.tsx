import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ProjectTaskAccess, TaskSize, TaskView } from '@orch/shared';
import { useState } from 'react';
import { createTask } from '../api/endpoints';

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
  const [projectId, setProjectId] = useState(initialProjectId);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [criteria, setCriteria] = useState('');
  const [size, setSize] = useState<TaskSize>('M');
  const [model, setModel] = useState<'SONNET' | 'OPUS'>('SONNET');
  const [deps, setDeps] = useState<string[]>([]);
  const [branch, setBranch] = useState('');
  const [invalid, setInvalid] = useState<string | null>(null);
  const projectAccess = access[projectId];
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
      }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['tasks'] });
      onClose();
    },
  });
  const submit = () => {
    if (title.trim() === '') {
      setInvalid('Title is required.');
      return;
    }
    setInvalid(null);
    create.mutate();
  };
  return (
    <div className="modal-backdrop">
      <div className="modal" role="dialog" aria-label="New task">
        <div className="row between">
          <h2>New task</h2>
          <button onClick={onClose}>Close</button>
        </div>
        <label className="field">
          Project
          <select
            value={projectId}
            onChange={(e) => {
              setProjectId(e.target.value);
              setDeps([]);
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
        <div className="grid">
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
        <label className="field">
          Integration branch (optional)
          <input value={branch} onChange={(e) => setBranch(e.target.value)} />
        </label>
        {invalid && <p className="error">{invalid}</p>}
        {create.error && <p className="error">{create.error.message}</p>}
        <button className="primary" disabled={create.isPending} onClick={submit}>
          Create task
        </button>
      </div>
    </div>
  );
}
