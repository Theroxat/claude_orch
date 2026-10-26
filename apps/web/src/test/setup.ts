import { cleanup, configure } from '@testing-library/react';
import { afterEach, beforeAll, vi } from 'vitest';
import { loadLocale, resetLocale } from '../i18n/index.ts';
import { loaders } from '../routes';

// Pages are code-split: load their chunks once so the first test of a file does not spend
// its `findBy` timeout on module transformation.
beforeAll(async () => {
  await Promise.all(Object.values(loaders).map((load) => load()));
  // Warm the French chunk too, then start every test in English.
  await loadLocale('fr');
  resetLocale();
});

// Role queries are slow in jsdom; the default 1s async timeout flakes when test files run in parallel.
configure({ asyncUtilTimeout: 5000 });

afterEach(() => {
  cleanup();
  resetLocale();
  vi.unstubAllGlobals();
});
