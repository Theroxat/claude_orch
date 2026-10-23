import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  projects: [
    { name: 'early', testMatch: /\/0\d-.*\.spec\.mjs$/ },
    { name: 'pages', testMatch: /\/10-.*\.spec\.mjs$/, fullyParallel: true },
    { name: 'late', testMatch: /\/[2-9]\d-.*\.spec\.mjs$/ },
  ],
  globalSetup: './global-setup.mjs',
  // One shared stack. The flow specs (00-02, 20-24) mutate it and build on each other, so they run
  // serially (--workers=1); 10-pages is read-only and runs in parallel (see stack.sh `phases`).
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 8_000 },
  reporter: [['list'], ['json', { outputFile: process.env.ORCH_UI_REPORT ?? '/work/report.json' }]],
  outputDir: '/work/test-results',
  use: {
    baseURL: process.env.ORCH_UI_BASE ?? 'http://web',
    viewport: { width: 1280, height: 800 },
    trace: 'off',
    screenshot: 'off',
    video: 'off',
    permissions: ['clipboard-read', 'clipboard-write'],
  },
});
