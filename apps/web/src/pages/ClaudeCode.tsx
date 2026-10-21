import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  OAuthGrantListResponseSchema,
  type OAuthGrantView,
  type PersonalTokenView,
} from '@orch/shared';
import { useState } from 'react';
import { api } from '../api/client';
import { createToken, fetchTokens, revokeToken } from '../api/endpoints';
import { CopyButton } from '../components/CopyButton';
import { McpCommand } from '../components/McpCommand';
import { relative } from '../time';
import { Modal, closeModal } from '../ui/Modal';
import { presenceProps, usePresence, type Phase } from '../ui/presence';
import { useToast } from '../ui/Toast';

const KEY = ['tokens'];
const GRANTS_KEY = ['oauth-grants'];

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
  const create = useMutation({
    mutationFn: () =>
      createToken({
        name: name.trim(),
        ...(days.trim() !== '' ? { expiresInDays: Number(days) } : {}),
      }),
    onSuccess: async () => {
      setName('');
      setDays('');
      await qc.invalidateQueries({ queryKey: KEY });
    },
  });
  const data = create.data;
  return (
    <section className="card" aria-label="Create a token">
      <h3>Create a personal access token</h3>
      <p className="hint">
        Create a personal token, then run the generated <code>claude mcp add</code> command.
      </p>
      <div className="form-grid">
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
      </div>
      <div className="card-foot">
        <button
          className="primary"
          disabled={create.isPending || name.trim() === ''}
          onClick={() => create.mutate()}
        >
          Create token
        </button>
      </div>
      {create.error && <p className="error">{create.error.message}</p>}
      {data && (
        <div className="install-result reveal" key={data.mcpAddCommand}>
          <div className="warning" role="alert">
            Shown once: this command contains your token. Copy it now, it cannot be displayed again.
          </div>
          <pre className="code" data-testid="mcp-command">
            {data.mcpAddCommand}
          </pre>
          <div className="row">
            <CopyButton text={data.mcpAddCommand} />
          </div>
        </div>
      )}
    </section>
  );
}

function ConnectCard() {
  return (
    <section className="card" aria-label="Connect Claude Code">
      <h2>Connect Claude Code</h2>
      <ol className="steps">
        <li>
          Run this command in your terminal:
          <McpCommand />
        </li>
        <li>
          In Claude Code, run <code>/mcp</code>, choose <code>orch</code>, then Authenticate.
        </li>
        <li>Your browser opens: sign in with GitHub and approve. Done.</li>
      </ol>
      <p className="hint">No token to copy: access is granted through your GitHub sign-in.</p>
    </section>
  );
}

function ConnectedApps() {
  const qc = useQueryClient();
  const toast = useToast();
  const [toRevoke, setToRevoke] = useState<OAuthGrantView | null>(null);
  const grants = useQuery({
    queryKey: GRANTS_KEY,
    queryFn: () => api('GET', '/oauth/grants', { schema: OAuthGrantListResponseSchema }),
  });
  const revoke = useMutation({
    mutationFn: (g: OAuthGrantView) => api<unknown>('DELETE', `/oauth/grants/${g.id}`),
    onSuccess: async (_r, g) => {
      toast(`${g.clientName} access revoked`);
      closeModal(() => setToRevoke(null));
      await qc.invalidateQueries({ queryKey: GRANTS_KEY });
    },
  });
  const apps = usePresence(grants.data, (g) => g.id);
  return (
    <>
      <div className="section-title">
        <h2>Connected apps</h2>
      </div>
      {grants.isPending && <p className="hint">Loading apps...</p>}
      {grants.error && <p className="error">{grants.error.message}</p>}
      {grants.isSuccess && grants.data.length === 0 && (
        <p className="hint">No connected app yet.</p>
      )}
      {apps.map(({ key, item: g, phase }) => (
        <article
          key={key}
          className="card list-card"
          aria-label={`App ${g.clientName}`}
          {...presenceProps(phase)}
        >
          <div>
            <div className="row">
              <strong>{g.clientName}</strong>
              <span className="tag">{g.redirectHost}</span>
            </div>
            <div className="agent-meta">
              <span>Authorized {relative(g.createdAt)}</span>
              <span>Last used {when(g.lastUsedAt, 'never')}</span>
            </div>
          </div>
          <button className="danger" onClick={() => setToRevoke(g)}>
            Revoke
          </button>
        </article>
      ))}
      {toRevoke && (
        <Modal
          label="Revoke access"
          title={`Revoke ${toRevoke.clientName}?`}
          onClose={() => setToRevoke(null)}
          closeButton={false}
          tone="danger"
        >
          <p>This app will lose access immediately and must be authorized again.</p>
          {revoke.error && <p className="error">{revoke.error.message}</p>}
          <div className="modal-actions">
            <button onClick={() => closeModal(() => setToRevoke(null))}>Cancel</button>
            <button
              className="danger solid"
              disabled={revoke.isPending}
              onClick={() => revoke.mutate(toRevoke)}
            >
              Confirm revoke
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}

function when(iso: string | null, empty: string): string {
  return iso ? relative(iso) : empty;
}

function TokenRow({
  t,
  onRevoke,
  phase,
}: {
  t: PersonalTokenView;
  onRevoke: (t: PersonalTokenView) => void;
  phase: Phase;
}) {
  const revoked = t.revokedAt !== null;
  return (
    <article
      className={`card list-card${revoked ? ' token-revoked' : ''}`}
      aria-label={`Token ${t.name}`}
      {...presenceProps(phase)}
    >
      <div>
        <div className="row">
          <strong>{t.name}</strong>
          <code>{t.prefix}...</code>
          {revoked ? (
            <span className="badge stop">Revoked</span>
          ) : (
            <span className="badge ok">Active</span>
          )}
        </div>
        <div className="agent-meta">
          <span>Created {relative(t.createdAt)}</span>
          <span>Last used {when(t.lastUsedAt, 'never')}</span>
          <span>Expires {when(t.expiresAt, 'never')}</span>
        </div>
      </div>
      {!revoked && (
        <button className="danger" onClick={() => onRevoke(t)}>
          Revoke
        </button>
      )}
    </article>
  );
}

export function ClaudeCode() {
  const qc = useQueryClient();
  const toast = useToast();
  const [toRevoke, setToRevoke] = useState<PersonalTokenView | null>(null);
  const tokens = useQuery({ queryKey: KEY, queryFn: fetchTokens });
  const revoke = useMutation({
    mutationFn: (t: PersonalTokenView) => revokeToken(t.id),
    onSuccess: async (_r, t) => {
      toast(`${t.name} token revoked`);
      closeModal(() => setToRevoke(null));
      await qc.invalidateQueries({ queryKey: KEY });
    },
  });
  const rows = usePresence(tokens.data, (t) => t.id);
  return (
    <div>
      <header className="page-head">
        <div>
          <h1>Claude Code</h1>
          <p className="lede">
            Connect Claude Code to orch over MCP, so it can read the pool and send tasks for you.
          </p>
        </div>
      </header>
      <div className="split">
        <ConnectCard />
        <section className="card" aria-label="How to use">
          <h2>How to use</h2>
          <p>
            Once connected, ask Claude Code things like: &quot;split this feature into tasks and
            send them to the orch pool&quot;.
          </p>
          <ul className="tools">
            {TOOLS.map(([n, d]) => (
              <li key={n}>
                <code>{n}</code>
                <span>{d}</span>
              </li>
            ))}
          </ul>
        </section>
      </div>
      <ConnectedApps />
      <div className="section-title">
        <h2>Personal access tokens for scripts</h2>
      </div>
      <p className="hint">
        For scripts and CI, use a personal access token (<code>orch_pat_...</code>) with the{' '}
        <code>--header &quot;Authorization: Bearer ...&quot;</code> form of the command.
      </p>
      <CreateTokenCard />
      <h3>My tokens</h3>
      {tokens.isPending && <p className="hint">Loading tokens...</p>}
      {tokens.error && <p className="error">{tokens.error.message}</p>}
      {tokens.isSuccess && tokens.data.length === 0 && <p className="hint">No token yet.</p>}
      {rows.map(({ key, item, phase }) => (
        <TokenRow key={key} t={item} onRevoke={setToRevoke} phase={phase} />
      ))}
      {toRevoke && (
        <Modal
          label="Revoke token"
          title={`Revoke ${toRevoke.name}?`}
          onClose={() => setToRevoke(null)}
          closeButton={false}
          tone="danger"
        >
          <p>Claude Code sessions using this token will lose access immediately.</p>
          {revoke.error && <p className="error">{revoke.error.message}</p>}
          <div className="modal-actions">
            <button onClick={() => closeModal(() => setToRevoke(null))}>Cancel</button>
            <button
              className="danger solid"
              disabled={revoke.isPending}
              onClick={() => revoke.mutate(toRevoke)}
            >
              Confirm revoke
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
