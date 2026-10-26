import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  OAuthGrantListResponseSchema,
  type OAuthGrantView,
  type PersonalTokenView,
} from '@orch/shared';
import { useState, type ReactNode } from 'react';
import { api } from '../api/client';
import { createToken, fetchTokens, revokeToken } from '../api/endpoints';
import { CopyButton } from '../components/CopyButton';
import { McpCommand } from '../components/McpCommand';
import { relative } from '../time';
import { Modal, closeModal } from '../ui/Modal';
import { presenceProps, usePresence, type Phase } from '../ui/presence';
import { useToast } from '../ui/Toast';
import { t, useRich, useT } from '../i18n/index.ts';
import { errorMessage } from '../i18n/errors.ts';

const KEY = ['tokens'];
const GRANTS_KEY = ['oauth-grants'];

const TOOLS = ['view_pool', 'list_tasks', 'submit_task', 'take_task', 'task_status'] as const;

const code = (c: ReactNode) => <code>{c}</code>;

function CreateTokenCard() {
  const t = useT();
  const rich = useRich();
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
    <section className="card" aria-label={t('claudeCode.create.label')}>
      <h3>{t('claudeCode.create.title')}</h3>
      <p className="hint">{rich('claudeCode.create.hint', { code })}</p>
      <div className="form-grid">
        <label className="field">
          {t('claudeCode.create.name')}
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="field">
          {t('claudeCode.create.days')}
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
          {t('claudeCode.create.submit')}
        </button>
      </div>
      {create.error && <p className="error">{errorMessage(create.error)}</p>}
      {data && (
        <div className="install-result reveal" key={data.mcpAddCommand}>
          <div className="warning" role="alert">
            {t('claudeCode.create.shownOnce')}
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
  const t = useT();
  const rich = useRich();
  return (
    <section className="card" aria-label={t('claudeCode.connect.label')}>
      <h2>{t('claudeCode.connect.title')}</h2>
      <ol className="steps">
        <li>
          {t('claudeCode.connect.step1')}
          <McpCommand />
        </li>
        <li>{rich('claudeCode.connect.step2', { code })}</li>
        <li>{t('claudeCode.connect.step3')}</li>
      </ol>
      <p className="hint">{t('claudeCode.connect.hint')}</p>
    </section>
  );
}

function ConnectedApps() {
  const t = useT();
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
      toast(t('claudeCode.apps.revoked', { name: g.clientName }));
      closeModal(() => setToRevoke(null));
      await qc.invalidateQueries({ queryKey: GRANTS_KEY });
    },
  });
  const apps = usePresence(grants.data, (g) => g.id);
  return (
    <>
      <div className="section-title">
        <h2>{t('claudeCode.apps.title')}</h2>
      </div>
      {grants.isPending && <p className="hint">{t('claudeCode.page.loadingApps')}</p>}
      {grants.error && <p className="error">{errorMessage(grants.error)}</p>}
      {grants.isSuccess && grants.data.length === 0 && (
        <p className="hint">{t('claudeCode.apps.empty')}</p>
      )}
      {apps.map(({ key, item: g, phase }) => (
        <article
          key={key}
          className="card list-card"
          aria-label={t('claudeCode.apps.label', { name: g.clientName })}
          {...presenceProps(phase)}
        >
          <div>
            <div className="row">
              <strong>{g.clientName}</strong>
              <span className="tag">{g.redirectHost}</span>
            </div>
            <div className="agent-meta">
              <span>{t('claudeCode.apps.authorized', { when: relative(g.createdAt) })}</span>
              <span>
                {t('claudeCode.apps.lastUsed', {
                  when: g.lastUsedAt ? relative(g.lastUsedAt) : t('claudeCode.page.never'),
                })}
              </span>
            </div>
          </div>
          <button className="danger" onClick={() => setToRevoke(g)}>
            {t('claudeCode.apps.revoke')}
          </button>
        </article>
      ))}
      {toRevoke && (
        <Modal
          label={t('claudeCode.apps.revokeLabel')}
          title={t('claudeCode.apps.revokeTitle', { name: toRevoke.clientName })}
          onClose={() => setToRevoke(null)}
          closeButton={false}
          tone="danger"
        >
          <p>{t('claudeCode.apps.revokeBody')}</p>
          {revoke.error && <p className="error">{errorMessage(revoke.error)}</p>}
          <div className="modal-actions">
            <button onClick={() => closeModal(() => setToRevoke(null))}>
              {t('common.actions.cancel')}
            </button>
            <button
              className="danger solid"
              disabled={revoke.isPending}
              onClick={() => revoke.mutate(toRevoke)}
            >
              {t('claudeCode.apps.confirm')}
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}

function when(iso: string | null): string {
  return iso ? relative(iso) : t('claudeCode.page.never');
}

function TokenRow({
  token,
  onRevoke,
  phase,
}: {
  token: PersonalTokenView;
  onRevoke: (t: PersonalTokenView) => void;
  phase: Phase;
}) {
  const t = useT();
  const revoked = token.revokedAt !== null;
  return (
    <article
      className={`card list-card${revoked ? ' token-revoked' : ''}`}
      aria-label={t('claudeCode.tokens.label', { name: token.name })}
      {...presenceProps(phase)}
    >
      <div>
        <div className="row">
          <strong>{token.name}</strong>
          <code>{token.prefix}...</code>
          {revoked ? (
            <span className="badge stop">{t('claudeCode.tokens.revoked')}</span>
          ) : (
            <span className="badge ok">{t('claudeCode.tokens.active')}</span>
          )}
        </div>
        <div className="agent-meta">
          <span>{t('claudeCode.tokens.created', { when: relative(token.createdAt) })}</span>
          <span>{t('claudeCode.tokens.lastUsed', { when: when(token.lastUsedAt) })}</span>
          <span>{t('claudeCode.tokens.expires', { when: when(token.expiresAt) })}</span>
        </div>
      </div>
      {!revoked && (
        <button className="danger" onClick={() => onRevoke(token)}>
          {t('claudeCode.tokens.revoke')}
        </button>
      )}
    </article>
  );
}

export function ClaudeCode() {
  const t = useT();
  const rich = useRich();
  const qc = useQueryClient();
  const toast = useToast();
  const [toRevoke, setToRevoke] = useState<PersonalTokenView | null>(null);
  const tokens = useQuery({ queryKey: KEY, queryFn: fetchTokens });
  const revoke = useMutation({
    mutationFn: (tok: PersonalTokenView) => revokeToken(tok.id),
    onSuccess: async (_r, tok) => {
      toast(t('claudeCode.tokens.revokedToast', { name: tok.name }));
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
          <p className="lede">{t('claudeCode.page.lede')}</p>
        </div>
      </header>
      <div className="split">
        <ConnectCard />
        <section className="card" aria-label={t('claudeCode.usage.label')}>
          <h2>{t('claudeCode.usage.title')}</h2>
          <p>{t('claudeCode.usage.intro')}</p>
          <ul className="tools">
            {TOOLS.map((n) => (
              <li key={n}>
                <code>{n}</code>
                <span>{t(`claudeCode.tools.${n}`)}</span>
              </li>
            ))}
          </ul>
        </section>
      </div>
      <ConnectedApps />
      <div className="section-title">
        <h2>{t('claudeCode.tokens.title')}</h2>
      </div>
      <p className="hint">
        {rich(
          'claudeCode.tokens.hint',
          { code },
          { prefix: 'orch_pat_...', header: '--header "Authorization: Bearer ..."' },
        )}
      </p>
      <CreateTokenCard />
      <h3>{t('claudeCode.tokens.mine')}</h3>
      {tokens.isPending && <p className="hint">{t('claudeCode.page.loadingTokens')}</p>}
      {tokens.error && <p className="error">{errorMessage(tokens.error)}</p>}
      {tokens.isSuccess && tokens.data.length === 0 && (
        <p className="hint">{t('claudeCode.tokens.empty')}</p>
      )}
      {rows.map(({ key, item, phase }) => (
        <TokenRow key={key} token={item} onRevoke={setToRevoke} phase={phase} />
      ))}
      {toRevoke && (
        <Modal
          label={t('claudeCode.tokens.revokeLabel')}
          title={t('claudeCode.tokens.revokeTitle', { name: toRevoke.name })}
          onClose={() => setToRevoke(null)}
          closeButton={false}
          tone="danger"
        >
          <p>{t('claudeCode.tokens.revokeBody')}</p>
          {revoke.error && <p className="error">{errorMessage(revoke.error)}</p>}
          <div className="modal-actions">
            <button onClick={() => closeModal(() => setToRevoke(null))}>
              {t('common.actions.cancel')}
            </button>
            <button
              className="danger solid"
              disabled={revoke.isPending}
              onClick={() => revoke.mutate(toRevoke)}
            >
              {t('claudeCode.tokens.confirm')}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
