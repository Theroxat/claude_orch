import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { me, mockApi, renderApp, switchToFrench } from '../test/helpers';

describe('shell in French', () => {
  it('translates the not-found page', async () => {
    await switchToFrench();
    mockApi({ 'GET /me': () => ({ json: me }), 'GET /projects/mine': () => ({ json: [] }) });
    renderApp('/nowhere');
    expect(await screen.findByRole('heading', { name: 'Page introuvable' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Retour à orch' })).toBeTruthy();
  });

  it('translates the navigation, header tools and counts', async () => {
    await switchToFrench();
    mockApi({
      'GET /me': () => ({ json: { ...me, isAdmin: true } }),
      'GET /onboarding': () => ({ json: { steps: [] } }),
      'GET /projects/mine': () => ({ json: [] }),
      'GET /admin/access/pending-count': () => ({ json: { count: 1 } }),
    });
    renderApp('/projects');
    expect(await screen.findByRole('button', { name: 'Se déconnecter' })).toBeTruthy();
    const nav = screen.getByRole('navigation', { name: 'Principale' });
    for (const n of ['Découvrir', 'Historique', 'Consommation', 'Mon serveur', 'Accès'])
      expect(within(nav).getByRole('link', { name: new RegExp(n) })).toBeTruthy();
    expect(await within(nav).findByLabelText('1 demande d’accès en attente')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Dépôt GitHub' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Passer au thème sombre' })).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Langue' })).toBeTruthy();
  });
});

describe('header links', () => {
  it('links to the documentation and the GitHub repository with icon-only anchors', async () => {
    mockApi({
      'GET /me': () => ({ json: me }),
      'GET /onboarding': () => ({ json: { steps: [] } }),
      'GET /projects/mine': () => ({ json: [] }),
    });
    renderApp('/projects');
    const docs = await screen.findByRole('link', { name: 'Documentation' });
    const repo = screen.getByRole('link', { name: 'GitHub repository' });
    expect(docs.getAttribute('href')).toBe('https://claude-orch.readthedocs.io');
    expect(repo.getAttribute('href')).toBe('https://github.com/Theroxat/claude_orch');
    for (const a of [docs, repo]) {
      expect(a.getAttribute('target')).toBe('_blank');
      expect(a.getAttribute('rel')).toBe('noopener noreferrer');
      expect(a.textContent).toBe('');
    }
  });
});
