import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { vi } from 'vitest';
import { App } from '../App';

export type Handler = (body: unknown) => { status?: number; json?: unknown };
export type Routes = Record<string, Handler>;
export type Call = { method: string; path: string; body: unknown };

/** Stubs global fetch. Routes are keyed "METHOD /path" (without /api). Unknown routes return 404. */
export function mockApi(routes: Routes) {
  const calls: Call[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input).replace(/^\/api/, '');
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path, body });
    const h = routes[`${method} ${path}`];
    const r = h
      ? h(body)
      : { status: 404, json: { error: { code: 'not_found', message: 'not found' } } };
    const status = r.status ?? 200;
    return new Response(r.json === undefined ? null : JSON.stringify(r.json), { status });
  });
  vi.stubGlobal('fetch', fn);
  return calls;
}

export function renderApp(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

export const me = { id: 'u1', githubLogin: 'octo', name: 'Octo Cat', avatarUrl: null };

export const project = {
  id: 'p1',
  githubRepoId: 1,
  fullName: 'octo/repo',
  isPrivate: true,
  defaultBranch: 'main',
  visibility: 'ALL_MEMBERS',
  requireParticipantApproval: true,
  whoCanParticipate: 'GITHUB',
  whoCanSubmit: 'GITHUB',
  ownerId: 'u1',
  createdAt: '2026-01-01T00:00:00Z',
};
