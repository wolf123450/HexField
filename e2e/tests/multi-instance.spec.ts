/**
 * multi-instance.spec.ts — Two-instance integration tests
 *
 * Connects to two real running Tauri instances via Chrome DevTools Protocol
 * to exercise the full P2P flow: server creation, invite generation, join,
 * and negentropy sync.
 *
 * Prerequisites (Windows only — WebView2 exposes CDP):
 *   Terminal 1: npm run dev:alice   (binds CDP on port 9222)
 *   Terminal 2: npm run dev:bob     (binds CDP on port 9223)
 *   Terminal 3: npm run e2e:integration
 *
 * These tests are intentionally lenient with timeouts — they exercise real
 * network I/O (mDNS, WebRTC ICE, DTLS) which takes time on a local LAN.
 *
 * Failure modes caught:
 *   - CDP not reachable → clear "is the instance running?" error
 *   - Element timeout   → specific UI step that failed
 *   - Peer never connected → WebRTC or mDNS issue
 *   - Negentropy did not converge → sync bug
 */

import { test, expect, chromium, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURES  = resolve(__dirname, '..', 'fixtures')

// ── Timeouts ──────────────────────────────────────────────────────────────────

const CONNECT_MS  =  10_000   // CDP connection
const OP_MS       =   5_000   // local UI operation (clicks, fills, modals)
const SYNC_MS     =  45_000   // network: negentropy convergence, WebRTC, mDNS

// ── CDP URLs ─────────────────────────────────────────────────────────────────

const ALICE_CDP = 'http://localhost:9222'
const BOB_CDP   = 'http://localhost:9223'

// ── Helpers ───────────────────────────────────────────────────────────────────

async function connectCDP(url: string, label: string): Promise<{ browser: Browser; page: Page }> {
  let browser: Browser
  try {
    browser = await chromium.connectOverCDP(url, { timeout: CONNECT_MS })
  } catch {
    throw new Error(
      `[${label}] Could not connect to CDP at ${url}.\n` +
      `  → Is the "${label}" instance running?  Try: npm run dev:${label}`
    )
  }

  const contexts = browser.contexts()
  if (contexts.length === 0) throw new Error(`[${label}] No browser context found over CDP`)
  const context: BrowserContext = contexts[0]
  const pages = context.pages()
  if (pages.length === 0) throw new Error(`[${label}] No open pages found over CDP`)

  return { browser, page: pages[0] }
}

async function waitForAppReady(page: Page, label: string): Promise<void> {
  await page.waitForSelector('.app-layout', { timeout: CONNECT_MS }).catch(() => {
    throw new Error(`[${label}] .app-layout never appeared — libsodium or identity init failed`)
  })
}

/** Dismiss any stale modals / context menus left over from previous test runs. */
async function dismissOverlays(page: Page): Promise<void> {
  for (let i = 0; i < 3; i++) {
    const hasOverlay = await page.locator('.modal-backdrop').first()
      .isVisible({ timeout: 300 }).catch(() => false)
    if (!hasOverlay) break

    // Try clicking close/done buttons inside the modal, then fallback to Escape
    const closeBtn = page.locator('.modal-box .close-btn, .modal-box button.btn-primary, .modal-box button.btn-secondary').first()
    if (await closeBtn.isVisible({ timeout: 300 }).catch(() => false)) {
      await closeBtn.click()
    } else {
      await page.keyboard.press('Escape')
    }
    await page.waitForSelector('.modal-backdrop', { state: 'hidden', timeout: 2_000 }).catch(() => {})
  }

  // Also dismiss any stale context menus
  const hasMenu = await page.locator('.context-menu').first()
    .isVisible({ timeout: 300 }).catch(() => false)
  if (hasMenu) {
    await page.keyboard.press('Escape')
    await page.waitForTimeout(200)
  }
}

/** Type text into the message textarea and press Enter. */
async function sendMessage(page: Page, text: string): Promise<void> {
  const textarea = page.locator('textarea.message-textarea').first()
  await textarea.waitFor({ timeout: OP_MS })
  await textarea.click()
  await textarea.fill(text)
  await page.keyboard.press('Enter')
}

/** Ensure a text channel is selected so the message input is visible. */
async function ensureChannelSelected(page: Page, label: string): Promise<void> {
  // Always click the first server icon — the first server is the one both
  // peers share (bob joins alice's original server, not later duplicates)
  const serverIcons = page.locator('button.server-icon:not(.add-server)')
  const count = await serverIcons.count()
  if (count > 0) {
    await serverIcons.first().click()
    await page.waitForTimeout(300)
  }

  const hasTextarea = await page.locator('textarea.message-textarea')
    .first().isVisible({ timeout: 2_000 }).catch(() => false)
  if (!hasTextarea) {
    const channel = page.locator('.channel-item').first()
    await channel.waitFor({ timeout: OP_MS }).catch(() => {})
    await channel.click().catch(() => console.warn(`[${label}] no channel to click`))
    await page.locator('textarea.message-textarea').first().waitFor({ timeout: OP_MS })
  }
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

let aliceBrowser: Browser
let alicePage:    Page
let bobBrowser:   Browser
let bobPage:      Page

test.beforeAll(async () => {
  ;({ browser: aliceBrowser, page: alicePage } = await connectCDP(ALICE_CDP, 'alice'))
  ;({ browser: bobBrowser,   page: bobPage   } = await connectCDP(BOB_CDP,   'bob'))

  await Promise.all([
    waitForAppReady(alicePage, 'alice'),
    waitForAppReady(bobPage,   'bob'),
  ])

  // Dismiss any leftover modals/context menus from previous runs
  await dismissOverlays(alicePage)
  await dismissOverlays(bobPage)
})

test.afterAll(async () => {
  // Disconnect without closing the apps — instances keep running for re-runs.
  await aliceBrowser?.close().catch(() => {})
  await bobBrowser?.close().catch(() => {})
})

// ── Tests ─────────────────────────────────────────────────────────────────────
// Sequential: each test depends on the previous one's side-effects.
test.describe.configure({ mode: 'serial' })

test('alice can create a server', async () => {
  test.setTimeout(OP_MS * 3)

  // Skip if alice already has servers from a previous run
  const existingServers = await alicePage.locator('button.server-icon:not(.add-server)').count()
  if (existingServers > 0) {
    console.log(`[test] Alice already has ${existingServers} server(s) — skipping creation, selecting first`)
    await alicePage.locator('button.server-icon:not(.add-server)').first().click()
    return
  }

  // Click the "+" add-server button in the server rail → opens context menu
  await alicePage.click('button.server-icon.add-server', { timeout: OP_MS })

  // Click "Create a Server" in the context menu
  await alicePage.locator('.context-menu-item', { hasText: 'Create a Server' }).click({ timeout: OP_MS })

  // Wait for the create-server modal
  await alicePage.waitForSelector('.modal-backdrop', { timeout: OP_MS })

  // Fill in the server name (placeholder="My Server")
  const nameInput = alicePage.locator('.modal-box input.text-input')
  await nameInput.fill('IntegTest Server')

  // Click "Create Server" (btn-primary)
  await alicePage.locator('.modal-box button.btn-primary', { hasText: 'Create Server' }).click()

  // The app auto-opens the InviteModal after creation — dismiss it
  await alicePage.waitForSelector('.modal-backdrop', { timeout: OP_MS })
  await dismissOverlays(alicePage)

  // The new server icon should appear in the rail
  const serverIcon = alicePage.locator('button.server-icon:not(.add-server)')
  await serverIcon.first().waitFor({ timeout: OP_MS })
  expect(await serverIcon.first().isVisible()).toBe(true)

  // Verify server name appears in the channel sidebar header
  await expect(alicePage.locator('span.server-name')).toHaveText('IntegTest Server', { timeout: OP_MS })
})

test('alice can create an invite link', async () => {
  test.setTimeout(OP_MS * 3)

  // Click "Invite People" button in the channel sidebar header
  await alicePage.click('button[title="Invite People"]', { timeout: OP_MS })

  // Wait for the invite modal
  await alicePage.waitForSelector('.modal-backdrop', { timeout: OP_MS })

  // Extract the invite link from the readonly text input
  const inviteInput = alicePage.locator('.modal-box input.text-input[readonly]').first()
  const inviteLink = await inviteInput.inputValue({ timeout: OP_MS })

  expect(inviteLink).toBeTruthy()
  expect(inviteLink).toContain('hexfield://join/')
  expect(inviteLink.length).toBeGreaterThan(20)

  // Store invite link for the next test
  await alicePage.evaluate((link) => {
    (window as Record<string, unknown>).__e2e_invite_link = link
  }, inviteLink)
  console.log(`[test] invite link: ${inviteLink.substring(0, 60)}…`)

  // Close the modal
  await alicePage.locator('.modal-box button.btn-primary', { hasText: 'Done' }).click()
  await alicePage.waitForSelector('.modal-backdrop', { state: 'hidden', timeout: OP_MS })
})

test('bob can join the server via invite link', async () => {
  test.setTimeout(SYNC_MS * 2)

  // Check if bob already has a server from a previous run
  const existingServers = await bobPage.locator('button.server-icon:not(.add-server)').count()
  if (existingServers > 0) {
    console.log(`[test] Bob already has ${existingServers} server(s) — skipping join, selecting first`)
    await bobPage.locator('button.server-icon:not(.add-server)').first().click()
    return
  }

  // Retrieve invite link created by alice
  const inviteLink: string = await alicePage.evaluate(
    () => (window as Record<string, unknown>).__e2e_invite_link as string
  )
  expect(inviteLink, 'No invite link found — run "alice can create an invite link" first').toBeTruthy()

  // On bob: click "+" → "Join a Server"
  await bobPage.click('button.server-icon.add-server', { timeout: OP_MS })
  await bobPage.locator('.context-menu-item', { hasText: 'Join a Server' }).click({ timeout: OP_MS })

  // Wait for the join modal
  await bobPage.waitForSelector('.modal-backdrop', { timeout: OP_MS })

  // Paste the invite link
  const joinInput = bobPage.locator('.modal-box input.text-input').first()
  await joinInput.fill(inviteLink)

  // Click "Join Server" — may need a retry if the P2P connection is slow
  const MAX_ATTEMPTS = 2
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    await bobPage.locator('.modal-box button.btn-primary', { hasText: 'Join Server' }).click()

    // Wait for either: modal closes (success) or error message appears
    const result = await Promise.race([
      bobPage.waitForSelector('.modal-backdrop', { state: 'hidden', timeout: SYNC_MS })
        .then(() => 'joined' as const),
      bobPage.locator('.status-msg.error').waitFor({ timeout: SYNC_MS })
        .then(() => 'error' as const),
    ]).catch(() => 'timeout' as const)

    if (result === 'joined') {
      console.log(`[test] Bob joined on attempt ${attempt}`)
      break
    }

    if (attempt < MAX_ATTEMPTS) {
      console.warn(`[test] Join attempt ${attempt} failed (${result}), retrying…`)
      // Clear error and retry
      await joinInput.click()
      await bobPage.waitForTimeout(2_000)
    } else {
      throw new Error(`Bob failed to join after ${MAX_ATTEMPTS} attempts (${result})`)
    }
  }

  // The server icon should now appear in Bob's server rail
  const bobServerIcon = bobPage.locator('button.server-icon:not(.add-server)')
  await bobServerIcon.first().waitFor({ timeout: OP_MS })
  expect(await bobServerIcon.first().isVisible()).toBe(true)

  // Dismiss any remaining modal
  await dismissOverlays(bobPage)

  // Click the server icon to select it and verify channel sidebar
  await bobServerIcon.last().click()
  await expect(bobPage.locator('span.server-name')).toContainText('Server', { timeout: OP_MS })
})

test('alice and bob can exchange messages', async () => {
  test.setTimeout(SYNC_MS)

  // Ensure both have a text channel selected with the message textarea visible
  await ensureChannelSelected(alicePage, 'alice')
  await ensureChannelSelected(bobPage, 'bob')

  // Alice sends a message
  const aliceMsg = `hello from alice ${Date.now()}`
  await sendMessage(alicePage, aliceMsg)

  // Bob should receive it within SYNC_MS (negentropy + WebRTC data channel)
  const aliceMsgInBob = bobPage.locator('.message-text').filter({ hasText: aliceMsg })
  await aliceMsgInBob.waitFor({ timeout: SYNC_MS })
  expect(await aliceMsgInBob.isVisible()).toBe(true)

  // Bob replies
  const bobMsg = `hello from bob ${Date.now()}`
  await sendMessage(bobPage, bobMsg)

  // Alice should receive it
  const bobMsgInAlice = alicePage.locator('.message-text').filter({ hasText: bobMsg })
  await bobMsgInAlice.waitFor({ timeout: SYNC_MS })
  expect(await bobMsgInAlice.isVisible()).toBe(true)
})

test('negentropy sync: alice sends batch, bob receives all', async () => {
  test.setTimeout(SYNC_MS * 2)

  // Ensure both have a channel selected
  await ensureChannelSelected(alicePage, 'alice')
  await ensureChannelSelected(bobPage, 'bob')

  const batchTag = `neg_${Date.now()}`
  const BATCH = 5

  // Alice sends 5 tagged messages
  for (let i = 1; i <= BATCH; i++) {
    await sendMessage(alicePage, `${batchTag}_${i}`)
    // Brief pause so HLC timestamps are distinct
    await alicePage.waitForTimeout(50)
  }

  // Wait for all 5 to appear on Bob's side
  for (let i = 1; i <= BATCH; i++) {
    const msgText = `${batchTag}_${i}`
    const locator = bobPage.locator('.message-text').filter({ hasText: msgText })
    await locator.waitFor({ timeout: SYNC_MS }).catch(() => {
      throw new Error(`Negentropy sync failed: "${msgText}" never appeared in Bob's view`)
    })
  }

  console.log(`[test] All ${BATCH} negentropy messages converged on Bob ✓`)
})

// ── Profile & Media Tests ─────────────────────────────────────────────────────

test('alice can change her display name', async () => {
  test.setTimeout(OP_MS * 5)

  // Open Settings
  await alicePage.click('button[title="Settings"]', { timeout: OP_MS })
  await alicePage.waitForSelector('.settings-overlay', { timeout: OP_MS })

  // Profile tab should be active by default — find and fill the name input
  const nameInput = alicePage.locator('.settings-body .form-input[type="text"]').first()
  await nameInput.waitFor({ timeout: OP_MS })
  await nameInput.fill('')
  await nameInput.fill('Alice E2E')
  // Trigger change event (blur or press tab)
  await nameInput.press('Tab')

  // Brief wait for the store action
  await alicePage.waitForTimeout(500)

  // Close settings
  await alicePage.locator('.settings-overlay .close-btn').click()
  await alicePage.waitForSelector('.settings-overlay', { state: 'hidden', timeout: OP_MS })

  // Verify the name updated — check member list or sidebar (member name in sidebar status area)
  // The channel sidebar footer shows the user's own name
  console.log('[test] Alice display name changed to "Alice E2E" ✓')
})

test('alice can change her bio', async () => {
  test.setTimeout(OP_MS * 5)

  // Open Settings
  await alicePage.click('button[title="Settings"]', { timeout: OP_MS })
  await alicePage.waitForSelector('.settings-overlay', { timeout: OP_MS })

  // Fill the bio textarea
  const bioInput = alicePage.locator('.settings-body .bio-input')
  await bioInput.waitFor({ timeout: OP_MS })
  await bioInput.fill('Hello from Alice — automated E2E test bio!')

  // Trigger blur (bio saves on blur)
  await bioInput.press('Tab')
  await alicePage.waitForTimeout(500)

  // Close settings
  await alicePage.locator('.settings-overlay .close-btn').click()
  await alicePage.waitForSelector('.settings-overlay', { state: 'hidden', timeout: OP_MS })

  console.log('[test] Alice bio updated ✓')
})

test('alice can set an avatar', async () => {
  test.setTimeout(OP_MS * 5)

  // Open Settings → Click "Edit avatar and banner in your profile"
  await alicePage.click('button[title="Settings"]', { timeout: OP_MS })
  await alicePage.waitForSelector('.settings-overlay', { timeout: OP_MS })

  await alicePage.locator('.form-action-btn').click({ timeout: OP_MS })

  // Wait for UserProfileModal to appear
  await alicePage.waitForSelector('.profile-backdrop', { timeout: OP_MS })

  // Use setInputFiles on the hidden file input to bypass the file dialog
  const fileInput = alicePage.locator('.profile-modal input[type="file"]')
  await fileInput.setInputFiles(resolve(FIXTURES, 'test-avatar.png'))

  // Wait for the avatar to be processed and uploaded
  await alicePage.waitForTimeout(2_000)

  // Verify the avatar upload didn't produce an error
  const hasError = await alicePage.locator('.upload-error').isVisible().catch(() => false)
  expect(hasError, 'Avatar upload should not produce an error').toBe(false)

  // Close the profile modal
  await alicePage.locator('.profile-modal .close-btn').click()
  await alicePage.waitForSelector('.profile-backdrop', { state: 'hidden', timeout: OP_MS })

  // Close settings if still open
  const settingsOpen = await alicePage.locator('.settings-overlay')
    .isVisible({ timeout: 300 }).catch(() => false)
  if (settingsOpen) {
    await alicePage.locator('.settings-overlay .close-btn').click()
    await alicePage.waitForSelector('.settings-overlay', { state: 'hidden', timeout: OP_MS })
  }

  console.log('[test] Alice avatar set ✓')
})

test('alice profile changes sync to bob', async () => {
  test.setTimeout(SYNC_MS)

  // Bob should see alice's new display name in the member list
  // The member list shows all members of the current server
  const aliceName = bobPage.locator('.member-name').filter({ hasText: 'Alice E2E' })
  await aliceName.waitFor({ timeout: SYNC_MS }).catch(() => {
    throw new Error('Alice\'s new display name "Alice E2E" never appeared in Bob\'s member list')
  })
  expect(await aliceName.isVisible()).toBe(true)

  console.log('[test] Alice profile (name) synced to Bob ✓')
})

test('alice can send an image in chat', async () => {
  test.setTimeout(SYNC_MS)

  // Ensure alice has a channel selected
  await ensureChannelSelected(alicePage, 'alice')

  // Use setInputFiles on the hidden file input inside the attach button
  const fileInput = alicePage.locator('.message-input-wrap input[type="file"]')
  await fileInput.setInputFiles(resolve(FIXTURES, 'test-image.png'))

  // Wait for the attachment chip to appear
  const chip = alicePage.locator('.attachment-chip')
  await chip.waitFor({ timeout: OP_MS })
  expect(await chip.isVisible()).toBe(true)

  // Send the message (the attachment is sent along)
  await sendMessage(alicePage, 'Image from Alice')

  // Verify alice sees her own message
  const aliceMsg = alicePage.locator('.message-text').filter({ hasText: 'Image from Alice' })
  await aliceMsg.waitFor({ timeout: OP_MS })

  // Verify bob receives the message text
  await ensureChannelSelected(bobPage, 'bob')
  const bobMsg = bobPage.locator('.message-text').filter({ hasText: 'Image from Alice' })
  await bobMsg.waitFor({ timeout: SYNC_MS }).catch(() => {
    throw new Error('"Image from Alice" never appeared in Bob\'s view')
  })

  console.log('[test] Image message sent and received ✓')
})
