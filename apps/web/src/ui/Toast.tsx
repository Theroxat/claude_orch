import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { RATE_LIMITED_EVENT } from '../api/client';
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
  // The API client reports 429s here: one friendly notice, not one per failed request.
  const lastLimited = useRef(0);
  useEffect(() => {
    const onLimited = (e: Event) => {
      const now = Date.now();
      if (now - lastLimited.current < SHOW_MS) return;
      lastLimited.current = now;
      const secs = (e as CustomEvent<{ retryAfterSec?: number }>).detail?.retryAfterSec;
      push(
        secs
          ? `Too many requests. Please wait ${secs} s and try again.`
          : 'Too many requests. Please wait a moment and try again.',
        'info',
      );
    };
    window.addEventListener(RATE_LIMITED_EVENT, onLimited);
    return () => window.removeEventListener(RATE_LIMITED_EVENT, onLimited);
  }, [push]);
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
