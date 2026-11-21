import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './test',
  testMatch: '**/*.spec.mjs',
  workers: 1,
  use: {
    baseURL: 'http://127.0.0.1:8797',
    launchOptions: process.env.OCP_TEST_BROWSER ? { executablePath: process.env.OCP_TEST_BROWSER } : {},
  },
  webServer: {
    command: 'npm run test:worker',
    url: 'http://127.0.0.1:8797',
    timeout: 90000,
    reuseExistingServer: false,
    env: { WRANGLER_SEND_METRICS: 'false' },
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
