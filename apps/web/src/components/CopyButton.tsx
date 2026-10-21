import { useState } from 'react';

/** Copies `text` to the clipboard; shows an inline hint when the clipboard is unavailable. */
export function CopyButton({
  text,
  label = 'Copy',
  copiedLabel = 'Copied',
  disabled,
  big,
}: {
  text: string | undefined;
  label?: string;
  copiedLabel?: string;
  disabled?: boolean;
  big?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const copy = async () => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  };
  return (
    <>
      <button
        className={big ? 'primary big' : undefined}
        onClick={() => void copy()}
        disabled={disabled || !text}
      >
        {copied ? copiedLabel : label}
      </button>
      {failed && <p className="error">Copy failed. Select the command and copy it by hand.</p>}
    </>
  );
}
