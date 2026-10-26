import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { createEnrollmentToken } from '../api/endpoints';
import { CopyButton } from './CopyButton';
import { useRich, useT } from '../i18n/index.ts';
import { errorMessage } from '../i18n/errors.ts';

export const LOGIN_COMMAND = 'orch login';

export function formatCountdown(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Generates the single-use install command and shows it with a copy button and countdown. */
export function InstallCommandBlock({ big }: { big?: boolean }) {
  const t = useT();
  const rich = useRich();
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
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
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
        {data ? t('server.install.generateNew') : t('server.install.generate')}
      </button>
      {gen.error && <p className="error">{errorMessage(gen.error)}</p>}
      {data && (
        <div className="install-result reveal" key={data.installCommand}>
          <div className="warning" role="alert">
            {t('server.install.shownOnce')}
          </div>
          <p className="hint">
            {rich('server.install.installs', { code: (c) => <code>{c}</code> })}
          </p>
          <pre className="code" data-testid="install-command">
            {data.installCommand}
          </pre>
          <div className="row">
            <CopyButton text={data.installCommand} disabled={expired} big={big} />
            <span className={expired ? 'error' : 'hint'} role="timer">
              {expired
                ? t('server.install.expired')
                : t('server.install.expiresIn', { time: formatCountdown(remaining) })}
            </span>
          </div>
        </div>
      )}
    </>
  );
}

export function InstallAgentCard() {
  const t = useT();
  const rich = useRich();
  return (
    <section className="card" aria-label={t('server.install.label')}>
      <h2>{t('server.install.title')}</h2>
      <p className="hint">{t('server.install.intro')}</p>
      <InstallCommandBlock />
      <div className="subpanel">
        <h3>{t('server.install.afterwards')}</h3>
        <p className="hint">
          {rich(
            'server.install.afterwardsHint',
            { code: (c) => <code>{c}</code> },
            { take: 'orch take <n>', login: LOGIN_COMMAND },
          )}
        </p>
      </div>
    </section>
  );
}
