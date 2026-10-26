import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  TEMPLATE_LIMITS,
  extractPlaceholders,
  type TaskSize,
  type TaskTemplateView,
} from '@orch/shared';
import { useState } from 'react';
import { createTemplate, deleteTemplate, fetchTemplates, updateTemplate } from '../api/endpoints';
import { errorMessage } from '../i18n/errors.ts';
import { t as tg, useT } from '../i18n/index.ts';
import { Modal, closeModal } from '../ui/Modal';
import { presenceProps, usePresence } from '../ui/presence';
import { useToast } from '../ui/Toast';
import { SCOPE_KEY } from './TemplatePicker';

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
  name: t ? (copy ? tg('templates.editor.copyName', { name: t.name }) : t.name) : '',
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
  const t = useT();
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
    onSuccess: async (saved) => {
      toast(t('templates.editor.saved', { name: saved.name }));
      await qc.invalidateQueries({ queryKey: ['templates'] });
      closeModal(onClose);
    },
  });
  const [invalid, setInvalid] = useState<
    'templates.editor.nameRequired' | 'templates.editor.bodyRequired' | null
  >(null);
  const submit = () => {
    if (d.name.trim() === '') return setInvalid('templates.editor.nameRequired');
    if (d.bodyTemplate.trim() === '') return setInvalid('templates.editor.bodyRequired');
    setInvalid(null);
    save.mutate();
  };
  const title = editing ? t('templates.editor.titleEdit') : t('templates.editor.titleNew');
  return (
    <Modal label={title} title={title} onClose={onClose} wide>
      <label className="field">
        {t('templates.editor.name')}
        <input
          value={d.name}
          maxLength={TEMPLATE_LIMITS.name}
          onChange={(e) => set('name', e.target.value)}
        />
      </label>
      <label className="field">
        {t('templates.editor.description')}
        <input
          value={d.description}
          maxLength={TEMPLATE_LIMITS.description}
          onChange={(e) => set('description', e.target.value)}
        />
      </label>
      <label className="field">
        {t('templates.editor.title')}
        <input
          value={d.titleTemplate}
          placeholder={t('templates.editor.titlePlaceholder', {
            package: '{{package}}',
            version: '{{version}}',
          })}
          onChange={(e) => set('titleTemplate', e.target.value)}
        />
      </label>
      <label className="field">
        {t('templates.editor.body')}
        <textarea
          className="mono"
          rows={9}
          value={d.bodyTemplate}
          placeholder={t('templates.editor.bodyPlaceholder', {
            package: '{{package}}',
            version: '{{version}}',
          })}
          onChange={(e) => set('bodyTemplate', e.target.value)}
        />
        <span className="hint">{t('templates.editor.bodyHint', { slot: '{{name}}' })}</span>
      </label>
      <div className="tpl-slots" aria-live="polite">
        {names.length === 0 ? (
          <span className="hint">{t('templates.editor.noSlots')}</span>
        ) : (
          <>
            <span className="hint">{t('templates.editor.slots')}</span>
            {names.map((n) => (
              <mark key={n} className="slot" data-state="filled">{`{{${n}}}`}</mark>
            ))}
          </>
        )}
      </div>
      <label className="field">
        {t('templates.editor.criteria')}
        <textarea rows={3} value={d.criteria} onChange={(e) => set('criteria', e.target.value)} />
      </label>
      <div className="form-grid">
        <label className="field">
          {t('templates.editor.size')}
          <select value={d.size} onChange={(e) => set('size', e.target.value as TaskSize)}>
            <option value="S">S</option>
            <option value="M">M</option>
            <option value="L">L</option>
          </select>
        </label>
        <label className="field">
          {t('templates.editor.model')}
          <select value={d.model} onChange={(e) => set('model', e.target.value as Draft['model'])}>
            <option value="SONNET">sonnet</option>
            <option value="OPUS">opus</option>
          </select>
        </label>
      </div>
      <label className="field">
        {t('templates.editor.labels', { max: TEMPLATE_LIMITS.labels })}
        <input value={d.labels} onChange={(e) => set('labels', e.target.value)} />
      </label>
      <label className="check-line">
        <input type="checkbox" checked={d.ask} onChange={(e) => set('ask', e.target.checked)} />
        {t('templates.editor.askDependencies')}
      </label>
      {invalid && (
        <p className="error" role="alert">
          {t(invalid)}
        </p>
      )}
      {save.error && <p className="error">{errorMessage(save.error)}</p>}
      <div className="modal-actions">
        <button onClick={() => closeModal(onClose)}>{t('common.actions.cancel')}</button>
        <button className="primary" disabled={save.isPending} onClick={submit}>
          {t('templates.editor.save')}
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
  const t = useT();
  const qc = useQueryClient();
  const toast = useToast();
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const templates = useQuery({
    queryKey: ['templates', projectId ?? ''],
    queryFn: () => fetchTemplates(projectId),
  });
  const remove = useMutation({
    mutationFn: (tpl: TaskTemplateView) => deleteTemplate(tpl.id),
    onSuccess: async (_r, tpl) => {
      toast(t('templates.manager.deleted', { name: tpl.name }));
      closeModal(() => setDialog(null));
      await qc.invalidateQueries({ queryKey: ['templates'] });
    },
  });
  const mine = templates.data?.filter((x) => x.scope === scope);
  const builtins = templates.data?.filter((x) => x.scope === 'builtin') ?? [];
  const list = usePresence(mine, (x) => x.id);
  const close = () => setDialog(null);
  const projectScope = scope === 'project';

  return (
    <section
      className="tpl-manager"
      aria-label={projectScope ? t('templates.manager.shared') : t('templates.manager.mine')}
    >
      <div className={heading ? 'section-title' : 'tpl-actions'}>
        {heading && (
          <h2>{projectScope ? t('templates.manager.shared') : t('templates.manager.mine')}</h2>
        )}
        {canManage && (
          <button className="primary" onClick={() => setDialog({ kind: 'new' })}>
            {t('templates.manager.new')}
          </button>
        )}
      </div>
      <p className="hint">
        {projectScope ? t('templates.manager.hintShared') : t('templates.manager.hintMine')}
      </p>
      {templates.isPending && <p className="hint">{t('templates.manager.loading')}</p>}
      {templates.error && <p className="error">{errorMessage(templates.error)}</p>}
      {templates.isSuccess && mine?.length === 0 && (
        <p className="empty">
          <strong>{t('templates.manager.emptyTitle')}</strong>{' '}
          {canManage ? t('templates.manager.emptyCanManage') : t('templates.manager.emptyReadOnly')}
        </p>
      )}
      <ul className="tpl-items">
        {list.map(({ key, item: tpl, phase }) => (
          <TemplateItem
            key={key}
            t={tpl}
            phase={phase}
            actions={
              canManage ? (
                <>
                  <button onClick={() => setDialog({ kind: 'edit', template: tpl })}>
                    {t('common.actions.edit')}
                  </button>
                  <button
                    className="danger"
                    onClick={() => setDialog({ kind: 'delete', template: tpl })}
                  >
                    {t('common.actions.delete')}
                  </button>
                </>
              ) : null
            }
          />
        ))}
      </ul>
      {!projectScope && builtins.length > 0 && (
        <details className="tpl-builtins">
          <summary>{t('templates.manager.builtins', { count: builtins.length })}</summary>
          <ul className="tpl-items">
            {builtins.map((tpl) => (
              <TemplateItem
                key={tpl.id}
                t={tpl}
                actions={
                  <button onClick={() => setDialog({ kind: 'new', seed: tpl })}>
                    {t('templates.manager.copyToMine')}
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
          label={t('templates.manager.deleteLabel')}
          title={t('templates.manager.deleteTitle', { name: dialog.template.name })}
          onClose={close}
          closeButton={false}
          tone="danger"
        >
          <p>
            {projectScope
              ? t('templates.manager.deleteNoteShared')
              : t('templates.manager.deleteNote')}
          </p>
          {remove.error && <p className="error">{errorMessage(remove.error)}</p>}
          <div className="modal-actions">
            <button onClick={() => closeModal(close)}>{t('common.actions.cancel')}</button>
            <button
              className="danger solid"
              disabled={remove.isPending}
              onClick={() => remove.mutate(dialog.template)}
            >
              {t('templates.manager.deleteLabel')}
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
  const tr = useT();
  return (
    <li className="tpl-item" {...presenceProps(phase)}>
      <span className="lamp" data-scope={t.scope} aria-hidden="true" />
      <div className="tpl-item-main">
        <strong>{t.name}</strong>
        {t.description && <span className="hint">{t.description}</span>}
        <span className="tpl-item-tags">
          <span className="tag">{tr(SCOPE_KEY[t.scope])}</span>
          <span className="tag">
            {tr('templates.manager.sizeModel', { size: t.size, model: t.model.toLowerCase() })}
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
