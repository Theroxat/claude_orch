import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { OfferView } from '@orch/shared';
import { useEffect, useState } from 'react';
import { acceptOffer, rejectOffer } from '../api/endpoints';
import { useOffers } from '../api/offers';
import { errorMessage } from '../i18n/errors.ts';
import { useT } from '../i18n/index.ts';
import { countdown } from '../time';
import { presenceProps, usePresence, type Phase } from '../ui/presence';
import { useToast } from '../ui/Toast';

export { useOffers };

function useNow() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return now;
}

function OfferRow({ o, now, phase }: { o: OfferView; now: number; phase: Phase }) {
  const t = useT();
  const qc = useQueryClient();
  const toast = useToast();
  const [error, setError] = useState<string | null>(null);
  const decide = useMutation({
    mutationFn: (kind: 'accept' | 'reject') =>
      kind === 'accept' ? acceptOffer(o.id) : rejectOffer(o.id),
    onSuccess: async (_r, kind) => {
      toast(
        kind === 'accept'
          ? t('pool.requests.accepted', { number: String(o.task.issueNumber) })
          : t('pool.requests.declined', { number: String(o.task.issueNumber) }),
        kind === 'accept' ? 'ok' : 'info',
      );
      await qc.invalidateQueries({ queryKey: ['offers'] });
      await qc.invalidateQueries({ queryKey: ['tasks'] });
    },
    onError: async (e) => {
      setError(errorMessage(e));
      // A closed offer should leave the list.
      await qc.invalidateQueries({ queryKey: ['offers'] });
    },
  });
  return (
    <article
      className="card offer"
      aria-label={t('pool.requests.aria', { number: String(o.task.issueNumber) })}
      {...presenceProps(phase)}
    >
      <div className="card-head">
        <strong>{o.task.projectFullName}</strong>
        {o.expiresAt && (
          <span className="badge pending">
            {t('pool.requests.expiresIn', { countdown: countdown(o.expiresAt, now) })}
          </span>
        )}
      </div>
      <h2 className="task-title offer-title">
        <a href={o.task.issueUrl} target="_blank" rel="noreferrer">
          #{o.task.issueNumber}
        </a>{' '}
        {o.task.title}
      </h2>
      <div className="row">
        <span className="badge" title={t('pool.requests.size')}>
          {o.task.size}
        </span>
        <span className="badge" title={t('pool.requests.model')}>
          {o.task.model.toLowerCase()}
        </span>
        <span className="hint">
          {t('pool.requests.requestedBy', {
            login: (o.requestedBy ?? o.task.createdBy).githubLogin,
          })}
        </span>
      </div>
      {error && <p className="error">{error}</p>}
      <div className="card-foot">
        <button
          className="primary"
          disabled={decide.isPending}
          onClick={() => decide.mutate('accept')}
        >
          {t('pool.requests.accept')}
        </button>
        <button disabled={decide.isPending} onClick={() => decide.mutate('reject')}>
          {t('pool.requests.reject')}
        </button>
      </div>
    </article>
  );
}

export function Requests() {
  const t = useT();
  const offers = useOffers();
  const now = useNow();
  const rows = usePresence(offers.data, (o) => o.id);
  return (
    <section>
      <header className="page-head">
        <div>
          <h1>{t('pool.requests.title')}</h1>
          <p className="lede">{t('pool.requests.lede')}</p>
        </div>
      </header>
      {offers.isLoading && <p className="hint">{t('common.status.loading')}</p>}
      {offers.error && <p className="error">{errorMessage(offers.error)}</p>}
      {offers.data && offers.data.length === 0 && (
        <p className="empty">{t('pool.requests.empty')}</p>
      )}
      <div className="offers">
        {rows.map(({ key, item, phase }) => (
          <OfferRow key={key} o={item} now={now} phase={phase} />
        ))}
      </div>
    </section>
  );
}
