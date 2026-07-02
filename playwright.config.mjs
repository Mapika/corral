// Phone-viewport smoke against the demo backend (CORRAL_DEMO=1 — deterministic herd, no real
// agents). `npm run build` must have produced dist/ first; the server serves the built bundle.
import { defineConfig } from '@playwright/test';

const PORT = 7897;

export default defineConfig({
  testDir: 'tests',
  timeout: 60_000,
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    viewport: { width: 390, height: 844 },   // the phone the mobile console is built for
  },
  webServer: {
    command: 'node server.js',
    env: { CORRAL_DEMO: '1', PORT: String(PORT) },
    url: `http://127.0.0.1:${PORT}/api/hosts`,
    reuseExistingServer: false,
  },
});
