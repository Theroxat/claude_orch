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
import { errorMessage } from '../i18n/errors.ts';
import { useT } from '../i18n/index.ts';

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
  const t = useT();
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
  const projectTasks = tasks.filter((x) => x.projectId === projectId);
  const pickTemplate = (tpl: TaskTemplateView) => {
    setTemplate(tpl);
    setVars({});
    setSize(tpl.size);
    setModel(tpl.model);
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
    onSuccess: async (created) => {
      toast(t('backlog.newTask.created', { number: String(created.issueNumber) }));
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
              ? t('backlog.newTask.fillAll', { names: err.names.join(', ') })
              : errorMessage(err),
          );
          return;
        }
        throw err;
      }
    } else if (title.trim() === '') {
      setInvalid(t('backlog.newTask.titleRequired'));
      return;
    }
    if (mode === 'members' && memberIds.length === 0) {
      setInvalid(t('backlog.newTask.selectMember'));
      return;
    }
    setInvalid(null);
    create.mutate();
  };
  return (
    <Modal
      label={t('backlog.newTask.title')}
      title={t('backlog.newTask.title')}
      onClose={onClose}
      wide
    >
      <label className="field">
        {t('backlog.newTask.project')}
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
        <p className="hint">{t('backlog.newTask.proposedHint')}</p>
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
                {t('backlog.newTask.labels')}{' '}
                {template.labels.map((l) => (
                  <span key={l} className="tag">
                    {l}
                  </span>
                ))}
              </span>
            )}
            <button type="button" className="ghost" onClick={detachTemplate}>
              {t('backlog.newTask.editPlain')}
            </button>
          </div>
          {template.dependenciesMode === 'ask' && (
            <p className="hint">{t('backlog.newTask.dependenciesHint')}</p>
          )}
        </>
      ) : (
        <>
          <label className="field">
            {t('backlog.newTask.titleField')}
            <input value={title} onChange={(e) => setTitle(e.target.value)} />
          </label>
          <label className="field">
            {t('backlog.newTask.description')}
            <textarea rows={4} value={body} onChange={(e) => setBody(e.target.value)} />
          </label>
          <label className="field">
            {t('backlog.newTask.criteria')}
            <textarea rows={3} value={criteria} onChange={(e) => setCriteria(e.target.value)} />
          </label>
        </>
      )}
      <div className="form-grid">
        <label className="field">
          {t('backlog.newTask.size')}
          <select value={size} onChange={(e) => setSize(e.target.value as TaskSize)}>
            <option value="S">S</option>
            <option value="M">M</option>
            <option value="L">L</option>
          </select>
        </label>
        <label className="field">
          {t('backlog.newTask.model')}
          <select value={model} onChange={(e) => setModel(e.target.value as 'SONNET' | 'OPUS')}>
            <option value="SONNET">sonnet</option>
            <option value="OPUS">opus</option>
          </select>
        </label>
      </div>
      <label className="field">
        {t('backlog.newTask.dependencies')}
        <select
          multiple
          value={deps}
          onChange={(e) => setDeps(Array.from(e.target.selectedOptions, (o) => o.value))}
        >
          {projectTasks.map((x) => (
            <option key={x.id} value={x.id}>
              #{x.issueNumber} {x.title}
            </option>
          ))}
        </select>
      </label>
      <div className="form-grid">
        <label className="field">
          {t('backlog.newTask.branch')}
          <input value={branch} onChange={(e) => setBranch(e.target.value)} />
        </label>
        <label className="field">
          {t('backlog.newTask.sendTo')}
          <select
            value={mode}
            onChange={(e) => setSendTo(e.target.value as DispatchRequest['mode'])}
          >
            <option value="pool">{t('backlog.newTask.toPool')}</option>
            <option value="members">{t('backlog.newTask.toMembers')}</option>
            {isOwner && <option value="broadcast">{t('backlog.newTask.toEveryone')}</option>}
          </select>
        </label>
      </div>
      {mode === 'pool' && <p className="hint">{t('backlog.newTask.poolHint')}</p>}
      {mode === 'members' && (
        <div className="checks" role="group" aria-label={t('backlog.newTask.members')}>
          {pool.isLoading && <span className="hint">{t('backlog.newTask.loadingMembers')}</span>}
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
      {mode === 'broadcast' && <p className="hint">{t('backlog.newTask.broadcastHint')}</p>}
      {invalid && (
        <p className="error" role="alert">
          {invalid}
        </p>
      )}
      {create.error && <p className="error">{errorMessage(create.error)}</p>}
      <div className="modal-actions">
        <button className="primary" disabled={create.isPending} onClick={submit}>
          {t('backlog.newTask.create')}
        </button>
      </div>
    </Modal>
  );
}
