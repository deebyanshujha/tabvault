import { defineConfig } from '@playwright/test';

// Extensions need a persistent profile per test, and tab focus is global to a
// browser, so run serially against real Chromium.
export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  use: { actionTimeout: 15_000 },
  outputDir: 'test-results',
});
