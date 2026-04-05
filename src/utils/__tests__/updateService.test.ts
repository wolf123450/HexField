import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

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

  it('returns { available: false } when import.meta.env.DEV is true', async () => {
    // Vitest runs with import.meta.env.DEV = true (non-production mode), so the guard
    // returns early before attempting any network call.
    expect(import.meta.env.DEV).toBe(true)
    const { checkForUpdate } = await import('@/utils/updateService')
    const result = await checkForUpdate()
    expect(result).toEqual({ available: false })
  })

  it('returns { available: false } when not in a Tauri environment', async () => {
    // In the Vitest/jsdom environment __TAURI_INTERNALS__ is absent → isTauri is false
    expect('__TAURI_INTERNALS__' in window).toBe(false)
    const { checkForUpdate } = await import('@/utils/updateService')
    const result = await checkForUpdate()
    expect(result).toEqual({ available: false })
  })

  it('resolves without throwing', async () => {
    const { checkForUpdate } = await import('@/utils/updateService')
    await expect(checkForUpdate()).resolves.not.toThrow()
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

// ── Notification path (requires Tauri env simulation) ─────────────────────────
// These tests reset the module registry, stub globals, and use vi.doMock so the
// fresh import of updateService evaluates isTauri = true and the updater plugin
// returns a mock update.

describe('updateService.autoCheckForUpdate — update available', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  it('shows a notification with the version and an Install action', async () => {
    vi.resetModules()

    const showNotification = vi.fn()
    vi.doMock('@/stores/uiStore', () => ({ useUIStore: () => ({ showNotification }) }))
    vi.doMock('@/appConfig', () => ({ APP_NAME: 'GameChat' }))
    vi.doMock('@tauri-apps/plugin-updater', () => ({
      check: vi.fn().mockResolvedValue({
        version: '2.0.0',
        body: null,
        downloadAndInstall: vi.fn().mockResolvedValue(undefined),
      }),
    }))

    // Add __TAURI_INTERNALS__ to window so isTauri evaluates to true on fresh import
    vi.stubGlobal('__TAURI_INTERNALS__', {})
    // Override DEV to false so the guard in checkForUpdate doesn't short-circuit
    vi.stubEnv('DEV', false)

    const { autoCheckForUpdate } = await import('@/utils/updateService')
    await autoCheckForUpdate()

    expect(showNotification).toHaveBeenCalledWith(
      expect.stringContaining('2.0.0'),
      'info',
      0,
      expect.objectContaining({ label: 'Install update' }),
    )
  })
})


