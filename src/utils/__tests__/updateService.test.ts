import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Mocks ──────────────────────────────────────────────────────────────────────

const mockShowNotification = vi.fn()
vi.mock('@/stores/uiStore', () => ({
  useUIStore: () => ({ showNotification: mockShowNotification }),
}))

vi.mock('@/appConfig', () => ({ APP_NAME: 'GameChat' }))

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('updateService.checkForUpdate', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns { available: false } when not in a Tauri environment', async () => {
    // In the Vitest environment __TAURI_INTERNALS__ is absent → isTauri is false
    const { checkForUpdate } = await import('@/utils/updateService')
    const result = await checkForUpdate()
    expect(result.available).toBe(false)
  })

  it('resolves without throwing', async () => {
    const { checkForUpdate } = await import('@/utils/updateService')
    await expect(checkForUpdate()).resolves.not.toThrow()
  })

  it('returns an object with a boolean available field', async () => {
    const { checkForUpdate } = await import('@/utils/updateService')
    const result = await checkForUpdate()
    expect(typeof result.available).toBe('boolean')
  })
})

describe('updateService.autoCheckForUpdate', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('does not show notification when no update is available', async () => {
    // In the Vitest environment isTauri is false → checkForUpdate returns { available: false }
    const { autoCheckForUpdate } = await import('@/utils/updateService')
    await autoCheckForUpdate()
    expect(mockShowNotification).not.toHaveBeenCalled()
  })
})


