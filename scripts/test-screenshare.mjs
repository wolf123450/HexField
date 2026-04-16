/**
 * Quick script to test screen share profiling via CDP.
 * Connects to alice's WebView2 over CDP and invokes screen share via Tauri IPC.
 * 
 * Prerequisites:
 *   - Vite running on port 1420
 *   - Alice instance running: npm run dev:tauri -- alice
 *
 * Usage: node scripts/test-screenshare.mjs
 */

import { chromium } from '@playwright/test'

const ALICE_CDP = 'http://localhost:9222'

async function main() {
  console.log('[test] Connecting to alice via CDP...')
  const browser = await chromium.connectOverCDP(ALICE_CDP, { timeout: 10_000 })
  const page = browser.contexts()[0].pages()[0]
  console.log('[test] Connected. Page title:', await page.title())

  // Enumerate screens to get a valid source_id
  console.log('[test] Enumerating screens...')
  const sources = await page.evaluate(() => {
    return window.__TAURI__.core.invoke('media_enumerate_screens', {})
  })
  console.log('[test] Available sources:', JSON.stringify(sources, null, 2))

  if (!sources.monitors || sources.monitors.length === 0) {
    console.error('[test] No monitors found!')
    await browser.close()
    process.exit(1)
  }

  const sourceId = sources.monitors[0].id
  console.log(`[test] Using source: ${sourceId} (${sources.monitors[0].name})`)

  // Start screen share directly via Tauri command (bypass UI)
  console.log('[test] Starting screen share...')
  try {
    await page.evaluate((sid) => {
      return window.__TAURI__.core.invoke('media_start_screen_share', {
        sourceId: sid,
        fps: 30,
        bitrateKbps: 0
      })
    }, sourceId)
    console.log('[test] Screen share started! Check terminal for profiling output.')
  } catch (err) {
    console.error('[test] Screen share failed:', err.message)
  }

  // Wait 15 seconds to collect profiling data
  console.log('[test] Waiting 15 seconds for profiling data...')
  await new Promise(r => setTimeout(r, 15_000))

  // Stop screen share
  console.log('[test] Stopping screen share...')
  try {
    await page.evaluate(() => {
      return window.__TAURI__.core.invoke('media_stop_screen_share', {})
    })
    console.log('[test] Screen share stopped.')
  } catch (err) {
    console.error('[test] Stop failed:', err.message)
  }

  await browser.close()
  console.log('[test] Done. Check alice terminal for profiling output.')
}

main().catch(err => {
  console.error('[test] Fatal:', err.message)
  process.exit(1)
})
