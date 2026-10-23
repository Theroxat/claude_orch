import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  TemplateError,
  previewTemplate,
  renderTemplate,
  type DispatchRequest,
  type ProjectTaskAccess,
  type TaskSize,
  type TaskTemplateView,
  type TaskView,
} from '@orch/shared';
import { useState } from 'react';
import { createTask, fetchPool } from '../api/endpoints';
import { Modal, closeModal } from '../ui/Modal';
import { TemplateFill } from './TemplateFill';
import { TemplatePicker } from './TemplatePicker';
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
  const [template, setTemplate] = useState<TaskTemplateView | null>(null);
  const [vars, setVars] = useState<Record<string, string>>({});
  const projectAccess = access[projectId];
  const pool = useQuery({
    queryKey: ['pool', projectId],
    queryFn: () => fetchPool(projectId),
    enabled: projectId !== '',
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
  const pickTemplate = (t: TaskTemplateView) => {
    setTemplate(t);
    setVars({});
    setSize(t.size);
    setModel(t.model);
    setInvalid(null);
  };
  /** Keeps what the template produced so far as plain text the user can edit freely. */
  const detachTemplate = () => {
    if (!template) return;
    const p = previewTemplate(template, vars);
    setTitle(p.title);
    setBody(p.body);
    setCriteria(p.acceptanceCriteria.join('\n'));
    setTemplate(null);
  };
  const create = useMutation({
    mutationFn: () => {
      const rendered = template ? renderTemplate(template, vars) : null;
      return createTask(projectId, {
        title: rendered ? rendered.title : title.trim(),
        body: rendered ? rendered.body : body.trim(),
        acceptanceCriteria: rendered
          ? rendered.acceptanceCriteria
          : criteria
              .split('\n')
              .map((l) => l.trim())
              .filter(Boolean),
        ...(rendered && rendered.labels.length > 0 ? { labels: rendered.labels } : {}),
        size,
        model,
        dependsOn: deps,
        integrationBranch: branch.trim() === '' ? null : branch.trim(),
        ...(mode === 'members'
          ? { dispatch: { mode, memberIds } }
          : mode === 'broadcast'
            ? { dispatch: { mode } }
            : {}),
      });
    },
    onSuccess: async (t) => {
      toast(`#${t.issueNumber} created`);
      await qc.invalidateQueries({ queryKey: ['tasks'] });
      closeModal(onClose);
    },
  });
  const submit = () => {
    if (template) {
      try {
        renderTemplate(template, vars);
      } catch (err) {
        if (err instanceof TemplateError) {
          setInvalid(
            err.code === 'missing_variables'
              ? `Fill in every field of the template: ${err.names.join(', ')}.`
              : err.message,
          );
          return;
        }
        throw err;
      }
    } else if (title.trim() === '') {
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
            if (template && template.scope === 'project') setTemplate(null);
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
      <TemplatePicker
        projectId={projectId}
        selected={template}
        onPick={pickTemplate}
        onClear={() => setTemplate(null)}
      />
      {template ? (
        <>
          <TemplateFill
            template={template}
            values={vars}
            onChange={(n, v) => setVars((cur) => ({ ...cur, [n]: v }))}
          />
          <div className="tpl-meta">
            {template.labels.length > 0 && (
              <span>
                Labels:{' '}
                {template.labels.map((l) => (
                  <span key={l} className="tag">
                    {l}
                  </span>
                ))}
              </span>
            )}
            <button type="button" className="ghost" onClick={detachTemplate}>
              Edit as plain text
            </button>
          </div>
          {template.dependenciesMode === 'ask' && (
            <p className="hint">This kind of task usually depends on others: pick them below.</p>
          )}
        </>
      ) : (
        <>
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
        </>
      )}
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
