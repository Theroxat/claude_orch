import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { createEnrollmentToken } from '../api/endpoints';
import { CopyButton } from './CopyButton';

export const LOGIN_COMMAND = 'orch login';

export function formatCountdown(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Generates the single-use install command and shows it with a copy button and countdown. */
export function InstallCommandBlock({ big }: { big?: boolean }) {
  const qc = useQueryClient();
  const gen = useMutation({
    mutationFn: createEnrollmentToken,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['agents'] }),
  });
  const [now, setNow] = useState(() => Date.now());
  const data = gen.data;

  useEffect(() => {
    if (!data) return;
    // Sync the clock when a new token arrives, before the first interval tick.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [data]);

  const remaining = data ? new Date(data.expiresAt).getTime() - now : 0;
  const expired = !!data && remaining <= 0;

  return (
    <>
      <button
        className={big ? 'primary big' : 'primary'}
        disabled={gen.isPending}
        onClick={() => {
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
          <p className="hint">
            This installs the agent, connects your Claude account, and adds the <code>orch</code>{' '}
            command.
          </p>
          <pre className="code" data-testid="install-command">
            {data.installCommand}
          </pre>
          <div className="row">
            <CopyButton text={data.installCommand} disabled={expired} big={big} />
            <span className={expired ? 'error' : 'hint'} role="timer">
              {expired
                ? 'Token expired. Generate a new one.'
                : `Expires in ${formatCountdown(remaining)}`}
            </span>
          </div>
        </div>
      )}
    </>
  );
}

export function InstallAgentCard() {
  return (
    <section className="card" aria-label="Install the agent">
      <h2>Install the agent</h2>
      <p className="hint">
        Run one command on the machine that has your Claude subscription. Docker is required.
      </p>
      <InstallCommandBlock />
      <h3>Afterwards</h3>
      <p className="hint">
        Use <code>orch status</code> to check the agent, <code>orch take &lt;n&gt;</code> to take a
        task, and <code>{LOGIN_COMMAND}</code> if you need to sign in to Claude again.
      </p>
    </section>
  );
}
