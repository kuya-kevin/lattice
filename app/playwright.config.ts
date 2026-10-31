import { resolve } from 'node:path';
import { defineConfig } from '@playwright/test';

// E2E_PORT lets parallel checkouts (git worktrees) run their own server instead of reusing
// another checkout's. The sound library is served from small fixtures, never the big data dir.
const port = Number(process.env.E2E_PORT ?? 5299);

export default defineConfig({
  testDir: 'e2e',
  timeout: 30_000,
  // Electron specs run one at a time: in parallel they take as long and only slow each other
  // (and the load-sensitive audio timing specs) down. Listed first so their serial chain starts
  // at once instead of trailing the web specs.
  projects: [
    { name: 'electron', testMatch: /electron.*\.spec\.ts/, workers: 1 },
    { name: 'web', testIgnore: /electron.*\.spec\.ts/ },
  ],
  use: {
    baseURL: `http://localhost:${port}`,
    launchOptions: { args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'] },
  },
  webServer: {
    command: `npx vite --port ${port} --strictPort`,
    url: `http://localhost:${port}`,
    reuseExistingServer: true,
    env: {
      LATTICE_DATA_DIR: resolve(import.meta.dirname, 'tests/fixtures/library'),
      // extract_midi answers with a fixture manifest instead of running the Python sidecar
      LATTICE_SIDECAR_MOCK: resolve(import.meta.dirname, 'tests/fixtures/source_prep/manifest.json'),
      // B3: cleanup_noise / quantize_drums return the input audio with a mock result
      LATTICE_ENGINEER_MOCK: '1',
      // B2: push-to-talk clips "transcribe" to this text without calling Meta
      LATTICE_STT_MOCK: 'list the tracks',
    },
  },
});
