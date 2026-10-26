import {
  ViewTransition,
  startTransition,
  useEffect,
  useEffectEvent,
  useRef,
  type ReactNode,
} from 'react';
import { useT } from '../i18n/index.ts';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Dialog shell: focus moves in on open and back on close, Tab stays inside, Escape and a
 * click on the backdrop close it. Opening animates with CSS; closing runs inside a React
 * transition so the exit plays as a view transition.
 */
export function Modal({
  label,
  title,
  onClose,
  closeButton = true,
  tone,
  wide,
  side,
  children,
}: {
  label: string;
  title: ReactNode;
  onClose: () => void;
  closeButton?: boolean;
  tone?: 'danger';
  wide?: boolean;
  /** A tall sheet docked to the right edge (a bottom sheet on phones), e.g. a log viewer. */
  side?: boolean;
  children: ReactNode;
}) {
  const t = useT();
  const panel = useRef<HTMLDivElement>(null);
  const close = () => startTransition(onClose);
  const onKey = useEffectEvent((e: KeyboardEvent) => {
    const el = panel.current;
    if (!el) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      startTransition(onClose);
      return;
    }
    if (e.key !== 'Tab') return;
    const items = [...el.querySelectorAll<HTMLElement>(FOCUSABLE)];
    const first = items[0];
    const last = items[items.length - 1];
    if (!first || !last) return;
    if (e.shiftKey && (document.activeElement === first || document.activeElement === el)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  });

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panel.current?.focus({ preventScroll: true });
    const listener = (e: KeyboardEvent) => onKey(e);
    document.addEventListener('keydown', listener);
    return () => {
      document.removeEventListener('keydown', listener);
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, []);

  return (
    <ViewTransition enter="none" exit="modal-out" update="none" default="none">
      <div
        className={`modal-backdrop${side ? ' side' : ''}`}
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) close();
        }}
      >
        <div
          ref={panel}
          className={`modal${wide ? ' wide' : ''}${side ? ' side' : ''}`}
          data-tone={tone}
          role="dialog"
          aria-modal="true"
          aria-label={label}
          tabIndex={-1}
        >
          <header className="modal-head">
            <h2>{title}</h2>
            {closeButton && (
              <button type="button" className="ghost" onClick={close}>
                {t('common.actions.close')}
              </button>
            )}
          </header>
          <div className="modal-body">{children}</div>
        </div>
      </div>
    </ViewTransition>
  );
}

/** Closes from a mutation callback or a button inside the dialog, with the exit animation. */
export function closeModal(fn: () => void) {
  startTransition(fn);
}
