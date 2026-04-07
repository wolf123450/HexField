import { test, expect } from '../fixtures'

/**
 * Smoke tests — verify the app shell loads and the core layout renders.
 *
 * These run in browser mode (headless Chromium + mocked IPC) by default.
 * To run against the real Tauri app use --project=tauri after starting:
 *   cargo tauri dev --features e2e-testing
 */

test('page title is HexField', async ({ tauriPage }) => {
  const title = await tauriPage.title()
  expect(title).toBe('HexField')
})

test('main layout renders after identity init', async ({ tauriPage }) => {
  // The router redirects / → /servers which mounts MainLayout (.app-layout).
  // We wait up to 10s for libsodium WASM to init + identity to generate.
  await tauriPage.waitForSelector('.app-layout', 10_000)
  const visible = await tauriPage.isVisible('.app-layout')
  expect(visible).toBe(true)
})

test('server rail is present in the layout', async ({ tauriPage }) => {
  await tauriPage.waitForSelector('.server-rail', 10_000)
  const visible = await tauriPage.isVisible('.server-rail')
  expect(visible).toBe(true)
})
