import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
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

const KEY = ['admin', 'access'];
const COUNT_KEY = ['admin', 'pending-count'];

const EXPIRIES = [
  { hours: 24, label: '24 hours' },
  { hours: 168, label: '7 days' },
  { hours: 720, label: '30 days' },
];

function Avatar({ g }: { g: AccessGrant }) {
  return (
    <img
      className="avatar"
      src={g.avatarUrl ?? `https://github.com/${g.githubLogin}.png?size=64`}
      alt=""
    />
  );
}

function inviteStatus(i: AccessInvite): string {
  if (i.revokedAt) return 'revoked';
  if (new Date(i.expiresAt).getTime() <= Date.now()) return 'expired';
  if (!i.multiUse && i.uses > 0) return 'used';
  return i.active ? 'active' : 'inactive';
}

export function AdminAccess() {
  const me = useMe().data;
  const qc = useQueryClient();
  const [login, setLogin] = useState('');
  const [multiUse, setMultiUse] = useState(false);
  const [hours, setHours] = useState(24);
  const [created, setCreated] = useState<string | null>(null);
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
    mutationFn: (v: { id: string; action: 'approve' | 'deny' | 'remove' }) =>
      decideGrant(v.id, v.action),
    onSuccess: refresh,
  });
  const add = useMutation({
    mutationFn: () => preApprove(login.trim().replace(/^@/, '')),
    onSuccess: async () => {
      setLogin('');
      await refresh();
    },
  });
  const invite = useMutation({
    mutationFn: () => createInvite({ multiUse, expiresInHours: hours }),
    onSuccess: async (r) => {
      setCreated(r.url);
      await refresh();
    },
  });
  const revoke = useMutation({
    mutationFn: (id: string) => revokeInvite(id),
    onSuccess: refresh,
  });

  if (me && !me.isAdmin) return <p className="hint">Admins only.</p>;
  const d = access.data;
  const remove = (g: AccessGrant) => {
    if (
      window.confirm(
        `Remove ${g.githubLogin}? This denies their access to the server until an admin approves them again.`,
      )
    )
      decide.mutate({ id: g.id, action: 'remove' });
  };
  const err = decide.error ?? add.error ?? invite.error ?? revoke.error ?? access.error;

  return (
    <div>
      <h1>Access</h1>
      {err && <p className="error">{err.message}</p>}
      {access.isPending && <p className="hint">Loading...</p>}
      {d && (
        <>
          <div className="card">
            <h2>Pending requests</h2>
            {d.pending.length === 0 && <p className="hint">No pending requests.</p>}
            {d.pending.map((g) => (
              <div className="row between" key={g.id}>
                <div className="row">
                  <Avatar g={g} />
                  <strong>{g.githubLogin}</strong>
                  {g.note && <span>{g.note}</span>}
                  {g.requestedAt && (
                    <span className="hint">{new Date(g.requestedAt).toLocaleString()}</span>
                  )}
                </div>
                <div className="row">
                  <button
                    className="primary"
                    disabled={decide.isPending}
                    onClick={() => decide.mutate({ id: g.id, action: 'approve' })}
                  >
                    Approve
                  </button>
                  <button
                    className="danger"
                    disabled={decide.isPending}
                    onClick={() => decide.mutate({ id: g.id, action: 'deny' })}
                  >
                    Deny
                  </button>
                </div>
              </div>
            ))}
          </div>

          <div className="card">
            <h2>Members</h2>
            {d.approved.length === 0 && <p className="hint">No approved members yet.</p>}
            {d.approved.map((g) => (
              <div className="row between" key={g.id}>
                <div className="row">
                  <Avatar g={g} />
                  <strong>{g.githubLogin}</strong>
                  {g.decidedBy && <span className="hint">approved by {g.decidedBy}</span>}
                </div>
                <button className="danger" disabled={decide.isPending} onClick={() => remove(g)}>
                  Remove
                </button>
              </div>
            ))}
            <form
              className="row"
              onSubmit={(e) => {
                e.preventDefault();
                if (login.trim()) add.mutate();
              }}
            >
              <label className="field">
                Add a GitHub login
                <input value={login} onChange={(e) => setLogin(e.target.value)} />
              </label>
              <button type="submit" disabled={add.isPending || !login.trim()}>
                Pre-approve
              </button>
            </form>
          </div>

          <div className="card">
            <h2>Invite links</h2>
            <form
              className="row"
              onSubmit={(e) => {
                e.preventDefault();
                invite.mutate();
              }}
            >
              <label className="field">
                Type
                <select
                  value={multiUse ? 'multi' : 'single'}
                  onChange={(e) => setMultiUse(e.target.value === 'multi')}
                >
                  <option value="single">Single-use</option>
                  <option value="multi">Multi-use</option>
                </select>
              </label>
              <label className="field">
                Expires after
                <select value={hours} onChange={(e) => setHours(Number(e.target.value))}>
                  {EXPIRIES.map((x) => (
                    <option key={x.hours} value={x.hours}>
                      {x.label}
                    </option>
                  ))}
                </select>
              </label>
              <button type="submit" disabled={invite.isPending}>
                Create invite link
              </button>
            </form>
            {created && (
              <div>
                <p>
                  <code data-testid="invite-url">{created}</code>
                </p>
                <CopyButton text={created} />
                <p className="hint">This link won't be shown again. Copy it now.</p>
              </div>
            )}
            {d.invites.length === 0 && <p className="hint">No invite links.</p>}
            {d.invites.map((i) => {
              const status = inviteStatus(i);
              return (
                <div className="row between" key={i.id}>
                  <span>
                    {i.multiUse ? 'Multi-use' : 'Single-use'} · <strong>{status}</strong> · {i.uses}{' '}
                    {i.uses === 1 ? 'use' : 'uses'} · expires{' '}
                    {new Date(i.expiresAt).toLocaleString()}
                  </span>
                  {status === 'active' && (
                    <button
                      className="danger"
                      disabled={revoke.isPending}
                      onClick={() => revoke.mutate(i.id)}
                    >
                      Revoke
                    </button>
                  )}
                </div>
              );
            })}
          </div>

          <div className="card">
            <h2>Configured on the server</h2>
            <p className="hint">
              These entries are configured on the server (environment) and cannot be changed here.
            </p>
            {d.configured.allowAny && (
              <p className="hint">Any GitHub account is allowed on this server.</p>
            )}
            {(
              [
                ['Logins', d.configured.logins],
                ['Organizations', d.configured.orgs],
                ['Admins', d.configured.admins],
              ] as const
            ).map(([label, items]) => (
              <p key={label}>
                <strong>{label}:</strong> {items.length ? items.join(', ') : 'none'}
              </p>
            ))}
          </div>

          {d.denied.length > 0 && (
            <details className="card">
              <summary>Declined ({d.denied.length})</summary>
              {d.denied.map((g) => (
                <div className="row between" key={g.id}>
                  <div className="row">
                    <Avatar g={g} />
                    <strong>{g.githubLogin}</strong>
                  </div>
                  <button
                    disabled={decide.isPending}
                    onClick={() => decide.mutate({ id: g.id, action: 'approve' })}
                  >
                    Approve
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
