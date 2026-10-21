import { useMutation, useQuery } from '@tanstack/react-query';
import { OAuthConsentInfoSchema, OAuthConsentResultSchema } from '@orch/shared';
import { useLocation } from 'react-router';
import { ApiError, api } from '../api/client';
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
  const decide = useMutation({
    mutationFn: (approve: boolean) =>
      api('POST', '/oauth/consent', {
        body: { ...params, approve },
        schema: OAuthConsentResultSchema,
      }),
    onSuccess: (r) => window.location.assign(r.redirectTo),
  });

  if (info.error) {
    return (
      <div className="gate">
        <section className="card consent" aria-label="Authorize application">
          <Brand />
          <h2>Authorization request rejected</h2>
          <p className="error">{info.error.message}</p>
        </section>
      </div>
    );
  }
  if (!info.data) {
    return (
      <div className="gate">
        <section className="card consent" aria-label="Authorize application">
          <p className="hint">Loading...</p>
        </section>
      </div>
    );
  }
  const d = info.data;
  // Still disabled after success: the page is navigating away, a second POST would mint a code.
  const busy = decide.isPending || decide.isSuccess;
  return (
    <div className="gate">
      <section className="card consent" aria-label="Authorize application">
        <Brand />
        <h2>Authorize {d.clientName}</h2>
        <p>
          <strong>{d.clientName}</strong> (redirect to <code>{d.redirectHost}</code>) wants to use
          orch&apos;s MCP tools (view the pool, list, submit and take tasks) as{' '}
          <strong>{d.login}</strong>.
        </p>
        <p className="warning">Only approve if you just started this from Claude Code.</p>
        {decide.error && <p className="error">{decide.error.message}</p>}
        <div className="card-foot">
          <button className="primary" disabled={busy} onClick={() => decide.mutate(true)}>
            Approve
          </button>
          <button disabled={busy} onClick={() => decide.mutate(false)}>
            Deny
          </button>
        </div>
      </section>
    </div>
  );
}
