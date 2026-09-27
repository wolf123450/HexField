/**
 * Tests for the NAT-relay-related behaviour of networkStore:
 *  - ICE servers (STUN + custom TURN) are pushed to Rust on init and on settings change
 *  - relay-capable peers are not pushed as TURN servers (no peer TURN listener yet)
 *  - presence_update gossip includes relayCapable + relayAddr when relay-capable
 *  - relay peer advertisement is tracked in relayCapablePeers
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

// ── Mocks ──────────────────────────────────────────────────────────────────

vi.mock('@tauri-apps/api/core',  () => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn().mockResolvedValue(() => {}) }))

vi.mock('@/services/signalingService', () => ({
  signalingService: { init: vi.fn().mockResolvedValue(undefined), connect: vi.fn(), disconnect: vi.fn(), send: vi.fn() },
}))

vi.mock('@/services/webrtcService', () => ({
  WebRTCService: {
    isAvailable: vi.fn().mockReturnValue(true),
  },
  webrtcService: {
    init:          vi.fn(),
    destroyAll:    vi.fn(),
    destroyPeer:   vi.fn(),
    setIceServers: vi.fn().mockResolvedValue(undefined),
    sendToPeer:    vi.fn().mockReturnValue(true),
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
  querySTUN:     vi.fn().mockResolvedValue({ ip: '1.2.3.4', port: 12345 }),
}))

// ── Helpers ────────────────────────────────────────────────────────────────

async function setupStore(natTypeOverride: 'open' | 'restricted' | 'symmetric' | 'unknown' | 'pending' = 'open') {
  const { detectNATType } = await import('@/utils/natDetection')
  vi.mocked(detectNATType).mockResolvedValue(natTypeOverride)

  const { useNetworkStore } = await import('@/stores/networkStore')
  const store = useNetworkStore()
  await store.init('user-alice')
  // Let the detectNATType promise settle
  await new Promise(r => setTimeout(r, 10))
  return store
}

// ── Tests ──────────────────────────────────────────────────────────────────

/** URLs from the most recent ICE server list pushed to Rust. */
async function lastPushedUrls(): Promise<string[]> {
  const { webrtcService } = await import('@/services/webrtcService')
  const calls = vi.mocked(webrtcService.setIceServers).mock.calls
  // The first push waits on a dynamic import of settingsStore.
  await vi.waitFor(() => expect(calls.length).toBeGreaterThan(0))
  const servers = calls[calls.length - 1][0]
  return servers.flatMap(s => (Array.isArray(s.urls) ? s.urls : [s.urls]))
}

describe('ICE servers pushed to Rust', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  it('pushes public STUN servers on init', async () => {
    await setupStore('open')
    const urls = await lastPushedUrls()
    expect(urls.filter(u => u.startsWith('stun:'))).toHaveLength(2)
  })

  it('never includes relay-capable peers (no peer TURN listener exists yet)', async () => {
    const store = await setupStore('symmetric')
    store.relayCapablePeers['peer-charlie'] = '203.0.113.1:3479'
    const { useSettingsStore } = await import('@/stores/settingsStore')
    // Trigger a re-push so relayCapablePeers is in state when the list is built.
    useSettingsStore().settings.customTURNServers = []
    await new Promise(r => setTimeout(r, 5))

    const urls = await lastPushedUrls()
    expect(urls.some(u => u.includes('203.0.113.1:3479'))).toBe(false)
  })

  it('re-pushes when custom TURN servers change in settings', async () => {
    await setupStore('open')
    const { useSettingsStore } = await import('@/stores/settingsStore')
    useSettingsStore().settings.customTURNServers = [
      { urls: 'turn:turn.example.org:3478', username: 'u', credential: 'p' },
    ]
    await new Promise(r => setTimeout(r, 5))

    const urls = await lastPushedUrls()
    expect(urls).toContain('turn:turn.example.org:3478')
  })
})

describe('relay peer advertisement', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  it('handlePresenceUpdate stores relay addr when relayCapable is true', async () => {
    const store = await setupStore('symmetric')
    // Simulate receiving a presence_update from a relay-capable peer
    // by broadcasting to ourselves via the data-message handler path.
    // We test the store's internal state directly.
    // Access private handler via the broadcast mechanism:
    const { webrtcService } = await import('@/services/webrtcService')
    const initCall = vi.mocked(webrtcService.init).mock.calls[0]
    const onDataMsg = initCall?.[1] as ((userId: string, data: unknown) => void) | undefined
    expect(onDataMsg).toBeTruthy()

    onDataMsg!('peer-relay', {
      type:         'presence_update',
      userId:       'peer-relay',
      status:       'online',
      timestamp:    Date.now(),
      relayCapable: true,
      relayAddr:    '10.0.0.1:3479',
    })
    // Allow any async operations to flush
    await new Promise(r => setTimeout(r, 5))
    expect(store.relayCapablePeers['peer-relay']).toBe('10.0.0.1:3479')
  })

  it('handlePresenceUpdate removes relay record when peer goes offline', async () => {
    const store = await setupStore('symmetric')
    store.relayCapablePeers['peer-relay'] = '10.0.0.1:3479'

    const { webrtcService } = await import('@/services/webrtcService')
    const initCall  = vi.mocked(webrtcService.init).mock.calls[0]
    const onDataMsg = initCall?.[1] as ((userId: string, data: unknown) => void) | undefined
    onDataMsg!('peer-relay', { type: 'presence_update', userId: 'peer-relay', status: 'offline', timestamp: Date.now() })
    await new Promise(r => setTimeout(r, 5))

    expect(store.relayCapablePeers['peer-relay']).toBeUndefined()
  })

  it('gossipOwnPresence includes relayCapable and relayAddr when NAT is open', async () => {
    await setupStore('open')
    // Let the querySTUN promise settle too
    await new Promise(r => setTimeout(r, 10))

    const { webrtcService } = await import('@/services/webrtcService')
    const initCall      = vi.mocked(webrtcService.init).mock.calls[0]
    const onConnected   = initCall?.[2] as ((userId: string) => void) | undefined
    // Trigger peer-connected callback (which calls gossipOwnPresence)
    vi.mocked(webrtcService.sendToPeer).mockClear()
    onConnected?.('peer-bob')
    await new Promise(r => setTimeout(r, 20))

    const calls = vi.mocked(webrtcService.sendToPeer).mock.calls
    const presenceCall = calls.find(([_peer, msg]) => (msg as any)?.type === 'presence_update')
    expect(presenceCall).toBeTruthy()
    const presenceMsg = presenceCall![1] as Record<string, unknown>
    expect(presenceMsg.relayCapable).toBe(true)
    expect(typeof presenceMsg.relayAddr).toBe('string')
  })
})
