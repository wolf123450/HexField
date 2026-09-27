/**
 * Tests for the rendezvous server client in networkStore:
 *  - session token from /auth/verify is used for /ws and as Bearer on /turn/credentials
 *  - an expired token (401) triggers one re-authentication
 *  - reconnect after "disconnected"/"error" re-authenticates with a fresh token
 *  - disconnect() stops reconnecting
 *  - peer_unavailable replies are logged and not dispatched
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

// ── Mocks ──────────────────────────────────────────────────────────────────

const invokeImpl = vi.fn()
vi.mock('@tauri-apps/api/core',  () => ({ invoke: (...args: unknown[]) => invokeImpl(...args) }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn().mockResolvedValue(() => {}) }))

vi.mock('@/services/signalingService', () => ({
  signalingService: {
    init:       vi.fn().mockResolvedValue(undefined),
    connect:    vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    send:       vi.fn().mockResolvedValue(undefined),
  },
}))

vi.mock('@/services/webrtcService', () => ({
  WebRTCService: { isAvailable: vi.fn().mockReturnValue(true) },
  webrtcService: {
    init:           vi.fn(),
    destroyAll:     vi.fn(),
    destroyPeer:    vi.fn(),
    setIceServers:  vi.fn().mockResolvedValue(undefined),
    sendToPeer:     vi.fn().mockReturnValue(true),
    handleOffer:    vi.fn().mockResolvedValue(undefined),
  },
}))

vi.mock('@/services/syncService', () => ({
  startSync:         vi.fn().mockResolvedValue(undefined),
  handleSyncMessage: vi.fn(),
  setSendFn:         vi.fn(),
}))

vi.mock('@/services/attachmentService', () => ({ setRequestChunksFn: vi.fn() }))

vi.mock('@/services/cryptoService', () => ({
  cryptoService: {
    sign:                vi.fn().mockReturnValue('sig'),
    signJson:            vi.fn((p: unknown) => p),
    verifyJsonSignature: vi.fn().mockReturnValue('pk'),
  },
}))

vi.mock('@/stores/identityStore', () => ({
  useIdentityStore: () => ({
    userId: 'user-alice', displayName: 'Alice', publicSignKey: 'pk-sign', publicDHKey: 'pk-dh',
  }),
}))

vi.mock('@/utils/natDetection', () => ({
  detectNATType: vi.fn().mockResolvedValue('open'),
  querySTUN:     vi.fn().mockResolvedValue(null),
}))

// ── fetch stub ─────────────────────────────────────────────────────────────

let verifyCount = 0
let turnStatuses: number[] = []
const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
  const json = (status: number, body: unknown) =>
    ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response
  if (url.endsWith('/auth/challenge')) return json(200, { challenge: 'nonce' })
  if (url.endsWith('/auth/verify')) return json(200, { token: `tok-${++verifyCount}` })
  if (url.endsWith('/turn/credentials')) {
    const status = turnStatuses.shift() ?? 200
    return json(status, { urls: ['turn:t.example:3478'], username: 'u', credential: 'c', ttl: 3600 })
  }
  return json(404, {})
})

function callsTo(path: string) {
  return fetchMock.mock.calls.filter(([url]) => url.endsWith(path))
}

async function setupStore() {
  const { useSettingsStore } = await import('@/stores/settingsStore')
  useSettingsStore().settings.rendezvousServerUrl = 'https://rdv.example'
  const { useNetworkStore } = await import('@/stores/networkStore')
  const store = useNetworkStore()
  await store.init('user-alice')
  // init() auto-connects in the background; wait until TURN was fetched.
  await vi.waitFor(() => expect(callsTo('/turn/credentials').length).toBeGreaterThan(0))
  const { signalingService } = await import('@/services/signalingService')
  const [onMessage, onState] = vi.mocked(signalingService.init).mock.calls[0] as unknown as [
    (p: Record<string, unknown>) => void, (s: string) => void,
  ]
  return { store, onMessage, onState, signalingService }
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('networkStore rendezvous client', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    vi.stubGlobal('fetch', fetchMock)
    invokeImpl.mockResolvedValue(undefined)
    verifyCount = 0
    turnStatuses = []
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('connects /ws with the session token and sends it as Bearer for TURN', async () => {
    const { store, signalingService } = await setupStore()

    expect(store.getRendezvousToken()).toBe('tok-1')
    expect(signalingService.connect).toHaveBeenCalledWith('wss://rdv.example/ws?token=tok-1')

    const [turnCall] = callsTo('/turn/credentials')
    const headers = (turnCall[1] as RequestInit).headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer tok-1')
  })

  it('re-authenticates once when TURN credentials return 401', async () => {
    turnStatuses = [401, 200]
    await setupStore()
    await vi.waitFor(() => expect(callsTo('/turn/credentials')).toHaveLength(2))

    const turnCalls = callsTo('/turn/credentials')
    expect(turnCalls).toHaveLength(2)
    expect(((turnCalls[1][1] as RequestInit).headers as Record<string, string>).Authorization).toBe('Bearer tok-2')
    expect(callsTo('/auth/verify')).toHaveLength(2)
  })

  it('reconnects after "disconnected" with a fresh token', async () => {
    const { onState, signalingService } = await setupStore()
    vi.mocked(signalingService.connect).mockClear()

    onState('disconnected')

    // First backoff step is 1 s.
    await vi.waitFor(
      () => expect(signalingService.connect).toHaveBeenCalledWith('wss://rdv.example/ws?token=tok-2'),
      { timeout: 3000 },
    )
    expect(callsTo('/auth/verify')).toHaveLength(2)
  })

  it('also reconnects after "error" (e.g. rejected upgrade)', async () => {
    const { onState, signalingService } = await setupStore()
    vi.mocked(signalingService.connect).mockClear()

    onState('error')

    await vi.waitFor(() => expect(signalingService.connect).toHaveBeenCalledTimes(1), { timeout: 3000 })
  })

  it('retries through the backoff when the server is unreachable at launch', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'))
    const { useSettingsStore } = await import('@/stores/settingsStore')
    useSettingsStore().settings.rendezvousServerUrl = 'https://rdv.example'
    const { useNetworkStore } = await import('@/stores/networkStore')
    await useNetworkStore().init('user-alice')
    const { signalingService } = await import('@/services/signalingService')

    await vi.waitFor(
      () => expect(signalingService.connect).toHaveBeenCalledWith('wss://rdv.example/ws?token=tok-1'),
      { timeout: 3000 },
    )
  })

  it('does not reconnect after disconnect()', async () => {
    const { store, onState, signalingService } = await setupStore()
    vi.mocked(signalingService.connect).mockClear()

    await store.disconnect()
    onState('disconnected')
    await new Promise(r => setTimeout(r, 1500))

    expect(signalingService.connect).not.toHaveBeenCalled()
    expect(store.getRendezvousToken()).toBeNull()
  })

  it('logs peer_unavailable and does not dispatch it', async () => {
    const { logger } = await import('@/utils/logger')
    const infoSpy = vi.spyOn(logger, 'info')
    const { onMessage } = await setupStore()
    const { webrtcService } = await import('@/services/webrtcService')

    onMessage({ type: 'peer_unavailable', to: 'user-bob' })

    expect(infoSpy).toHaveBeenCalledWith('network', expect.stringContaining('peer unavailable'), 'user-bob')
    expect(webrtcService.handleOffer).not.toHaveBeenCalled()
  })
})
