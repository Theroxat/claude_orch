import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Fragment, useState } from 'react';
import { useMe } from '../auth';
import {
  createInvite,
  decideGrant,
  fetchAccess,
  preApprove,
  revokeInvite,
  type AccessGrant,
  type AccessInvite,
} from '../api/endpoints';
import { CopyButton } from '../components/CopyButton';
import { errorMessage } from '../i18n/errors.ts';
import { formatDate } from '../i18n/format.ts';
import { useT, type MessageKey } from '../i18n/index.ts';
import { presenceProps, usePresence } from '../ui/presence';
import { useToast } from '../ui/Toast';

const KEY = ['admin', 'access'];
const COUNT_KEY = ['admin', 'pending-count'];

const EXPIRIES = [
  { hours: 24, label: 'admin.invites.expiry.h24' },
  { hours: 168, label: 'admin.invites.expiry.h168' },
  { hours: 720, label: 'admin.invites.expiry.h720' },
] as const satisfies ReadonlyArray<{ hours: number; label: MessageKey }>;

/** Same fields as `toLocaleString()`: date and time with seconds, in the active locale. */
const DATE_TIME: Intl.DateTimeFormatOptions = {
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: 'numeric',
  minute: 'numeric',
  second: 'numeric',
};

function Avatar({ g }: { g: AccessGrant }) {
  return (
    <img
      className="avatar"
      // avatars.githubusercontent.com: the only image host the CSP allows (github.com is not).
      src={
        g.avatarUrl ??
        `https://avatars.githubusercontent.com/${encodeURIComponent(g.githubLogin)}?size=64`
      }
      alt=""
    />
  );
}

function inviteStatus(i: AccessInvite) {
  if (i.revokedAt) return 'revoked';
  if (new Date(i.expiresAt).getTime() <= Date.now()) return 'expired';
  if (!i.multiUse && i.uses > 0) return 'used';
  return i.active ? 'active' : 'inactive';
}

export function AdminAccess() {
  const t = useT();
  const me = useMe().data;
  const qc = useQueryClient();
  const toast = useToast();
  const [login, setLogin] = useState('');
  const [multiUse, setMultiUse] = useState(false);
  const [hours, setHours] = useState(24);
  const [created, setCreated] = useState<string | null>(null);
  // One slot for the last failed action: starting any new action clears it, so an old failure
  // never lingers once something else has succeeded.
  const [actionError, setActionError] = useState<string | null>(null);
  const tracked = {
    onMutate: () => setActionError(null),
    onError: (e: unknown) => setActionError(errorMessage(e)),
  };
  const access = useQuery({
    queryKey: KEY,
    queryFn: fetchAccess,
    enabled: !!me?.isAdmin,
    refetchInterval: 30_000,
  });
  const refresh = async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: KEY }),
      qc.invalidateQueries({ queryKey: COUNT_KEY }),
    ]);
  };
  const decide = useMutation({
    ...tracked,
    mutationFn: (v: { id: string; action: 'approve' | 'deny' | 'remove' }) =>
      decideGrant(v.id, v.action),
    onSuccess: async (g, v) => {
      const key =
        v.action === 'approve'
          ? 'admin.toast.approved'
          : v.action === 'deny'
            ? 'admin.toast.denied'
            : 'admin.toast.removed';
      toast(t(key, { login: g.grant.githubLogin }), v.action === 'approve' ? 'ok' : 'info');
      await refresh();
    },
  });
  const add = useMutation({
    ...tracked,
    mutationFn: () => preApprove(login.trim().replace(/^@/, '')),
    onSuccess: async (g) => {
      toast(t('admin.toast.preApproved', { login: g.grant.githubLogin }));
      setLogin('');
      await refresh();
    },
  });
  const invite = useMutation({
    ...tracked,
    mutationFn: () => createInvite({ multiUse, expiresInHours: hours }),
    onSuccess: async (r) => {
      setCreated(r.url);
      await refresh();
    },
  });
  const revoke = useMutation({
    ...tracked,
    mutationFn: (id: string) => revokeInvite(id),
    onSuccess: async () => {
      toast(t('admin.toast.inviteRevoked'), 'info');
      await refresh();
    },
  });

  const d = access.data;
  const pending = usePresence(d?.pending, (g) => g.id);
  const approved = usePresence(d?.approved, (g) => g.id);
  const invites = usePresence(d?.invites, (i) => i.id);
  if (me && !me.isAdmin) return <p className="hint">{t('admin.adminsOnly')}</p>;
  const remove = (g: AccessGrant) => {
    if (window.confirm(t('admin.members.confirmRemove', { login: g.githubLogin })))
      decide.mutate({ id: g.id, action: 'remove' });
  };
  const err = actionError ?? (access.error ? errorMessage(access.error) : null);

  return (
    <div>
      <header className="page-head">
        <div>
          <h1>{t('admin.title')}</h1>
          <p className="lede">{t('admin.lede')}</p>
        </div>
      </header>
      {err && <p className="error">{err}</p>}
      {access.isPending && <p className="hint">{t('common.status.loading')}</p>}
      {d && (
        <>
          <section className="card" aria-label={t('admin.pending.title')}>
            <div className="card-head">
              <h2>{t('admin.pending.title')}</h2>
              {d.pending.length > 0 && <span className="badge pending">{d.pending.length}</span>}
            </div>
            {d.pending.length === 0 && <p className="hint">{t('admin.pending.none')}</p>}
            <div>
              {pending.map(({ key, item: g, phase }) => (
                <div className="list-row" key={key} {...presenceProps(phase)}>
                  <div className="who">
                    <Avatar g={g} />
                    <strong>{g.githubLogin}</strong>
                    {g.note && <span>{g.note}</span>}
                    {g.requestedAt && (
                      <span className="hint">{formatDate(g.requestedAt, DATE_TIME)}</span>
                    )}
                  </div>
                  <div className="row">
                    <button
                      className="primary"
                      disabled={decide.isPending}
                      onClick={() => decide.mutate({ id: g.id, action: 'approve' })}
                    >
                      {t('admin.actions.approve')}
                    </button>
                    <button
                      className="danger"
                      disabled={decide.isPending}
                      onClick={() => decide.mutate({ id: g.id, action: 'deny' })}
                    >
                      {t('admin.actions.deny')}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </section>

          <div className="split">
            <section className="card" aria-label={t('admin.members.title')}>
              <h2>{t('admin.members.title')}</h2>
              {d.approved.length === 0 && <p className="hint">{t('admin.members.none')}</p>}
              <div>
                {approved.map(({ key, item: g, phase }) => (
                  <div className="list-row" key={key} {...presenceProps(phase)}>
                    <div className="who">
                      <Avatar g={g} />
                      <strong>{g.githubLogin}</strong>
                      {g.decidedBy && (
                        <span className="hint">
                          {t('admin.members.approvedBy', { name: g.decidedBy })}
                        </span>
                      )}
                    </div>
                    <button
                      className="danger"
                      disabled={decide.isPending}
                      onClick={() => remove(g)}
                    >
                      {t('admin.actions.remove')}
                    </button>
                  </div>
                ))}
              </div>
              <form
                className="invite-form card-foot"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (login.trim()) add.mutate();
                }}
              >
                <label className="field">
                  {t('admin.members.addLogin')}
                  <input value={login} onChange={(e) => setLogin(e.target.value)} />
                </label>
                <button type="submit" disabled={add.isPending || !login.trim()}>
                  {t('admin.actions.preApprove')}
                </button>
              </form>
            </section>

            <section className="card" aria-label={t('admin.invites.title')}>
              <h2>{t('admin.invites.title')}</h2>
              <form
                className="invite-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  invite.mutate();
                }}
              >
                <label className="field">
                  {t('admin.invites.type')}
                  <select
                    value={multiUse ? 'multi' : 'single'}
                    onChange={(e) => setMultiUse(e.target.value === 'multi')}
                  >
                    <option value="single">{t('admin.invites.singleUse')}</option>
                    <option value="multi">{t('admin.invites.multiUse')}</option>
                  </select>
                </label>
                <label className="field">
                  {t('admin.invites.expiresAfter')}
                  <select value={hours} onChange={(e) => setHours(Number(e.target.value))}>
                    {EXPIRIES.map((x) => (
                      <option key={x.hours} value={x.hours}>
                        {t(x.label)}
                      </option>
                    ))}
                  </select>
                </label>
                <button type="submit" className="primary" disabled={invite.isPending}>
                  {t('admin.actions.createInvite')}
                </button>
              </form>
              {created && (
                <div className="invite-created reveal" key={created}>
                  <code data-testid="invite-url">{created}</code>
                  <CopyButton text={created} />
                  <p className="hint">{t('admin.invites.notShownAgain')}</p>
                </div>
              )}
              {d.invites.length === 0 && <p className="hint">{t('admin.invites.none')}</p>}
              <div>
                {invites.map(({ key, item: i, phase }) => {
                  const status = inviteStatus(i);
                  return (
                    <div className="list-row" key={key} {...presenceProps(phase)}>
                      <span className="who">
                        <span className={`badge ${status === 'active' ? 'ok' : 'off'}`}>
                          {t(`admin.invites.status.${status}`)}
                        </span>
                        <strong>
                          {i.multiUse ? t('admin.invites.multiUse') : t('admin.invites.singleUse')}
                        </strong>
                        <span className="hint">
                          {t('admin.invites.usesExpires', {
                            count: i.uses,
                            date: formatDate(i.expiresAt, DATE_TIME),
                          })}
                        </span>
                      </span>
                      {status === 'active' && (
                        <button
                          className="danger"
                          disabled={revoke.isPending}
                          onClick={() => revoke.mutate(i.id)}
                        >
                          {t('admin.actions.revoke')}
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            </section>
          </div>

          <section className="card" aria-label={t('admin.configured.title')}>
            <h2>{t('admin.configured.title')}</h2>
            <p className="hint">{t('admin.configured.hint')}</p>
            {d.configured.allowAny && <p className="warning">{t('admin.configured.allowAny')}</p>}
            <dl className="config-list">
              {(
                [
                  ['admin.configured.logins', d.configured.logins],
                  ['admin.configured.orgs', d.configured.orgs],
                  ['admin.configured.admins', d.configured.admins],
                ] as const
              ).map(([label, items]) => (
                <Fragment key={label}>
                  <dt>{t(label)}</dt>
                  <dd>{items.length ? items.join(', ') : t('admin.configured.none')}</dd>
                </Fragment>
              ))}
            </dl>
          </section>

          {d.denied.length > 0 && (
            <details className="card">
              <summary>{t('admin.declined', { count: d.denied.length })}</summary>
              {d.denied.map((g) => (
                <div className="list-row" key={g.id}>
                  <div className="who">
                    <Avatar g={g} />
                    <strong>{g.githubLogin}</strong>
                  </div>
                  <button
                    disabled={decide.isPending}
                    onClick={() => decide.mutate({ id: g.id, action: 'approve' })}
                  >
                    {t('admin.actions.approve')}
                  </button>
                </div>
              ))}
            </details>
          )}
        </>
      )}
    </div>
  );
}
