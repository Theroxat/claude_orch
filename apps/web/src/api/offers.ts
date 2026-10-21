import { useQuery } from '@tanstack/react-query';
import { POLL_MS } from '../time';
import { fetchMyOffers } from './endpoints';

/** Pending requests for my machines; shared by the Requests page and the nav counter. */
export function useOffers() {
  return useQuery({
    queryKey: ['offers', 'mine'],
    queryFn: fetchMyOffers,
    refetchInterval: POLL_MS,
  });
}
