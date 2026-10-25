import { useEffect, useState } from 'react';
import { useT } from '../i18n/index.ts';
import { Icon } from '../ui/Icon';

const RESET_MS = 2500;

/** Copies `text` to the clipboard; shows an inline hint when the clipboard is unavailable. */
export function CopyButton({
  text,
  label,
  copiedLabel,
  disabled,
  big,
}: {
  text: string | undefined;
  label?: string;
  copiedLabel?: string;
  disabled?: boolean;
  big?: boolean;
}) {
  const t = useT();
  const [copied, setCopied] = useState(0);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(0), RESET_MS);
    return () => clearTimeout(t);
  }, [copied]);
  const copy = async () => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied((n) => n + 1);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  };
  return (
    <>
      <button
        type="button"
        className={`copy-button${big ? ' primary big' : ''}`}
        data-copied={copied > 0 || undefined}
        onClick={() => void copy()}
        disabled={disabled || !text}
      >
        <Icon key={copied} name={copied ? 'check' : 'copy'} />
        <span aria-live="polite">
          {copied
            ? (copiedLabel ?? t('common.actions.copied'))
            : (label ?? t('common.actions.copy'))}
        </span>
      </button>
      {failed && <p className="error">{t('layout.copy.failed')}</p>}
    </>
  );
}
