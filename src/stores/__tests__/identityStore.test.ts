import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))

vi.mock('@/services/cryptoService', () => ({
  cryptoService: {
    init:             vi.fn().mockResolvedValue(undefined),
    generateKeys:     vi.fn().mockResolvedValue({ signSecret: 'gen-sign-b64', dhSecret: 'gen-dh-b64' }),
    loadKeys:         vi.fn().mockResolvedValue(undefined),
    getPublicSignKey: vi.fn().mockReturnValue('mock-pub-sign'),
    getPublicDHKey:   vi.fn().mockReturnValue('mock-pub-dh'),
  },
}))

vi.mock('@/stores/devicesStore', () => ({
  useDevicesStore: () => ({ initDeviceIdentity: vi.fn().mockResolvedValue(undefined) }),
}))

describe('identityStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  // ── First launch ───────────────────────────────────────────────────────────

  it('first launch — generates keys, saves to DB, populates refs', async () => {
    const { invoke } = await import('@tauri-apps/api/core')
    // All db_load_key calls return null — no existing identity
    vi.mocked(invoke).mockImplementation(async (cmd) => {
      if (cmd === 'db_load_key') return null
      return undefined
    })

    const { useIdentityStore } = await import('@/stores/identityStore')
    const { cryptoService }    = await import('@/services/cryptoService')
    const store = useIdentityStore()
    await store.initializeIdentity()

    expect(cryptoService.generateKeys).toHaveBeenCalled()
    expect(cryptoService.loadKeys).not.toHaveBeenCalled()
    expect(store.userId).toBeTruthy()
    expect(store.displayName).toBe('Player')
    expect(store.publicSignKey).toBe('mock-pub-sign')
    expect(store.publicDHKey).toBe('mock-pub-dh')
    expect(store.isRegistered).toBe(true)

    // Must have persisted new keys to KV store
    expect(invoke).toHaveBeenCalledWith('db_save_key',
      expect.objectContaining({ keyId: 'local_sign_secret' }))
    expect(invoke).toHaveBeenCalledWith('db_save_key',
      expect.objectContaining({ keyId: 'local_dh_secret' }))
    expect(invoke).toHaveBeenCalledWith('db_save_key',
      expect.objectContaining({ keyId: 'local_user_id' }))
  })

  // ── Subsequent launch ──────────────────────────────────────────────────────

  it('subsequent launch — loads existing keys without generating new ones', async () => {
    const { invoke } = await import('@tauri-apps/api/core')
    vi.mocked(invoke).mockImplementation(async (cmd, args) => {
      if (cmd !== 'db_load_key') return undefined
      const keyId = (args as any).keyId as string
      const values: Record<string, string | null> = {
        local_sign_secret:   'existing-sign-secret',
        local_dh_secret:     'existing-dh-secret',
        local_user_id:       'existing-user-id-abc',
        local_display_name:  'ExistingPlayer',
        local_avatar_data:   null,
        local_bio:           null,
        local_banner_color:  null,
        local_banner_data:   null,
      }
      return values[keyId] ?? null
    })

    const { useIdentityStore } = await import('@/stores/identityStore')
    const { cryptoService }    = await import('@/services/cryptoService')
    const store = useIdentityStore()
    await store.initializeIdentity()

    expect(cryptoService.loadKeys).toHaveBeenCalledWith('existing-sign-secret', 'existing-dh-secret')
    expect(cryptoService.generateKeys).not.toHaveBeenCalled()
    expect(store.userId).toBe('existing-user-id-abc')
    expect(store.displayName).toBe('ExistingPlayer')
    expect(store.isRegistered).toBe(true)

    // Must NOT have written new keys — only reads occurred
    expect(invoke).not.toHaveBeenCalledWith('db_save_key',
      expect.objectContaining({ keyId: 'local_sign_secret' }))
  })

  // ── updateAvatar ───────────────────────────────────────────────────────────

  it('updateAvatar sets avatarDataUrl ref (synchronous)', async () => {
    const { invoke } = await import('@tauri-apps/api/core')
    vi.mocked(invoke).mockResolvedValue(null)

    const { useIdentityStore } = await import('@/stores/identityStore')
    const store = useIdentityStore()

    store.updateAvatar('data:image/png;base64,testavatar==')
    expect(store.avatarDataUrl).toBe('data:image/png;base64,testavatar==')
  })
})
