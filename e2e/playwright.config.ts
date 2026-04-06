import { defineConfig, devices } from '@playwright/test'

/**
 * HexField Playwright E2E configuration.
 *
 * Projects:
 *   browser — headless Chromium + mocked IPC. No app needed.
 *             Run: npx playwright test --project=browser --config e2e/playwright.config.ts
 *
 *   tauri   — real Tauri WebView via socket bridge. Start app first:
 *             Terminal 1:  cargo tauri dev --features e2e-testing
 *             Terminal 2:  npx playwright test --project=tauri --config e2e/playwright.config.ts
 *
 *   cdp     — Chrome DevTools Protocol to WebView2 (Windows only). Start app first:
 *             Terminal 1:  $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9222"
 *                          cargo tauri dev --features e2e-testing
 *             Terminal 2:  npx playwright test --project=cdp --config e2e/playwright.config.ts
 */
export default defineConfig({
  testDir: './tests',

  // Fail fast in CI; allow re-runs locally.
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,

  reporter: [
    ['list'],
    ['html', { outputFolder: '../playwright-report', open: 'never' }],
  ],

  use: {
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },

  projects: [
    // ── Browser mode ────────────────────────────────────────────────────
    // Headless Chromium; Tauri IPC calls go through the ipcMocks in fixtures.ts.
    // Requires the Vite dev server (started automatically below via webServer).
    {
      name: 'browser',
      use: {
        ...devices['Desktop Chrome'],
        // `mode` is the tauri-playwright option fixture.
        // Keep it at the default ('browser') — override per-test with test.use().
      },
    },

    // ── Tauri mode ──────────────────────────────────────────────────────
    // Connects to the real Tauri WebView via the plugin socket bridge.
    // You must start the app before running this project:
    //   cargo tauri dev --features e2e-testing
    {
      name: 'tauri',
      use: {
        // @ts-expect-error — mode is a tauri-playwright option fixture, not a Playwright type
        mode: 'tauri',
      },
    },

    // ── CDP mode (Windows only) ─────────────────────────────────────────
    // Full Playwright via Chrome DevTools Protocol to WebView2.
    // {
    //   name: 'cdp',
    //   use: { mode: 'cdp' },
    // },
  ],

  // Start the Vite dev server for browser-mode tests.
  // In CI, port 1420 must be free. Locally, reuse an existing server to save time.
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:1420',
    reuseExistingServer: !process.env.CI,
    stdout: 'ignore',
    stderr: 'pipe',
  },
})
