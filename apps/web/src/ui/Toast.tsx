import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import { EXIT_MS, motionAllowed } from './motion';

type Tone = 'ok' | 'info';
type Toast = { id: number; text: string; tone: Tone; leaving: boolean };
type Push = (text: string, tone?: Tone) => void;

const ToastContext = createContext<Push>(() => undefined);
const SHOW_MS = 4000;
let nextId = 1;

/** Short confirmations after an action ("Token revoked"). Announced politely to screen readers. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback<Push>((text, tone = 'ok') => {
    const id = nextId++;
    setToasts((l) => [...l.slice(-2), { id, text, tone, leaving: false }]);
    const exit = motionAllowed() ? EXIT_MS : 0;
    setTimeout(() => {
      setToasts((l) => l.map((t) => (t.id === id ? { ...t, leaving: true } : t)));
      setTimeout(() => setToasts((l) => l.filter((t) => t.id !== id)), exit);
    }, SHOW_MS);
  }, []);
  return (
    <ToastContext value={push}>
      {children}
      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <p key={t.id} className="toast" data-tone={t.tone} data-leaving={t.leaving || undefined}>
            <span className="lamp" aria-hidden="true" />
            {t.text}
          </p>
        ))}
      </div>
    </ToastContext>
  );
}

export function useToast(): Push {
  return useContext(ToastContext);
}
