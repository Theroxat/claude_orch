import { cleanup, configure } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

// Role queries are slow in jsdom; the default 1s async timeout flakes when test files run in parallel.
configure({ asyncUtilTimeout: 5000 });

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
