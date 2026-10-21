import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: /\d\d-.*\.spec\.mjs$/,
  globalSetup: './global-setup.mjs',
  workers: 1, // one shared stack; the specs are ordered (01-, 02-, ...) and build on each other
  fullyParallel: false,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 8_000 },
  reporter: [['list'], ['json', { outputFile: '/work/report.json' }]],
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
