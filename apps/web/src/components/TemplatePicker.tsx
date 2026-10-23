import { useQuery } from '@tanstack/react-query';
import type { TaskTemplateView } from '@orch/shared';
import { useId, useState } from 'react';
import { fetchTemplates } from '../api/endpoints';

export const SCOPE_LABEL = {
  builtin: 'Built-in',
  personal: 'Personal',
  project: 'Shared',
} as const;

/** "Start from a template": a collapsible list with search. Picking one reports it upward. */
export function TemplatePicker({
  projectId,
  selected,
  onPick,
  onClear,
}: {
  projectId: string;
  selected: TaskTemplateView | null;
  onPick: (t: TaskTemplateView) => void;
  onClear: () => void;
}) {
  const uid = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const templates = useQuery({
    queryKey: ['templates', projectId],
    queryFn: () => fetchTemplates(projectId || undefined),
  });
  const q = query.trim().toLowerCase();
  const shown = (templates.data ?? []).filter(
    (t) =>
      q === '' ||
      t.name.toLowerCase().includes(q) ||
      t.description.toLowerCase().includes(q) ||
      t.labels.some((l) => l.toLowerCase().includes(q)),
  );
  return (
    <div className="tpl-picker">
      <div className="tpl-bar">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={`${uid}-panel`}
          onClick={() => setOpen((o) => !o)}
        >
          Start from a template
        </button>
        {selected && (
          <span className="tpl-chosen">
            <span className="lamp" data-scope={selected.scope} aria-hidden="true" />
            <span>
              Using <strong>{selected.name}</strong>
            </span>
            <button type="button" className="ghost" onClick={onClear}>
              Remove template
            </button>
          </span>
        )}
      </div>
      <div className="tpl-panel" id={`${uid}-panel`} data-open={open || undefined}>
        <div className="tpl-panel-inner" inert={!open}>
          <label className="field">
            Search templates
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="bug, upgrade, tests..."
            />
          </label>
          {templates.isPending && <p className="hint">Loading templates...</p>}
          {templates.error && <p className="error">{templates.error.message}</p>}
          {templates.isSuccess && shown.length === 0 && (
            <p className="hint">No template matches "{query.trim()}".</p>
          )}
          <ul className="tpl-list">
            {shown.map((t) => (
              <li key={t.id}>
                <button
                  type="button"
                  className="tpl-row"
                  aria-pressed={selected?.id === t.id}
                  onClick={() => {
                    onPick(t);
                    setOpen(false);
                  }}
                >
                  <span className="lamp" data-scope={t.scope} aria-hidden="true" />
                  <span className="tpl-row-main">
                    <span className="tpl-row-name">{t.name}</span>
                    {t.description && <span className="tpl-row-desc">{t.description}</span>}
                  </span>
                  <span className="tag">{SCOPE_LABEL[t.scope]}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
