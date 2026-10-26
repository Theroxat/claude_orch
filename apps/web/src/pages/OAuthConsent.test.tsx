import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockApi, renderApp, switchToFrench } from '../test/helpers';

const qs = 'response_type=code&client_id=c1&redirect_uri=http%3A%2F%2Flocalhost%3A1%2Fcb&state=s';
const params = {
  response_type: 'code',
  client_id: 'c1',
  redirect_uri: 'http://localhost:1/cb',
  state: 's',
};
const info = { clientName: 'Claude Code', redirectHost: 'localhost', login: 'octo', resource: 'r' };

function stubAssign() {
  const assign = vi.fn();
  vi.stubGlobal('location', { ...window.location, assign });
  return assign;
}

afterEach(() => vi.unstubAllGlobals());

describe('OAuth consent page', () => {
  it('approves and redirects', async () => {
    const assign = stubAssign();
    const calls = mockApi({
      ['GET /oauth/consent?' + qs]: () => ({ json: info }),
      'POST /oauth/consent': () => ({ json: { redirectTo: 'http://localhost:1/cb?code=x' } }),
    });
    renderApp('/oauth/consent?' + qs + '&junk=1');
    expect(await screen.findByRole('heading', { name: 'Authorize Claude Code' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('http://localhost:1/cb?code=x'));
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ ...params, approve: true });
    // While the browser navigates away, a second click must not mint another code.
    await waitFor(() =>
      expect((screen.getByRole('button', { name: 'Approve' }) as HTMLButtonElement).disabled).toBe(
        true,
      ),
    );
    expect((screen.getByRole('button', { name: 'Deny' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);
  });

  it('sends a single POST on a double click in the same tick', async () => {
    stubAssign();
    const calls = mockApi({
      ['GET /oauth/consent?' + qs]: () => ({ json: info }),
      'POST /oauth/consent': () => ({ json: { redirectTo: 'http://localhost:1/cb?code=x' } }),
    });
    renderApp('/oauth/consent?' + qs);
    const approve = await screen.findByRole('button', { name: 'Approve' });
    fireEvent.click(approve);
    fireEvent.click(approve);
    fireEvent.click(screen.getByRole('button', { name: 'Deny' }));
    await waitFor(() => expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1));
  });

  it('denies', async () => {
    const assign = stubAssign();
    const calls = mockApi({
      ['GET /oauth/consent?' + qs]: () => ({ json: info }),
      'POST /oauth/consent': () => ({ json: { redirectTo: 'http://localhost:1/cb?error=x' } }),
    });
    renderApp('/oauth/consent?' + qs);
    fireEvent.click(await screen.findByRole('button', { name: 'Deny' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('http://localhost:1/cb?error=x'));
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ ...params, approve: false });
  });

  it('redirects to sign-in on 401', async () => {
    const assign = stubAssign();
    mockApi({
      ['GET /oauth/consent?' + qs]: () => ({
        status: 401,
        json: { error: { code: 'unauthorized', message: 'no' } },
      }),
    });
    renderApp('/oauth/consent?' + qs);
    const next = encodeURIComponent('/oauth/consent?' + qs);
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/api/auth/github/login?next=' + next));
  });

  it('shows the error on an invalid request', async () => {
    mockApi({
      ['GET /oauth/consent?' + qs]: () => ({
        status: 400,
        json: { error: { code: 'invalid_request', message: 'Bad redirect' } },
      }),
    });
    renderApp('/oauth/consent?' + qs);
    expect(await screen.findByText('Authorization request rejected')).toBeTruthy();
    expect(screen.getByText('Bad redirect')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
  });

  it('is translated in French', async () => {
    await switchToFrench();
    mockApi({ ['GET /oauth/consent?' + qs]: () => ({ json: info }) });
    renderApp('/oauth/consent?' + qs);
    expect(await screen.findByRole('heading', { name: 'Autoriser Claude Code' })).toBeTruthy();
    expect(screen.getByText(/veut utiliser les outils MCP d’orch/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Approuver' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Refuser' })).toBeTruthy();
  });
});
