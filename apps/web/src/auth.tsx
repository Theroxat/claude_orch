import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Navigate, Outlet, useLocation } from 'react-router';
import { ApiError } from './api/client';
import { fetchMe } from './api/endpoints';
import { errorMessage } from './i18n/errors.ts';
import { loginPathFor } from './returnPath';
import { PageFallback } from './ui/PageFallback';

export function useMe() {
  return useQuery({
    queryKey: ['me'],
    queryFn: fetchMe,
    retry: false,
    staleTime: 60_000,
  });
}

/** Redirects unauthenticated users to /login. */
export function AuthGate() {
  const me = useMe();
  const location = useLocation();
  if (me.isPending) return <PageFallback />;
  if (me.error instanceof ApiError && me.error.status === 401)
    return <Navigate to={loginPathFor(location)} replace />;
  if (me.error) return <p className="error page-loading">{errorMessage(me.error)}</p>;
  return <Outlet />;
}

export function useResetSession() {
  const qc = useQueryClient();
  return () => qc.clear();
}
