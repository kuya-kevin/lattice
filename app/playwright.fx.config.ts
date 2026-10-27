// Effects verification renders (headless Chromium, same engine as the app).
//   FX_OUT=<dir with cases.json> npx playwright test -c playwright.fx.config.ts
// cases.json and the test signals come from spikes/fx_verify/signals.py; renders land in
// $FX_OUT/renders and are measured by spikes/fx_verify/test_fx.py.
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e-fx',
  timeout: 900_000,
  use: { baseURL: 'http://localhost:5180' },
  webServer: { command: 'npx vite --port 5180 --strictPort', url: 'http://localhost:5180/fxlab.html', reuseExistingServer: true },
});
