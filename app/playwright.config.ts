import { resolve } from 'node:path';
import { defineConfig } from '@playwright/test';

// E2E_PORT lets parallel checkouts (git worktrees) run their own server instead of reusing
// another checkout's. The sound library is served from small fixtures, never the big data dir.
const port = Number(process.env.E2E_PORT ?? 5299);

export default defineConfig({
  testDir: 'e2e',
  timeout: 30_000,
  use: {
    baseURL: `http://localhost:${port}`,
    launchOptions: { args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'] },
  },
  webServer: {
    command: `npx vite --port ${port} --strictPort`,
    url: `http://localhost:${port}`,
    reuseExistingServer: true,
    env: { LATTICE_DATA_DIR: resolve(import.meta.dirname, 'tests/fixtures/library') },
  },
});
