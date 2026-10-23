import { placeholdersOf, sanitizeValue, splitTemplate, type TaskTemplateView } from '@orch/shared';
import { useId, type ReactNode } from 'react';

const humanize = (name: string) => {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/_+/g, ' ')
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

/** A template text with its placeholders shown as slots: dashed while empty, lit once filled. */
function Slots({ text, values }: { text: string; values: Record<string, string> }): ReactNode {
  return splitTemplate(text).map((p, i) => {
    if (p.type === 'text') return p.value;
    const v = sanitizeValue(values[p.name] ?? '');
    return v === '' ? (
      <mark key={i} className="slot" data-state="empty">
        {`{{${p.name}}}`}
      </mark>
    ) : (
      <mark key={i} className="slot" data-state="filled">
        {v}
      </mark>
    );
  });
}

/**
 * The fields of a template's placeholders and a live preview of the task they produce.
 * Filling a field lights its slot in the preview.
 */
export function TemplateFill({
  template,
  values,
  onChange,
}: {
  template: TaskTemplateView;
  values: Record<string, string>;
  onChange: (name: string, value: string) => void;
}) {
  const uid = useId();
  const names = placeholdersOf(template);
  const inTitle = new Set(
    splitTemplate(template.titleTemplate).flatMap((p) => (p.type === 'slot' ? [p.name] : [])),
  );
  const filled = names.filter((n) => sanitizeValue(values[n] ?? '') !== '').length;
  return (
    <div className="tpl-fill">
      {names.length > 0 && (
        <fieldset className="tpl-fields">
          <legend>
            Fill in the template{' '}
            <span className="tpl-count" aria-label={`${filled} of ${names.length} filled`}>
              {filled}/{names.length}
            </span>
          </legend>
          {names.map((n) => {
            const id = `${uid}-${n}`;
            return (
              <label key={n} className="field" htmlFor={id}>
                {humanize(n)}
                {inTitle.has(n) ? (
                  <input
                    id={id}
                    value={values[n] ?? ''}
                    onChange={(e) => onChange(n, e.target.value)}
                  />
                ) : (
                  <textarea
                    id={id}
                    rows={2}
                    value={values[n] ?? ''}
                    onChange={(e) => onChange(n, e.target.value)}
                  />
                )}
              </label>
            );
          })}
        </fieldset>
      )}
      <section className="tpl-preview" aria-label="Preview">
        <h3>{<Slots text={template.titleTemplate || template.name} values={values} />}</h3>
        <pre>
          <Slots text={template.bodyTemplate} values={values} />
        </pre>
        {template.acceptanceCriteria.length > 0 && (
          <ul>
            {template.acceptanceCriteria.map((c, i) => (
              <li key={i}>
                <Slots text={c} values={values} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
