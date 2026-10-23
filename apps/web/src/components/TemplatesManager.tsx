import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  TEMPLATE_LIMITS,
  extractPlaceholders,
  type TaskSize,
  type TaskTemplateView,
} from '@orch/shared';
import { useState } from 'react';
import { createTemplate, deleteTemplate, fetchTemplates, updateTemplate } from '../api/endpoints';
import { Modal, closeModal } from '../ui/Modal';
import { presenceProps, usePresence } from '../ui/presence';
import { useToast } from '../ui/Toast';
import { SCOPE_LABEL } from './TemplatePicker';

type Draft = {
  name: string;
  description: string;
  titleTemplate: string;
  bodyTemplate: string;
  criteria: string;
  size: TaskSize;
  model: 'SONNET' | 'OPUS';
  labels: string;
  ask: boolean;
};

const draftOf = (t?: TaskTemplateView, copy = false): Draft => ({
  name: t ? (copy ? `${t.name} (copy)` : t.name) : '',
  description: t?.description ?? '',
  titleTemplate: t?.titleTemplate ?? '',
  bodyTemplate: t?.bodyTemplate ?? '',
  criteria: t?.acceptanceCriteria.join('\n') ?? '',
  size: t?.size ?? 'M',
  model: t?.model ?? 'SONNET',
  labels: t?.labels.join(', ') ?? '',
  ask: t?.dependenciesMode === 'ask',
});

const lines = (s: string) =>
  s
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

function TemplateEditor({
  scope,
  projectId,
  editing,
  seed,
  onClose,
}: {
  scope: 'personal' | 'project';
  projectId?: string;
  /** Template being edited; absent when creating. */
  editing?: TaskTemplateView;
  /** Template to start from when creating (duplicate). */
  seed?: TaskTemplateView;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const [d, setD] = useState<Draft>(() => draftOf(editing ?? seed, !editing && !!seed));
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((cur) => ({ ...cur, [k]: v }));
  const criteria = lines(d.criteria);
  const names = extractPlaceholders(d.titleTemplate, d.bodyTemplate, ...criteria);
  const save = useMutation({
    mutationFn: () => {
      const fields = {
        name: d.name.trim(),
        description: d.description.trim(),
        titleTemplate: d.titleTemplate.trim(),
        bodyTemplate: d.bodyTemplate,
        acceptanceCriteria: criteria,
        size: d.size,
        model: d.model,
        labels: d.labels
          .split(',')
          .map((l) => l.trim())
          .filter(Boolean),
        dependenciesMode: d.ask ? ('ask' as const) : ('none' as const),
      };
      return editing
        ? updateTemplate(editing.id, fields)
        : createTemplate({ ...fields, scope, ...(projectId ? { projectId } : {}) });
    },
    onSuccess: async (t) => {
      toast(`Template "${t.name}" saved`);
      await qc.invalidateQueries({ queryKey: ['templates'] });
      closeModal(onClose);
    },
  });
  const [invalid, setInvalid] = useState<string | null>(null);
  const submit = () => {
    if (d.name.trim() === '') return setInvalid('Name is required.');
    if (d.bodyTemplate.trim() === '') return setInvalid('Description text is required.');
    setInvalid(null);
    save.mutate();
  };
  const title = editing ? 'Edit template' : 'New template';
  return (
    <Modal label={title} title={title} onClose={onClose} wide>
      <label className="field">
        Name
        <input
          value={d.name}
          maxLength={TEMPLATE_LIMITS.name}
          onChange={(e) => set('name', e.target.value)}
        />
      </label>
      <label className="field">
        Short description (optional)
        <input
          value={d.description}
          maxLength={TEMPLATE_LIMITS.description}
          onChange={(e) => set('description', e.target.value)}
        />
      </label>
      <label className="field">
        Title
        <input
          value={d.titleTemplate}
          placeholder="Upgrade {{package}} to {{version}}"
          onChange={(e) => set('titleTemplate', e.target.value)}
        />
      </label>
      <label className="field">
        Task description (Markdown)
        <textarea
          className="mono"
          rows={9}
          value={d.bodyTemplate}
          placeholder={'## Goal\n\nUpgrade `{{package}}` to `{{version}}`.'}
          onChange={(e) => set('bodyTemplate', e.target.value)}
        />
        <span className="hint">
          Write {'{{name}}'} where the author of a task fills in a value.
        </span>
      </label>
      <div className="tpl-slots" aria-live="polite">
        {names.length === 0 ? (
          <span className="hint">No placeholder yet.</span>
        ) : (
          <>
            <span className="hint">Fields to fill in:</span>
            {names.map((n) => (
              <mark key={n} className="slot" data-state="filled">{`{{${n}}}`}</mark>
            ))}
          </>
        )}
      </div>
      <label className="field">
        Acceptance criteria (one per line)
        <textarea rows={3} value={d.criteria} onChange={(e) => set('criteria', e.target.value)} />
      </label>
      <div className="form-grid">
        <label className="field">
          Size
          <select value={d.size} onChange={(e) => set('size', e.target.value as TaskSize)}>
            <option value="S">S</option>
            <option value="M">M</option>
            <option value="L">L</option>
          </select>
        </label>
        <label className="field">
          Model
          <select value={d.model} onChange={(e) => set('model', e.target.value as Draft['model'])}>
            <option value="SONNET">sonnet</option>
            <option value="OPUS">opus</option>
          </select>
        </label>
      </div>
      <label className="field">
        GitHub labels (comma separated, up to {TEMPLATE_LIMITS.labels})
        <input value={d.labels} onChange={(e) => set('labels', e.target.value)} />
      </label>
      <label className="check-line">
        <input type="checkbox" checked={d.ask} onChange={(e) => set('ask', e.target.checked)} />
        Remind to pick dependencies
      </label>
      {invalid && (
        <p className="error" role="alert">
          {invalid}
        </p>
      )}
      {save.error && <p className="error">{save.error.message}</p>}
      <div className="modal-actions">
        <button onClick={() => closeModal(onClose)}>Cancel</button>
        <button className="primary" disabled={save.isPending} onClick={submit}>
          Save template
        </button>
      </div>
    </Modal>
  );
}

type Dialog =
  | { kind: 'edit'; template: TaskTemplateView }
  | { kind: 'new'; seed?: TaskTemplateView }
  | { kind: 'delete'; template: TaskTemplateView };

/**
 * Lists and edits the templates of one scope: the user's own (with the read-only built-ins to
 * copy from) or a project's shared ones. Only `canManage` users see the edit controls.
 */
export function TemplatesManager({
  scope,
  projectId,
  canManage = true,
  heading = true,
}: {
  scope: 'personal' | 'project';
  projectId?: string;
  canManage?: boolean;
  /** Show the section title (hidden when the parent already provides one). */
  heading?: boolean;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const templates = useQuery({
    queryKey: ['templates', projectId ?? ''],
    queryFn: () => fetchTemplates(projectId),
  });
  const remove = useMutation({
    mutationFn: (t: TaskTemplateView) => deleteTemplate(t.id),
    onSuccess: async (_r, t) => {
      toast(`Template "${t.name}" deleted`);
      closeModal(() => setDialog(null));
      await qc.invalidateQueries({ queryKey: ['templates'] });
    },
  });
  const mine = templates.data?.filter((t) => t.scope === scope);
  const builtins = templates.data?.filter((t) => t.scope === 'builtin') ?? [];
  const list = usePresence(mine, (t) => t.id);
  const close = () => setDialog(null);
  const projectScope = scope === 'project';

  return (
    <section
      className="tpl-manager"
      aria-label={projectScope ? 'Shared templates' : 'My templates'}
    >
      <div className={heading ? 'section-title' : 'tpl-actions'}>
        {heading && <h2>{projectScope ? 'Shared templates' : 'My templates'}</h2>}
        {canManage && (
          <button className="primary" onClick={() => setDialog({ kind: 'new' })}>
            New template
          </button>
        )}
      </div>
      <p className="hint">
        {projectScope
          ? 'Everyone who can submit to this project can start a task from these. Only you can change them.'
          : 'Skeletons for work you repeat. Only you see them. The built-ins below can be copied and adapted.'}
      </p>
      {templates.isPending && <p className="hint">Loading templates...</p>}
      {templates.error && <p className="error">{templates.error.message}</p>}
      {templates.isSuccess && mine?.length === 0 && (
        <p className="empty">
          <strong>No template yet.</strong>{' '}
          {canManage
            ? 'Create one, or copy a built-in to start from a good base.'
            : 'The project owner has not shared any.'}
        </p>
      )}
      <ul className="tpl-items">
        {list.map(({ key, item: t, phase }) => (
          <TemplateItem
            key={key}
            t={t}
            phase={phase}
            actions={
              canManage ? (
                <>
                  <button onClick={() => setDialog({ kind: 'edit', template: t })}>Edit</button>
                  <button
                    className="danger"
                    onClick={() => setDialog({ kind: 'delete', template: t })}
                  >
                    Delete
                  </button>
                </>
              ) : null
            }
          />
        ))}
      </ul>
      {!projectScope && builtins.length > 0 && (
        <details className="tpl-builtins">
          <summary>Built-in templates ({builtins.length})</summary>
          <ul className="tpl-items">
            {builtins.map((t) => (
              <TemplateItem
                key={t.id}
                t={t}
                actions={
                  <button onClick={() => setDialog({ kind: 'new', seed: t })}>
                    Copy to my templates
                  </button>
                }
              />
            ))}
          </ul>
        </details>
      )}
      {dialog?.kind === 'edit' && (
        <TemplateEditor
          scope={scope}
          projectId={projectId}
          editing={dialog.template}
          onClose={close}
        />
      )}
      {dialog?.kind === 'new' && (
        <TemplateEditor scope={scope} projectId={projectId} seed={dialog.seed} onClose={close} />
      )}
      {dialog?.kind === 'delete' && (
        <Modal
          label="Delete template"
          title={`Delete "${dialog.template.name}"?`}
          onClose={close}
          closeButton={false}
          tone="danger"
        >
          <p>
            Tasks already created from it are not affected.
            {projectScope && ' Members of the project will no longer see it.'}
          </p>
          {remove.error && <p className="error">{remove.error.message}</p>}
          <div className="modal-actions">
            <button onClick={() => closeModal(close)}>Cancel</button>
            <button
              className="danger solid"
              disabled={remove.isPending}
              onClick={() => remove.mutate(dialog.template)}
            >
              Delete template
            </button>
          </div>
        </Modal>
      )}
    </section>
  );
}

function TemplateItem({
  t,
  actions,
  phase = 'idle',
}: {
  t: TaskTemplateView;
  actions: React.ReactNode;
  phase?: 'idle' | 'enter' | 'exit';
}) {
  return (
    <li className="tpl-item" {...presenceProps(phase)}>
      <span className="lamp" data-scope={t.scope} aria-hidden="true" />
      <div className="tpl-item-main">
        <strong>{t.name}</strong>
        {t.description && <span className="hint">{t.description}</span>}
        <span className="tpl-item-tags">
          <span className="tag">{SCOPE_LABEL[t.scope]}</span>
          <span className="tag">
            size {t.size} / {t.model.toLowerCase()}
          </span>
          {t.placeholders.map((p) => (
            <span key={p} className="tag">{`{{${p}}}`}</span>
          ))}
        </span>
      </div>
      <div className="tpl-item-actions">{actions}</div>
    </li>
  );
}
