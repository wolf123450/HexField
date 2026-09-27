/**
 * Relay policy in networkStore (docs/network-compatibility-plan.md, step 3c):
 *  - the connection type from `webrtc_connected` is tracked per peer
 *  - full attachments never travel over a relayed connection
 *    (no `attachment_have` to, no seeding from, no chunks served to relayed peers)
 *  - relayed peers get a slower heartbeat
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

vi.mock('@tauri-apps/api/core',  () => ({ invoke: vi.fn().mockResolvedValue(true) }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn().mockResolvedValue(() => {}) }))

vi.mock('@/services/signalingService', () => ({
  signalingService: { init: vi.fn().mockResolvedValue(undefined), connect: vi.fn(), disconnect: vi.fn(), send: vi.fn() },
}))

vi.mock('@/services/webrtcService', () => ({
  WebRTCService: { isAvailable: vi.fn().mockReturnValue(true) },
  webrtcService: {
    init:          vi.fn(),
    destroyAll:    vi.fn(),
    destroyPeer:   vi.fn(),
    setIceServers: vi.fn().mockResolvedValue(undefined),
    sendToPeer:    vi.fn().mockReturnValue(true),
    broadcast:     vi.fn(),
  },
}))

vi.mock('@/services/syncService', () => ({
  startSync:         vi.fn().mockResolvedValue(undefined),
  handleSyncMessage: vi.fn(),
  setSendFn:         vi.fn(),
}))

vi.mock('@/services/attachmentService', () => ({
  setRequestChunksFn:  vi.fn(),
  addSeeder:           vi.fn(),
  readChunkForSeeding: vi.fn().mockResolvedValue([1, 2, 3]),
  receiveChunk:        vi.fn(),
}))

vi.mock('@/stores/identityStore', () => ({
  useIdentityStore: () => ({
    userId: 'user-alice', displayName: 'Alice', publicSignKey: 'pk-sign', publicDHKey: 'pk-dh',
    avatarDataUrl: null, bio: null, bannerColor: null, bannerDataUrl: null,
  }),
}))

vi.mock('@/utils/natDetection', () => ({
  detectNATType: vi.fn().mockResolvedValue('open'),
  querySTUN:     vi.fn().mockResolvedValue(null),
}))

type OnConnected = (userId: string, connectionType: 'lan' | 'direct' | 'relay' | null) => void
type OnData = (userId: string, data: unknown) => void

async function setup() {
  const { useNetworkStore } = await import('@/stores/networkStore')
  const store = useNetworkStore()
  await store.init('user-alice')
  const { webrtcService } = await import('@/services/webrtcService')
  const initCall = vi.mocked(webrtcService.init).mock.calls[0]
  const onData = initCall[1] as OnData
  const onConnected = initCall[2] as OnConnected
  return { store, webrtcService, onData, onConnected }
}

const flush = () => new Promise(r => setTimeout(r, 5))

describe('relay policy', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  it('tracks the connection type per peer', async () => {
    const { store, onConnected } = await setup()
    onConnected('peer-relay', 'relay')
    onConnected('peer-direct', 'direct')
    expect(store.isRelayed('peer-relay')).toBe(true)
    expect(store.isRelayed('peer-direct')).toBe(false)
    expect(store.peerConnectionTypes['peer-direct']).toBe('direct')
  })

  it('a reconnect with a direct path clears the relayed flag', async () => {
    const { store, onConnected } = await setup()
    onConnected('peer-x', 'relay')
    onConnected('peer-x', 'direct')
    expect(store.isRelayed('peer-x')).toBe(false)
  })

  it('does not serve attachment chunks to a relayed peer', async () => {
    const { webrtcService, onData, onConnected } = await setup()
    onConnected('peer-relay', 'relay')
    vi.mocked(webrtcService.sendToPeer).mockClear()
    onData('peer-relay', { type: 'attachment_chunk_request', contentHash: 'blake3:ab', chunkIndices: [0] })
    await flush()
    const chunkSends = vi.mocked(webrtcService.sendToPeer).mock.calls
      .filter(([, msg]) => (msg as { type?: string })?.type === 'attachment_chunk')
    expect(chunkSends).toHaveLength(0)
  })

  it('serves attachment chunks to a direct peer', async () => {
    const { webrtcService, onData, onConnected } = await setup()
    onConnected('peer-direct', 'direct')
    vi.mocked(webrtcService.sendToPeer).mockClear()
    onData('peer-direct', { type: 'attachment_chunk_request', contentHash: 'blake3:ab', chunkIndices: [0] })
    await flush()
    const chunkSends = vi.mocked(webrtcService.sendToPeer).mock.calls
      .filter(([, msg]) => (msg as { type?: string })?.type === 'attachment_chunk')
    expect(chunkSends).toHaveLength(1)
  })

  it('ignores attachment_have and attachment_want from a relayed peer', async () => {
    const { webrtcService, onData, onConnected } = await setup()
    const attachmentService = await import('@/services/attachmentService')
    onConnected('peer-relay', 'relay')
    vi.mocked(webrtcService.sendToPeer).mockClear()
    onData('peer-relay', { type: 'attachment_have', contentHash: 'blake3:ab' })
    onData('peer-relay', { type: 'attachment_want', contentHash: 'blake3:ab', messageId: 'm1' })
    await flush()
    expect(attachmentService.addSeeder).not.toHaveBeenCalled()
    const haveSends = vi.mocked(webrtcService.sendToPeer).mock.calls
      .filter(([, msg]) => (msg as { type?: string })?.type === 'attachment_have')
    expect(haveSends).toHaveLength(0)
  })
})

describe('heartbeat for relayed peers', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    vi.useFakeTimers()
  })
  afterEach(() => { vi.useRealTimers() })

  it('sends presence to relayed peers every third tick only', async () => {
    const { webrtcService, onConnected } = await setup()
    onConnected('peer-relay', 'relay')
    onConnected('peer-direct', 'direct')
    // Let the on-connect presence gossip settle before counting heartbeats.
    await vi.advanceTimersByTimeAsync(1)
    vi.mocked(webrtcService.sendToPeer).mockClear()

    await vi.advanceTimersByTimeAsync(30_000) // three heartbeat ticks

    const presenceTo = (peer: string) => vi.mocked(webrtcService.sendToPeer).mock.calls
      .filter(([to, msg]) => to === peer && (msg as { type?: string })?.type === 'presence_update').length
    expect(presenceTo('peer-direct')).toBe(3)
    expect(presenceTo('peer-relay')).toBe(1)
  })
})
