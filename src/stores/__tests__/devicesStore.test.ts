import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { Device } from '@/types/core'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))

// cryptoService is not needed directly in these tests — devicesStore uses it
// only during initDeviceIdentity which we don't invoke here.
vi.mock('@/services/cryptoService', () => ({
  cryptoService: {
    generateDeviceKeys: vi.fn().mockResolvedValue({ deviceSignSecret: 'ssec', deviceDHSecret: 'dhsec' }),
    loadDeviceKeys:     vi.fn().mockResolvedValue(undefined),
    getDevicePublicSignKey: vi.fn().mockReturnValue('dev-sign-pub'),
    getDevicePublicDHKey:   vi.fn().mockReturnValue('dev-dh-pub'),
  },
}))

function makeDevice(overrides: Partial<Device> = {}): Device {
  return {
    deviceId:      'dev-1',
    userId:        'user-alice',
    publicSignKey: 'spk',
    publicDHKey:   'dhpk',
    revoked:       false,
    createdAt:     '2025-01-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('devicesStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  // ── receiveAttestedDevice ──────────────────────────────────────────────────

  it('receiveAttestedDevice persists device with revoked: false (boolean, not 0)', async () => {
    const { invoke } = await import('@tauri-apps/api/core')
    vi.mocked(invoke).mockResolvedValue(undefined)

    const { useDevicesStore } = await import('@/stores/devicesStore')
    const store = useDevicesStore()

    await store.receiveAttestedDevice(makeDevice({ revoked: false }))

    // DB call must pass boolean false, not integer 0
    expect(invoke).toHaveBeenCalledWith('db_save_device', expect.objectContaining({
      device: expect.objectContaining({ revoked: false }),
    }))
    // Reactive state also stores boolean false
    expect(store.peerDevices['user-alice']?.[0]?.revoked).toBe(false)
  })

  it('receiveAttestedDevice adds device to peerDevices reactive state', async () => {
    const { invoke } = await import('@tauri-apps/api/core')
    vi.mocked(invoke).mockResolvedValue(undefined)

    const { useDevicesStore } = await import('@/stores/devicesStore')
    const store = useDevicesStore()

    await store.receiveAttestedDevice(makeDevice())

    expect(store.peerDevices['user-alice']).toHaveLength(1)
    expect(store.peerDevices['user-alice'][0].deviceId).toBe('dev-1')
  })

  it('receiveAttestedDevice updates existing entry rather than duplicating', async () => {
    const { invoke } = await import('@tauri-apps/api/core')
    vi.mocked(invoke).mockResolvedValue(undefined)

    const { useDevicesStore } = await import('@/stores/devicesStore')
    const store = useDevicesStore()

    await store.receiveAttestedDevice(makeDevice({ publicSignKey: 'spk-v1' }))
    await store.receiveAttestedDevice(makeDevice({ publicSignKey: 'spk-v2' }))

    expect(store.peerDevices['user-alice']).toHaveLength(1)
    expect(store.peerDevices['user-alice'][0].publicSignKey).toBe('spk-v2')
  })

  // ── revokeDevice ──────────────────────────────────────────────────────────

  it('revokeDevice calls db_revoke_device and sets revoked = true in reactive state', async () => {
    const { invoke } = await import('@tauri-apps/api/core')
    vi.mocked(invoke).mockResolvedValue(undefined)

    const { useDevicesStore } = await import('@/stores/devicesStore')
    const store = useDevicesStore()

    // Seed a live device first
    await store.receiveAttestedDevice(makeDevice({ revoked: false }))

    vi.mocked(invoke).mockClear()
    vi.mocked(invoke).mockResolvedValue(undefined)

    await store.revokeDevice('dev-1')

    expect(invoke).toHaveBeenCalledWith('db_revoke_device', { deviceId: 'dev-1' })
    expect(store.peerDevices['user-alice']?.[0]?.revoked).toBe(true)
  })
})
