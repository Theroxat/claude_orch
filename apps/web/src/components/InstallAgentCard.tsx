import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { createEnrollmentToken } from '../api/endpoints';

export const LOGIN_COMMAND = 'docker compose -f ~/orch/compose.yaml exec agent orch login';

export function formatCountdown(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function InstallAgentCard() {
  const qc = useQueryClient();
  const gen = useMutation({
    mutationFn: createEnrollmentToken,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['agents'] }),
  });
  const [now, setNow] = useState(() => Date.now());
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const data = gen.data;

  useEffect(() => {
    if (!data) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [data]);

  const remaining = data ? new Date(data.expiresAt).getTime() - now : 0;
  const expired = !!data && remaining <= 0;

  const copy = async () => {
    if (!data) return;
    try {
      await navigator.clipboard.writeText(data.installCommand);
      setCopied(true);
      setCopyError(false);
    } catch {
      setCopyError(true);
    }
  };

  return (
    <section className="card" aria-label="Install the agent">
      <h2>Install the agent</h2>
      <p className="hint">
        Run the generated command on the machine that has your Claude subscription. Docker is
        required.
      </p>
      <button
        className="primary"
        disabled={gen.isPending}
        onClick={() => {
          setCopied(false);
          gen.mutate();
        }}
      >
        {data ? 'Generate a new command' : 'Generate install command'}
      </button>
      {gen.error && <p className="error">{gen.error.message}</p>}
      {data && (
        <div className="install-result">
          <div className="warning" role="alert">
            Shown once: this command contains a single-use token. Copy it now, it cannot be
            displayed again.
          </div>
          <pre className="code" data-testid="install-command">
            {data.installCommand}
          </pre>
          <div className="row">
            <button onClick={() => void copy()} disabled={expired}>
              {copied ? 'Copied' : 'Copy'}
            </button>
            <span className={expired ? 'error' : 'hint'} role="timer">
              {expired
                ? 'Token expired. Generate a new one.'
                : `Expires in ${formatCountdown(remaining)}`}
            </span>
          </div>
          {copyError && (
            <p className="error">Copy failed. Select the command and copy it by hand.</p>
          )}
        </div>
      )}
      <h3>Next step</h3>
      <p className="hint">Once the agent is running, sign in to Claude once on that machine:</p>
      <pre className="code">{LOGIN_COMMAND}</pre>
    </section>
  );
}
