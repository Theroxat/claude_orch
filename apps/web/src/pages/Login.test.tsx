import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { loginPathFor, safeReturnPath } from '../returnPath';
import { mockApi, renderApp } from '../test/helpers';

const unauthenticated = {
  'GET /me': () => ({ status: 401, json: { error: { code: 'unauthorized', message: 'no' } } }),
};

describe('sign-in return path', () => {
  it('sends an unauthenticated visitor to /login carrying the requested page', async () => {
    mockApi(unauthenticated);
    renderApp('/backlog?task=t2#top');
    const link = await screen.findByRole('link', { name: /Sign in with GitHub/ });
    expect(link.getAttribute('href')).toBe(
      '/api/auth/github/login?next=' + encodeURIComponent('/backlog?task=t2#top'),
    );
  });

  it('keeps the plain sign-in link when nothing specific was requested', async () => {
    mockApi(unauthenticated);
    renderApp('/');
    const link = await screen.findByRole('link', { name: /Sign in with GitHub/ });
    expect(link.getAttribute('href')).toBe('/api/auth/github/login');
  });

  it.each(['//evil.example', '/\\evil.example', 'https://evil.example', 'javascript:alert(1)'])(
    'ignores an unsafe next=%s',
    async (next) => {
      mockApi(unauthenticated);
      renderApp('/login?next=' + encodeURIComponent(next));
      const link = await screen.findByRole('link', { name: /Sign in with GitHub/ });
      expect(link.getAttribute('href')).toBe('/api/auth/github/login');
    },
  );

  it('accepts same-origin paths only', () => {
    expect(safeReturnPath('/pool?x=1')).toBe('/pool?x=1');
    expect(safeReturnPath('/login')).toBeNull();
    expect(safeReturnPath('/a\nb')).toBeNull();
    expect(safeReturnPath(undefined)).toBeNull();
    expect(loginPathFor({ pathname: '/pool', search: '', hash: '' })).toBe('/login?next=%2Fpool');
  });
});

describe('sign-in page language', () => {
  it('switches to French from the language lever and remembers it', async () => {
    mockApi(unauthenticated);
    renderApp('/login');
    const fr = await screen.findByRole('button', { name: 'Français' });
    expect(screen.getByRole('button', { name: 'English' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    fireEvent.click(fr);
    expect(await screen.findByRole('link', { name: /Se connecter avec GitHub/ })).toBeTruthy();
    expect(screen.getByText(/réunis dans un pool commun/)).toBeTruthy();
    expect(fr.getAttribute('aria-pressed')).toBe('true');
    expect(document.documentElement.lang).toBe('fr');
    expect(localStorage.getItem('orch.locale')).toBe('fr');
  });
});
