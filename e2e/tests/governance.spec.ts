import { test, expect } from '../fixtures'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Page = any

async function createServer(page: Page, name: string) {
  await page.click('button.server-icon.add-server')
  await page.getByRole('menuitem', { name: 'Create a Server' }).click()
  await page.waitForSelector('.modal-backdrop', 10_000)
  await page.locator('.modal-box input.text-input').fill(name)
  await page.locator('.modal-box button.btn-primary').filter({ hasText: 'Create Server' }).click()

  const doneBtn = page.locator('.modal-box button.btn-primary').filter({ hasText: 'Done' })
  if (await doneBtn.isVisible().catch(() => false)) {
    await doneBtn.click()
    await page.waitForSelector('.modal-backdrop', 5_000).catch(() => {})
  }
}

async function openGovernanceModal(page: Page) {
  await page.locator('button[title="Governance"]').dispatchEvent('click')
  await page.waitForSelector('.governance-panel', 10_000)
}

async function createMotionDraft(page: Page, type = 'non_binding_poll', binding = false) {
  await page.locator('.governance-panel .btn-primary').filter({ hasText: '+ New Motion' }).click()
  await page.waitForSelector('.composer-card', 5_000)
  await page.locator('.composer-card .form-select').selectOption(type)
  if (binding) {
    const checkbox = page.locator('.composer-card input[type="checkbox"]')
    await checkbox.check()
  }
  await page.locator('.composer-card button').filter({ hasText: 'Create Draft' }).click()
  await page.waitForSelector('.composer-card', 5_000).catch(() => {})
}

// -- Tests -------------------------------------------------------------------

test('governance modal opens from sidebar server header', async ({ tauriPage }) => {
  test.setTimeout(60_000)
  await tauriPage.waitForSelector('.app-layout', 10_000)
  await createServer(tauriPage, 'Governance E2E')
  await openGovernanceModal(tauriPage)

  await tauriPage.waitForSelector('#governance-motions-title', 10_000)
  await expect(tauriPage.locator('#governance-motions-title')).toHaveText('Governance')
  await expect(tauriPage.locator('.governance-panel')).toBeVisible()
})

test('create a poll draft and click into its detail view', async ({ tauriPage }) => {
  test.setTimeout(60_000)
  await tauriPage.waitForSelector('.app-layout', 10_000)
  await createServer(tauriPage, 'Governance E2E')
  await openGovernanceModal(tauriPage)

  await createMotionDraft(tauriPage, 'non_binding_poll', false)

  // Motion card should appear in list
  await expect(tauriPage.locator('.motion-card')).toBeVisible()
  await expect(tauriPage.locator('.motion-type-badge').filter({ hasText: 'Poll' })).toBeVisible()

  // Click the card â†’ detail view opens
  await tauriPage.locator('.motion-card').first().click()
  await expect(tauriPage.locator('.motion-detail')).toBeVisible()
  await expect(tauriPage.locator('.type-badge').filter({ hasText: 'Poll' })).toBeVisible()
  await expect(tauriPage.locator('.state-badge').filter({ hasText: 'Draft' })).toBeVisible()

  // Back button returns to list
  await tauriPage.locator('.back-btn').click()
  await expect(tauriPage.locator('.motion-list')).toBeVisible()
})

test('poll lifecycle: draft â†’ discussion â†’ voting â†’ close with result', async ({ tauriPage }) => {
  test.setTimeout(90_000)
  await tauriPage.waitForSelector('.app-layout', 10_000)
  await createServer(tauriPage, 'Governance E2E')
  await openGovernanceModal(tauriPage)

  // Create a non-binding poll
  await createMotionDraft(tauriPage, 'non_binding_poll', false)
  await tauriPage.locator('.motion-card').first().click()
  await tauriPage.waitForSelector('.motion-detail', 5_000)

  // Draft state â†’ Open Discussion
  await expect(tauriPage.locator('.state-badge')).toHaveText('Draft')
  await tauriPage.locator('.action-btn').filter({ hasText: 'Open Discussion' }).click()
  await expect(tauriPage.locator('.state-badge')).toHaveText('Discussion')

  // Discussion section visible
  await expect(tauriPage.locator('.section-title').filter({ hasText: 'Discussion' })).toBeVisible()

  // Add a discussion post
  await tauriPage.locator('.post-textarea').fill('This is a test comment.')
  await tauriPage.locator('.section button').filter({ hasText: 'Post' }).click()
  await expect(tauriPage.locator('.post-content').filter({ hasText: 'This is a test comment.' })).toBeVisible()

  // Open voting (non-binding, no seconding needed)
  await tauriPage.locator('.action-btn').filter({ hasText: 'Open Voting' }).click()
  await expect(tauriPage.locator('.state-badge')).toHaveText('Voting')

  // Voting ballot is visible
  await expect(tauriPage.locator('.ballot-section')).toBeVisible()
  await expect(tauriPage.locator('.btn-approve')).toBeVisible()

  // Cast an approve vote
  await tauriPage.locator('.btn-approve').first().click()
  // Current vote indicator appears (re-voting allowed)
  await expect(tauriPage.locator('.current-vote')).toBeVisible()
  await expect(tauriPage.locator('.current-vote-value')).toHaveText('Approve')

  // Live tally shows on non-binding polls
  await expect(tauriPage.locator('.tally-preview')).toBeVisible()

  // Change vote to abstain
  await tauriPage.locator('.btn-abstain').click()
  await expect(tauriPage.locator('.current-vote-value')).toHaveText('Abstain')

  // Close and tally
  await tauriPage.locator('.action-btn').filter({ hasText: 'Close & Tally' }).click()
  await expect(tauriPage.locator('.result-badge')).toBeVisible()
  // Fixture mock always returns passed=true
  await expect(tauriPage.locator('.result-badge.passed')).toBeVisible()

  // Closed tally breakdown visible
  await expect(tauriPage.locator('.closed-tally')).toBeVisible()
})

test('cancel a draft motion', async ({ tauriPage }) => {
  test.setTimeout(60_000)
  await tauriPage.waitForSelector('.app-layout', 10_000)
  await createServer(tauriPage, 'Governance E2E')
  await openGovernanceModal(tauriPage)

  await createMotionDraft(tauriPage, 'rule_change', false)
  await tauriPage.locator('.motion-card').first().click()
  await tauriPage.waitForSelector('.motion-detail', 5_000)

  await tauriPage.locator('.action-btn').filter({ hasText: 'Cancel Motion' }).click()
  await expect(tauriPage.locator('.state-badge')).toHaveText('Cancelled')
  // No action buttons remain
  await expect(tauriPage.locator('.action-bar')).not.toBeVisible()
})

test('election lifecycle: nominate candidate and advance to voting', async ({ tauriPage }) => {
  test.setTimeout(90_000)
  await tauriPage.waitForSelector('.app-layout', 10_000)
  await createServer(tauriPage, 'Governance E2E')
  await openGovernanceModal(tauriPage)

  await createMotionDraft(tauriPage, 'election', false)
  await tauriPage.locator('.motion-card').first().click()
  await tauriPage.waitForSelector('.motion-detail', 5_000)

  // Candidates section should be visible for elections
  await expect(tauriPage.locator('.section-title').filter({ hasText: 'Candidates' })).toBeVisible()

  // Self-nominate
  await tauriPage.locator('button').filter({ hasText: '+ Nominate Yourself' }).click()
  await expect(tauriPage.locator('.candidate-entry')).toBeVisible()

  // Advance to discussion then voting
  await tauriPage.locator('.action-btn').filter({ hasText: 'Open Discussion' }).click()
  await expect(tauriPage.locator('.state-badge')).toHaveText('Discussion')

  await tauriPage.locator('.action-btn').filter({ hasText: 'Open Voting' }).click()
  await expect(tauriPage.locator('.state-badge')).toHaveText('Voting')

  // Approval voting checkboxes present for the nominated candidate
  await expect(tauriPage.locator('.candidate-list .candidate-row')).toBeVisible()
})

