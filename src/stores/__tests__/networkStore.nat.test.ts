/**
 * Tests for the NAT-relay-related behaviour of networkStore:
 *  - buildICEConfig includes relay TURN candidates when natType is symmetric
 *  - buildICEConfig omits relay TURN candidates when natType is open
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

vi.mock('@/services/webrtcService', () => {
  let _builder: ((userId: string) => RTCIceServer[]) | null = null
  return {
    WebRTCService: {
      isAvailable: vi.fn().mockReturnValue(true),
    },
    webrtcService: {
      init:                vi.fn(),
      destroyAll:          vi.fn(),
      destroyPeer:         vi.fn(),
      setICEConfigBuilder: vi.fn().mockImplementation((fn: (u: string) => RTCIceServer[]) => { _builder = fn }),
      getICEConfigBuilder: () => _builder,  // test helper
      sendToPeer:          vi.fn().mockReturnValue(true),
    },
  }
})

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

describe('buildICEConfig', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  it('always includes public STUN servers', async () => {
    const { webrtcService } = await import('@/services/webrtcService')
    await setupStore('open')
    const builder = (webrtcService as any).getICEConfigBuilder()
    expect(builder).not.toBeNull()
    const servers: RTCIceServer[] = builder('peer-bob')
    const stunUrls = servers.flatMap(s => (Array.isArray(s.urls) ? s.urls : [s.urls]))
    expect(stunUrls.some(u => u.startsWith('stun:'))).toBe(true)
  })

  it('does NOT add relay TURN entries when natType is open', async () => {
    const { webrtcService } = await import('@/services/webrtcService')
    const store = await setupStore('open')
    // Inject a relay-capable peer
    store.relayCapablePeers['peer-charlie'] = '203.0.113.1:3479'

    const builder = (webrtcService as any).getICEConfigBuilder()
    const servers: RTCIceServer[] = builder('peer-bob')
    const turnUrls = servers
      .flatMap(s => (Array.isArray(s.urls) ? s.urls : [s.urls]))
      .filter(u => u.startsWith('turn:'))
    // No relay TURN entries — open NAT doesn't need them
    expect(turnUrls).toHaveLength(0)
  })

  it('includes relay TURN entries when natType is symmetric', async () => {
    const { webrtcService } = await import('@/services/webrtcService')
    const store = await setupStore('symmetric')
    store.relayCapablePeers['peer-charlie'] = '203.0.113.1:3479'

    const builder = (webrtcService as any).getICEConfigBuilder()
    const servers: RTCIceServer[] = builder('peer-bob')
    const turnEntries = servers.filter(s => {
      const urls = Array.isArray(s.urls) ? s.urls : [s.urls]
      return urls.some(u => u.startsWith('turn:'))
    })
    expect(turnEntries.length).toBeGreaterThan(0)
    expect(turnEntries[0].urls).toContain('203.0.113.1:3479')
  })

  it('includes relay TURN entries when natType is unknown', async () => {
    const { webrtcService } = await import('@/services/webrtcService')
    const store = await setupStore('unknown')
    store.relayCapablePeers['peer-dave'] = '198.51.100.2:3479'

    const builder = (webrtcService as any).getICEConfigBuilder()
    const servers: RTCIceServer[] = builder('peer-bob')
    const hasTURN = servers.some(s => {
      const urls = Array.isArray(s.urls) ? s.urls : [s.urls]
      return urls.some(u => u.startsWith('turn:'))
    })
    expect(hasTURN).toBe(true)
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
