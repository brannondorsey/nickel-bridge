import { defineConfig } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Browser smoke tests (e2e/). Boots the BUILT server itself on an ephemeral
 * DB — run `npm run build` first, then `npm run test:e2e`.
 *
 * Locally, point CHROMIUM_PATH at an existing Chromium to skip the browser
 * download (e.g. CHROMIUM_PATH=/opt/pw-browsers/chromium). CI installs the
 * matching browser via `npx playwright install chromium`.
 */
const PORT = 3979;
const dbPath = join(mkdtempSync(join(tmpdir(), 'bridge-e2e-')), 'e2e.db');

export default defineConfig({
  testDir: './e2e',
  // Room for the rare heavy-tail double-dummy solve on slow CI hardware (the
  // in-test waits allow up to 60s for the first play burst alone).
  timeout: 120_000,
  retries: 0,
  use: {
    baseURL: `http://localhost:${PORT}`,
    viewport: { width: 390, height: 844 }, // phone-first, like real usage
    launchOptions: process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {},
  },
  webServer: {
    command: 'node server/dist/index.js',
    port: PORT,
    reuseExistingServer: false,
    // Surface server logs in test output — without this a server-side error
    // during a failure is invisible in CI.
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      PORT: String(PORT),
      DB_PATH: dbPath,
      DEV_AUTH: '1',
      LOG_LEVEL: 'warn',
    },
  },
});
