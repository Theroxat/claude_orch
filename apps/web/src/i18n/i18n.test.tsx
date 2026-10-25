import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/client';
import { relative } from '../time';
import { errorMessage } from './errors.ts';
import { formatDate, formatNumber } from './format.ts';
import {
  STORAGE_KEY,
  detectLocale,
  getLocale,
  initLocale,
  loadLocale,
  setLocale,
  t,
  useRich,
} from './index.ts';

afterEach(() => {
  localStorage.clear();
});

describe('t', () => {
  it('interpolates and selects plural forms per locale', async () => {
    expect(t('layout.nav.pendingRequests', { count: 1 })).toBe('1 pending request');
    expect(t('layout.nav.pendingRequests', { count: 3 })).toBe('3 pending requests');
    await loadLocale('fr');
    // French: 0 and 1 are singular.
    expect(t('layout.nav.pendingRequests', { count: 0 })).toBe('0 demande en attente');
    expect(t('layout.nav.pendingRequests', { count: 2 })).toBe('2 demandes en attente');
    expect(t('layout.nav.pendingRequests', { count: 1200 })).toBe(
      `${formatNumber(1200)} demandes en attente`,
    );
  });

  it('rejects missing placeholders at compile time', () => {
    // @ts-expect-error count is required
    expect(t('layout.nav.pendingRequests')).toBe('{count} pending requests');
    // @ts-expect-error unknown key
    expect(t('layout.nope')).toBe('layout.nope');
  });

  it('renders markup tags with elements', () => {
    function Probe() {
      const rich = useRich();
      return (
        <p>
          {rich(
            'layout.agentUpdate.outdated',
            { strong: (c) => <strong>{c}</strong> },
            { machine: 'box', from: '1.0.0', to: '1.1.0' },
          )}
        </p>
      );
    }
    render(<Probe />);
    expect(screen.getByText('box').tagName).toBe('STRONG');
    expect(screen.getByText(/is out of date \(v1\.0\.0 → v1\.1\.0\)/)).toBeTruthy();
  });

  it('never interprets markup or placeholders inside parameter values', () => {
    function Probe() {
      const rich = useRich();
      return (
        <p data-testid="p">
          {rich(
            'layout.agentUpdate.outdated',
            { strong: (c) => <strong>{c}</strong> },
            { machine: '<strong>x</strong> {from}', from: '1.0.0', to: '1.1.0' },
          )}
        </p>
      );
    }
    render(<Probe />);
    const p = screen.getByTestId('p');
    // Only the catalog's own <strong> is an element; the one in the value stays literal text.
    expect(p.querySelectorAll('strong')).toHaveLength(1);
    expect(p.textContent).toContain('<strong>x</strong> {from}');
  });

  it('formats relative times in the active locale', async () => {
    const now = Date.parse('2026-01-01T12:00:00Z');
    expect(relative('2026-01-01T14:05:00Z', now)).toBe('in 2h 5m');
    await loadLocale('fr');
    expect(relative('2026-01-01T11:55:00Z', now)).toBe('il y a 5 min');
    expect(formatDate('2026-10-14T00:00:00Z', { timeZone: 'UTC', dateStyle: 'long' })).toBe(
      '14 octobre 2026',
    );
  });
});

describe('locale detection', () => {
  it('prefers the saved choice, then the browser language, then English', () => {
    vi.stubGlobal('navigator', { language: 'fr-CA', languages: ['fr-CA', 'en'] });
    expect(detectLocale()).toBe('fr');
    localStorage.setItem(STORAGE_KEY, 'en');
    expect(detectLocale()).toBe('en');
    localStorage.removeItem(STORAGE_KEY);
    vi.stubGlobal('navigator', { language: 'de-DE', languages: ['de-DE'] });
    expect(detectLocale()).toBe('en');
  });

  it('ignores a garbled saved value and survives unavailable storage', () => {
    localStorage.setItem(STORAGE_KEY, 'klingon');
    vi.stubGlobal('navigator', { language: 'en-US', languages: [] });
    expect(detectLocale()).toBe('en');
    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    expect(detectLocale()).toBe('en');
    get.mockRestore();
  });

  it('persists the switcher choice and sets <html lang>', async () => {
    await setLocale('fr');
    expect(getLocale()).toBe('fr');
    expect(document.documentElement.lang).toBe('fr');
    expect(localStorage.getItem(STORAGE_KEY)).toBe('fr');
    await initLocale();
    expect(getLocale()).toBe('fr');
  });
});

describe('errorMessage', () => {
  it('translates stable API codes and keeps English server details in English', async () => {
    const closed = new ApiError(409, 'offer_closed', 'closed');
    const missing = new ApiError(404, 'not_found', 'Agent not found');
    expect(errorMessage(closed)).toMatch(/no longer available/);
    expect(errorMessage(missing)).toBe('Agent not found');
    await loadLocale('fr');
    expect(errorMessage(closed)).toMatch(/n’est plus disponible/);
    expect(errorMessage(missing)).toBe('Introuvable.');
    expect(errorMessage(new ApiError(418, 'teapot', 'I am a teapot'))).toBe(
      'La requête a échoué (418)',
    );
    expect(errorMessage(new TypeError('Failed to fetch'))).toMatch(/injoignable/);
  });
});
