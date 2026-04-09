/**
 * Tests for UPnP integration in networkStore:
 *  - init() calls set_public_ip after STUN succeeds (non-symmetric NAT)
 *  - init() does NOT call set_public_ip when NAT is symmetric
 *  - disconnect() calls upnp_remove_mapping
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

// ── Mocks ──────────────────────────────────────────────────────────────────

const invokeImpl = vi.fn()
vi.mock('@tauri-apps/api/core',  () => ({ invoke: (...args: unknown[]) => invokeImpl(...args) }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn().mockResolvedValue(() => {}) }))

vi.mock('@/services/signalingService', () => ({
  signalingService: { init: vi.fn().mockResolvedValue(undefined), connect: vi.fn(), disconnect: vi.fn().mockResolvedValue(undefined), send: vi.fn() },
}))

vi.mock('@/services/webrtcService', () => ({
  WebRTCService: { isAvailable: vi.fn().mockReturnValue(true) },
  webrtcService: {
    init:                vi.fn(),
    destroyAll:          vi.fn(),
    destroyPeer:         vi.fn(),
    setICEConfigBuilder: vi.fn(),
    sendToPeer:          vi.fn().mockReturnValue(true),
  },
}))

vi.mock('@/services/syncService', () => ({
  startSync:          vi.fn().mockResolvedValue(undefined),
  handleSyncMessage:  vi.fn(),
  setSendFn:          vi.fn(),
}))

vi.mock('@/services/attachmentService', () => ({
  setRequestChunksFn: vi.fn(),
}))

vi.mock('@/stores/identityStore', () => ({
  useIdentityStore: () => ({
    userId:        'user-alice',
    displayName:   'Alice',
    publicSignKey: 'pk-sign',
    publicDHKey:   'pk-dh',
    avatarDataUrl: null,
    bio:           null,
    bannerColor:   null,
    bannerDataUrl: null,
  }),
}))

vi.mock('@/utils/natDetection', () => ({
  detectNATType: vi.fn().mockResolvedValue('open'),
  querySTUN:     vi.fn().mockResolvedValue({ ip: '203.0.113.42', port: 12345 }),
}))

// ── Helpers ────────────────────────────────────────────────────────────────

async function setupStore(natType: 'open' | 'symmetric' = 'open') {
  const { detectNATType } = await import('@/utils/natDetection')
  vi.mocked(detectNATType).mockResolvedValue(natType)

  const { useNetworkStore } = await import('@/stores/networkStore')
  const store = useNetworkStore()
  await store.init('user-alice')
  // Let the detectNATType → querySTUN → set_public_ip promise chain settle
  await new Promise(r => setTimeout(r, 50))
  return store
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('UPnP integration in networkStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    invokeImpl.mockResolvedValue(undefined)
  })

  it('calls set_public_ip with STUN-discovered IP when NAT is open', async () => {
    await setupStore('open')

    const setPublicIpCalls = invokeImpl.mock.calls.filter(
      ([cmd]: [string]) => cmd === 'set_public_ip',
    )
    expect(setPublicIpCalls).toHaveLength(1)
    expect(setPublicIpCalls[0][1]).toEqual({ ip: '203.0.113.42' })
  })

  it('does NOT call set_public_ip when NAT is symmetric', async () => {
    await setupStore('symmetric')

    const setPublicIpCalls = invokeImpl.mock.calls.filter(
      ([cmd]: [string]) => cmd === 'set_public_ip',
    )
    expect(setPublicIpCalls).toHaveLength(0)
  })

  it('calls upnp_remove_mapping on disconnect', async () => {
    const store = await setupStore('open')
    invokeImpl.mockClear()

    await store.disconnect()

    const removeCalls = invokeImpl.mock.calls.filter(
      ([cmd]: [string]) => cmd === 'upnp_remove_mapping',
    )
    expect(removeCalls).toHaveLength(1)
  })

  it('disconnect succeeds even if upnp_remove_mapping rejects', async () => {
    const store = await setupStore('open')
    invokeImpl.mockImplementation((cmd: string) => {
      if (cmd === 'upnp_remove_mapping') return Promise.reject('no mapping')
      return Promise.resolve(undefined)
    })

    // Should not throw
    await store.disconnect()
  })
})
