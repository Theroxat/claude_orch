import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { Link, useLocation } from 'react-router';
import { ApiError } from '../api/client';
import { confirmNotificationEmail } from '../api/endpoints';
import { errorMessage } from '../i18n/errors.ts';
import { useRich, useT } from '../i18n/index.ts';
import { Brand } from '../ui/Brand';

/**
 * Landing page of the link in the confirmation e-mail. Opening it only shows a button: the
 * address is confirmed by the POST behind it, so link prefetchers and scanners cannot do it.
 */
export function ConfirmEmail() {
  const t = useT();
  const rich = useRich();
  const token = new URLSearchParams(useLocation().search).get('token') ?? '';
  const qc = useQueryClient();
  // Synchronous guard against a double click (the token is single-use).
  const sent = useRef(false);
  const confirm = useMutation({
    mutationFn: () => confirmNotificationEmail(token),
    onSuccess: (view) => qc.setQueryData(['notifications', 'settings'], view),
    onError: () => {
      sent.current = false;
    },
  });
  const run = () => {
    if (sent.current) return;
    sent.current = true;
    confirm.mutate();
  };

  return (
    <div className="gate">
      <section className="card consent confirm-email" aria-label={t('auth.confirmEmail.ariaLabel')}>
        <Brand />
        {confirm.isSuccess ? (
          <>
            <h2>{t('auth.confirmEmail.doneTitle')}</h2>
            <p className="lede">
              {rich(
                'auth.confirmEmail.doneBody',
                { strong: (c) => <strong>{c}</strong> },
                { address: confirm.data.email.address },
              )}
            </p>
            <div className="card-foot">
              <Link to="/my-server#notifications">{t('auth.confirmEmail.settings')}</Link>
            </div>
          </>
        ) : (
          <>
            <h2>{t('auth.confirmEmail.title')}</h2>
            {token ? (
              <p className="lede">{t('auth.confirmEmail.lede')}</p>
            ) : (
              <p className="error">{t('auth.confirmEmail.incomplete')}</p>
            )}
            {confirm.error && (
              <p className="error" role="alert">
                {confirm.error instanceof ApiError && confirm.error.status === 400
                  ? t('auth.confirmEmail.invalid')
                  : errorMessage(confirm.error)}
              </p>
            )}
            <div className="card-foot">
              <button
                type="button"
                className="primary"
                disabled={!token || confirm.isPending}
                onClick={run}
              >
                {t('auth.confirmEmail.confirm')}
              </button>
              <Link to="/my-server#notifications">{t('auth.confirmEmail.settings')}</Link>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
