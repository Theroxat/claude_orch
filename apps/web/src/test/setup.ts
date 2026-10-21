import { cleanup, configure } from '@testing-library/react';
import { afterEach, beforeAll, vi } from 'vitest';
import { loaders } from '../routes';

// Pages are code-split: load their chunks once so the first test of a file does not spend
// its `findBy` timeout on module transformation.
beforeAll(async () => {
  await Promise.all(Object.values(loaders).map((load) => load()));
});

// Role queries are slow in jsdom; the default 1s async timeout flakes when test files run in parallel.
configure({ asyncUtilTimeout: 5000 });

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
