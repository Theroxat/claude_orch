import { useQuery } from '@tanstack/react-query';
import type { TaskTemplateView } from '@orch/shared';
import { useId, useRef, useState } from 'react';
import { fetchTemplates } from '../api/endpoints';
import { errorMessage } from '../i18n/errors.ts';
import { useRich, useT, type MessageKey } from '../i18n/index.ts';

export const SCOPE_KEY = {
  builtin: 'templates.scope.builtin',
  personal: 'templates.scope.personal',
  project: 'templates.scope.project',
} as const satisfies Record<TaskTemplateView['scope'], MessageKey>;

/** "Start from a template": a collapsible list with search. Picking one reports it upward. */
export function TemplatePicker({
  projectId,
  selected,
  onPick,
  onClear,
}: {
  projectId: string;
  selected: TaskTemplateView | null;
  onPick: (tpl: TaskTemplateView) => void;
  onClear: () => void;
}) {
  const t = useT();
  const rich = useRich();
  const uid = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const toggle = useRef<HTMLButtonElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const templates = useQuery({
    queryKey: ['templates', projectId],
    queryFn: () => fetchTemplates(projectId || undefined),
  });
  const q = query.trim().toLowerCase();
  const shown = (templates.data ?? []).filter(
    (tpl) =>
      q === '' ||
      tpl.name.toLowerCase().includes(q) ||
      tpl.description.toLowerCase().includes(q) ||
      tpl.labels.some((l) => l.toLowerCase().includes(q)),
  );
  return (
    <div className="tpl-picker">
      <div className="tpl-bar">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={`${uid}-panel`}
          ref={toggle}
          onClick={() => {
            if (!open) {
              setOpen(true);
              // The panel is inert while closed: focus the search once it is live.
              requestAnimationFrame(() => search.current?.focus());
            } else setOpen(false);
          }}
        >
          {t('templates.picker.start')}
        </button>
        {selected && (
          <span className="tpl-chosen">
            <span className="lamp" data-scope={selected.scope} aria-hidden="true" />
            <span>
              {rich(
                'templates.picker.using',
                { strong: (c) => <strong>{c}</strong> },
                { name: selected.name },
              )}
            </span>
            <button
              type="button"
              className="ghost"
              onClick={() => {
                onClear();
                toggle.current?.focus();
              }}
            >
              {t('templates.picker.remove')}
            </button>
          </span>
        )}
      </div>
      <div className="tpl-panel" id={`${uid}-panel`} data-open={open || undefined}>
        <div className="tpl-panel-inner" inert={!open}>
          <label className="field">
            {t('templates.picker.search')}
            <input
              type="search"
              ref={search}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('templates.picker.searchPlaceholder')}
            />
          </label>
          {templates.isPending && <p className="hint">{t('templates.picker.loading')}</p>}
          {templates.error && <p className="error">{errorMessage(templates.error)}</p>}
          {templates.isSuccess && shown.length === 0 && (
            <p className="hint">{t('templates.picker.noMatch', { query: query.trim() })}</p>
          )}
          <ul className="tpl-list">
            {shown.map((tpl) => (
              <li key={tpl.id}>
                <button
                  type="button"
                  className="tpl-row"
                  aria-pressed={selected?.id === tpl.id}
                  onClick={() => {
                    onPick(tpl);
                    setOpen(false);
                    // The focused row is about to become inert: keep focus on the toggle.
                    toggle.current?.focus();
                  }}
                >
                  <span className="lamp" data-scope={tpl.scope} aria-hidden="true" />
                  <span className="tpl-row-main">
                    <span className="tpl-row-name">{tpl.name}</span>
                    {tpl.description && <span className="tpl-row-desc">{tpl.description}</span>}
                  </span>
                  <span className="tag">{t(SCOPE_KEY[tpl.scope])}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
