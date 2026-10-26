import { useMutation, useQuery } from '@tanstack/react-query';
import { OAuthConsentInfoSchema, OAuthConsentResultSchema } from '@orch/shared';
import { useRef } from 'react';
import { useLocation } from 'react-router';
import { ApiError, api } from '../api/client';
import { errorMessage } from '../i18n/errors.ts';
import { useRich, useT } from '../i18n/index.ts';
import { Brand } from '../ui/Brand';

const KEYS = [
  'response_type',
  'client_id',
  'redirect_uri',
  'code_challenge',
  'code_challenge_method',
  'state',
  'scope',
  'resource',
] as const;

export function OAuthConsent() {
  const t = useT();
  const rich = useRich();
  const { search } = useLocation();
  const sp = new URLSearchParams(search);
  const params: Record<string, string> = {};
  for (const k of KEYS) {
    const v = sp.get(k);
    if (v !== null) params[k] = v;
  }
  const qs = new URLSearchParams(params).toString();
  const info = useQuery({
    queryKey: ['oauth-consent', qs],
    retry: false,
    queryFn: async () => {
      try {
        return await api('GET', `/oauth/consent?${qs}`, { schema: OAuthConsentInfoSchema });
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) {
          window.location.assign(
            '/api/auth/github/login?next=' + encodeURIComponent('/oauth/consent' + search),
          );
          return new Promise<never>(() => undefined);
        }
        throw e;
      }
    },
  });
  // Synchronous guard: two clicks in the same tick both see isPending=false, so state is not enough.
  const sent = useRef(false);
  const decide = useMutation({
    mutationFn: (approve: boolean) =>
      api('POST', '/oauth/consent', {
        body: { ...params, approve },
        schema: OAuthConsentResultSchema,
      }),
    onSuccess: (r) => window.location.assign(r.redirectTo),
    onError: () => {
      sent.current = false;
    },
  });
  const decideOnce = (approve: boolean) => {
    if (sent.current) return;
    sent.current = true;
    decide.mutate(approve);
  };

  if (info.error) {
    return (
      <div className="gate">
        <section className="card consent" aria-label={t('auth.consent.ariaLabel')}>
          <Brand />
          <h2>{t('auth.consent.rejected')}</h2>
          <p className="error">{errorMessage(info.error)}</p>
        </section>
      </div>
    );
  }
  if (!info.data) {
    return (
      <div className="gate">
        <section className="card consent" aria-label={t('auth.consent.ariaLabel')}>
          <p className="hint">{t('common.status.loading')}</p>
        </section>
      </div>
    );
  }
  const d = info.data;
  // Still disabled after success: the page is navigating away, a second POST would mint a code.
  const busy = decide.isPending || decide.isSuccess;
  return (
    <div className="gate">
      <section className="card consent" aria-label={t('auth.consent.ariaLabel')}>
        <Brand />
        <h2>{t('auth.consent.title', { client: d.clientName })}</h2>
        <p>
          {rich(
            'auth.consent.body',
            { strong: (c) => <strong>{c}</strong>, code: (c) => <code>{c}</code> },
            { client: d.clientName, host: d.redirectHost, login: d.login },
          )}
        </p>
        <p className="warning">{t('auth.consent.warning')}</p>
        {decide.error && <p className="error">{errorMessage(decide.error)}</p>}
        <div className="card-foot">
          <button className="primary" disabled={busy} onClick={() => decideOnce(true)}>
            {t('auth.consent.approve')}
          </button>
          <button disabled={busy} onClick={() => decideOnce(false)}>
            {t('auth.consent.deny')}
          </button>
        </div>
      </section>
    </div>
  );
}
