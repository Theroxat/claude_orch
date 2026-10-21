import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { OfferView } from '@orch/shared';
import { useEffect, useState } from 'react';
import { acceptOffer, rejectOffer } from '../api/endpoints';
import { useOffers } from '../api/offers';
import { offerErrorMessage } from '../offerErrors';
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
  const qc = useQueryClient();
  const toast = useToast();
  const [error, setError] = useState<string | null>(null);
  const decide = useMutation({
    mutationFn: (kind: 'accept' | 'reject') =>
      kind === 'accept' ? acceptOffer(o.id) : rejectOffer(o.id),
    onSuccess: async (_r, kind) => {
      toast(
        kind === 'accept'
          ? `#${o.task.issueNumber} accepted, starting on your machine`
          : `#${o.task.issueNumber} declined`,
        kind === 'accept' ? 'ok' : 'info',
      );
      await qc.invalidateQueries({ queryKey: ['offers'] });
      await qc.invalidateQueries({ queryKey: ['tasks'] });
    },
    onError: async (e) => {
      setError(offerErrorMessage(e));
      // A closed offer should leave the list.
      await qc.invalidateQueries({ queryKey: ['offers'] });
    },
  });
  return (
    <article
      className="card offer"
      aria-label={`Request #${o.task.issueNumber}`}
      {...presenceProps(phase)}
    >
      <div className="card-head">
        <strong>{o.task.projectFullName}</strong>
        {o.expiresAt && (
          <span className="badge pending">Expires in {countdown(o.expiresAt, now)}</span>
        )}
      </div>
      <h2 className="task-title offer-title">
        <a href={o.task.issueUrl} target="_blank" rel="noreferrer">
          #{o.task.issueNumber}
        </a>{' '}
        {o.task.title}
      </h2>
      <div className="row">
        <span className="badge" title="Size">
          {o.task.size}
        </span>
        <span className="badge" title="Model">
          {o.task.model.toLowerCase()}
        </span>
        <span className="hint">requested by {(o.requestedBy ?? o.task.createdBy).githubLogin}</span>
      </div>
      {error && <p className="error">{error}</p>}
      <div className="card-foot">
        <button
          className="primary"
          disabled={decide.isPending}
          onClick={() => decide.mutate('accept')}
        >
          Accept
        </button>
        <button disabled={decide.isPending} onClick={() => decide.mutate('reject')}>
          Reject
        </button>
      </div>
    </article>
  );
}

export function Requests() {
  const offers = useOffers();
  const now = useNow();
  const rows = usePresence(offers.data, (o) => o.id);
  return (
    <section>
      <header className="page-head">
        <div>
          <h1>Requests</h1>
          <p className="lede">
            Teammates asking to run a task on your machine, with your Claude subscription. Accept to
            start it there, or reject it.
          </p>
        </div>
      </header>
      {offers.isLoading && <p className="hint">Loading...</p>}
      {offers.error && <p className="error">{offers.error.message}</p>}
      {offers.data && offers.data.length === 0 && <p className="empty">No pending requests.</p>}
      <div className="offers">
        {rows.map(({ key, item, phase }) => (
          <OfferRow key={key} o={item} now={now} phase={phase} />
        ))}
      </div>
    </section>
  );
}
