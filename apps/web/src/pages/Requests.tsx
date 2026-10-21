import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { OfferView } from '@orch/shared';
import { useEffect, useState } from 'react';
import { acceptOffer, fetchMyOffers, rejectOffer } from '../api/endpoints';
import { offerErrorMessage } from '../offerErrors';
import { countdown, POLL_MS } from '../time';

export function useOffers() {
  return useQuery({
    queryKey: ['offers', 'mine'],
    queryFn: fetchMyOffers,
    refetchInterval: POLL_MS,
  });
}

function useNow() {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return now;
}

function OfferRow({ o, now }: { o: OfferView; now: number }) {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const done = async () => {
    await qc.invalidateQueries({ queryKey: ['offers'] });
    await qc.invalidateQueries({ queryKey: ['tasks'] });
  };
  const decide = useMutation({
    mutationFn: (kind: 'accept' | 'reject') =>
      kind === 'accept' ? acceptOffer(o.id) : rejectOffer(o.id),
    onSuccess: done,
    onError: async (e) => {
      setError(offerErrorMessage(e));
      // A closed offer should leave the list.
      await qc.invalidateQueries({ queryKey: ['offers'] });
    },
  });
  return (
    <article className="card" aria-label={`Request #${o.task.issueNumber}`}>
      <div className="row between">
        <strong>{o.task.projectFullName}</strong>
        {o.expiresAt && (
          <span className="badge pending">Expires in {countdown(o.expiresAt, now)}</span>
        )}
      </div>
      <p className="task-title">
        <a href={o.task.issueUrl} target="_blank" rel="noreferrer">
          #{o.task.issueNumber}
        </a>{' '}
        {o.task.title}
      </p>
      <div className="row">
        <span className="badge">{o.task.size}</span>
        <span className="badge">{o.task.model.toLowerCase()}</span>
        <span className="hint">requested by {o.task.createdBy.githubLogin}</span>
      </div>
      {error && <p className="error">{error}</p>}
      <div className="row">
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
  return (
    <section>
      <h1>Requests</h1>
      {offers.isLoading && <p>Loading...</p>}
      {offers.error && <p className="error">{offers.error.message}</p>}
      {offers.data && offers.data.length === 0 && <p>No pending requests.</p>}
      {offers.data?.map((o) => (
        <OfferRow key={o.id} o={o} now={now} />
      ))}
    </section>
  );
}
