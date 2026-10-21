import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { PersonalTokenView } from '@orch/shared';
import { useState } from 'react';
import { createToken, fetchTokens, revokeToken } from '../api/endpoints';
import { relative } from '../time';

const KEY = ['tokens'];

const TOOLS: [string, string][] = [
  ['view_pool', 'See who is in the pool, their availability and estimated margin.'],
  ['list_tasks', 'List tasks of your projects, optionally filtered by project or status.'],
  ['submit_task', 'Create tasks (GitHub issues) and send them to the pool, members or everyone.'],
  ['take_task', 'Take a task for yourself so your agent runs it.'],
  ['task_status', 'Check the status of one task (progress, pull request).'],
];

function CreateTokenCard() {
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [days, setDays] = useState('');
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const create = useMutation({
    mutationFn: () =>
      createToken({
        name: name.trim(),
        ...(days.trim() !== '' ? { expiresInDays: Number(days) } : {}),
      }),
    onSuccess: async () => {
      setCopied(false);
      setCopyError(false);
      setName('');
      setDays('');
      await qc.invalidateQueries({ queryKey: KEY });
    },
  });
  const data = create.data;
  const copy = async () => {
    if (!data) return;
    try {
      await navigator.clipboard.writeText(data.mcpAddCommand);
      setCopied(true);
      setCopyError(false);
    } catch {
      setCopyError(true);
    }
  };
  return (
    <section className="card" aria-label="Create a token">
      <h2>Connect Claude Code</h2>
      <p className="hint">
        Create a personal token, then run the generated <code>claude mcp add</code> command.
      </p>
      <label className="field">
        Token name
        <input value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="field">
        Expires in days (optional)
        <input
          type="number"
          min={1}
          max={3650}
          value={days}
          onChange={(e) => setDays(e.target.value)}
        />
      </label>
      <button
        className="primary"
        disabled={create.isPending || name.trim() === ''}
        onClick={() => create.mutate()}
      >
        Create token
      </button>
      {create.error && <p className="error">{create.error.message}</p>}
      {data && (
        <div className="install-result">
          <div className="warning" role="alert">
            Shown once: this command contains your token. Copy it now, it cannot be displayed again.
          </div>
          <pre className="code" data-testid="mcp-command">
            {data.mcpAddCommand}
          </pre>
          <div className="row">
            <button onClick={() => void copy()}>{copied ? 'Copied' : 'Copy'}</button>
          </div>
          {copyError && (
            <p className="error">Copy failed. Select the command and copy it by hand.</p>
          )}
        </div>
      )}
    </section>
  );
}

function when(iso: string | null, empty: string): string {
  return iso ? relative(iso) : empty;
}

function TokenRow({
  t,
  onRevoke,
}: {
  t: PersonalTokenView;
  onRevoke: (t: PersonalTokenView) => void;
}) {
  const revoked = t.revokedAt !== null;
  return (
    <article className={`card ${revoked ? 'token-revoked' : ''}`} aria-label={`Token ${t.name}`}>
      <div className="row between">
        <strong>{t.name}</strong>
        {revoked ? (
          <span className="badge pending">Revoked</span>
        ) : (
          <span className="badge ok">Active</span>
        )}
      </div>
      <p className="hint">
        <code>{t.prefix}...</code>
      </p>
      <div className="row">
        <span className="hint">Created {relative(t.createdAt)}</span>
        <span className="hint">Last used {when(t.lastUsedAt, 'never')}</span>
        <span className="hint">Expires {when(t.expiresAt, 'never')}</span>
      </div>
      {!revoked && (
        <div className="row">
          <button className="danger" onClick={() => onRevoke(t)}>
            Revoke
          </button>
        </div>
      )}
    </article>
  );
}

export function ClaudeCode() {
  const qc = useQueryClient();
  const [toRevoke, setToRevoke] = useState<PersonalTokenView | null>(null);
  const tokens = useQuery({ queryKey: KEY, queryFn: fetchTokens });
  const revoke = useMutation({
    mutationFn: (t: PersonalTokenView) => revokeToken(t.id),
    onSuccess: async () => {
      setToRevoke(null);
      await qc.invalidateQueries({ queryKey: KEY });
    },
  });
  return (
    <div>
      <h1>Claude Code</h1>
      <CreateTokenCard />
      <section className="card" aria-label="How to use">
        <h2>How to use</h2>
        <p>
          After <code>claude mcp add</code>, ask Claude Code things like: &quot;split this feature
          into tasks and send them to the orch pool&quot;.
        </p>
        <ul className="plain">
          {TOOLS.map(([n, d]) => (
            <li key={n}>
              <code>{n}</code>: {d}
            </li>
          ))}
        </ul>
      </section>
      <h2>My tokens</h2>
      {tokens.isPending && <p className="hint">Loading tokens...</p>}
      {tokens.error && <p className="error">{tokens.error.message}</p>}
      {tokens.isSuccess && tokens.data.length === 0 && <p className="hint">No token yet.</p>}
      {tokens.data?.map((t) => (
        <TokenRow key={t.id} t={t} onRevoke={setToRevoke} />
      ))}
      {toRevoke && (
        <div className="modal-backdrop">
          <div className="modal" role="dialog" aria-label="Revoke token">
            <h2>Revoke {toRevoke.name}?</h2>
            <p>Claude Code sessions using this token will lose access immediately.</p>
            {revoke.error && <p className="error">{revoke.error.message}</p>}
            <div className="row">
              <button onClick={() => setToRevoke(null)}>Cancel</button>
              <button
                className="danger"
                disabled={revoke.isPending}
                onClick={() => revoke.mutate(toRevoke)}
              >
                Confirm revoke
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
