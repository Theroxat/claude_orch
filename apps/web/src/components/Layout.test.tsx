import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { me, mockApi, renderApp } from '../test/helpers';

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
