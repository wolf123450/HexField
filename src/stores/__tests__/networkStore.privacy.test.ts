/**
 * Server-scoped delivery in networkStore: chat traffic and chat attachment
 * requests reach only connected peers that are members of the server.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

vi.mock('@tauri-apps/api/core',  () => ({ invoke: vi.fn().mockResolvedValue(true) }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn().mockResolvedValue(() => {}) }))

vi.mock('@/services/signalingService', () => ({
  signalingService: { init: vi.fn(), connect: vi.fn(), disconnect: vi.fn(), send: vi.fn() },
}))

vi.mock('@/services/webrtcService', () => ({
  WebRTCService: { isAvailable: vi.fn().mockReturnValue(true) },
  webrtcService: {
    sendToPeer:     vi.fn().mockReturnValue(true),
    broadcast:      vi.fn(),
    broadcastWhere: vi.fn(),
  },
}))

vi.mock('@/services/syncService', () => ({
  startSync: vi.fn(), handleSyncMessage: vi.fn(), setSendFn: vi.fn(),
}))

vi.mock('@/services/attachmentService', () => ({
  setRequestChunksFn: vi.fn(), addSeeder: vi.fn(), readChunkForSeeding: vi.fn(), receiveChunk: vi.fn(),
}))

const serversMock = vi.hoisted(() => {
  const mock = {
    members: {} as Record<string, Record<string, unknown>>,
    fetchMembers: vi.fn(),
    // Same contract as serversStore.ensureMembers: load on first use
    ensureMembers: async (id: string) => {
      if (!mock.members[id]) await mock.fetchMembers(id)
      return mock.members[id] ?? {}
    },
  }
  return mock
})
vi.mock('@/stores/serversStore', () => ({ useServersStore: () => serversMock }))

const messagesMock = vi.hoisted(() => ({ messages: {} as Record<string, Array<{ id: string; serverId: string }>> }))
vi.mock('@/stores/messagesStore', () => ({ useMessagesStore: () => messagesMock }))

const flush = () => new Promise(r => setTimeout(r, 5))

async function setup() {
  const { useNetworkStore } = await import('@/stores/networkStore')
  const { webrtcService } = await import('@/services/webrtcService')
  return { store: useNetworkStore(), webrtcService }
}

describe('networkStore server-scoped delivery', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    serversMock.members = {
      'srv-1': { 'user-bob': {}, 'user-alice': {} },
    }
    serversMock.fetchMembers.mockImplementation(async (id: string) => {
      serversMock.members[id] = { 'user-dave': {} }
    })
    messagesMock.messages = { 'ch-1': [{ id: 'msg-1', serverId: 'srv-1' }] }
  })

  it('broadcastToServer sends only to members of that server', async () => {
    const { store, webrtcService } = await setup()
    await store.broadcastToServer('srv-1', { type: 'chat_message' })

    expect(webrtcService.broadcast).not.toHaveBeenCalled()
    const [include, data] = vi.mocked(webrtcService.broadcastWhere).mock.calls[0]
    expect(data).toEqual({ type: 'chat_message' })
    expect(include('user-bob')).toBe(true)
    expect(include('user-mallory')).toBe(false)
  })

  it('broadcastToServer loads members of a server that is not loaded yet', async () => {
    const { store, webrtcService } = await setup()
    await store.broadcastToServer('srv-2', { type: 'mutation' })

    expect(serversMock.fetchMembers).toHaveBeenCalledWith('srv-2')
    const [include] = vi.mocked(webrtcService.broadcastWhere).mock.calls[0]
    expect(include('user-dave')).toBe(true)
    expect(include('user-bob')).toBe(false)
  })

  it('a chat attachment request goes only to members of the message\'s server', async () => {
    const { store, webrtcService } = await setup()
    store.broadcastAttachmentWant('blake3:abc', 'msg-1')
    await flush()

    expect(webrtcService.broadcast).not.toHaveBeenCalled()
    const [include, data] = vi.mocked(webrtcService.broadcastWhere).mock.calls[0]
    expect(data).toEqual({ type: 'attachment_want', contentHash: 'blake3:abc', messageId: 'msg-1' })
    expect(include('user-bob')).toBe(true)
    expect(include('user-mallory')).toBe(false)
  })

  it('an attachment request for an unknown message is not sent to anyone', async () => {
    const { store, webrtcService } = await setup()
    store.broadcastAttachmentWant('blake3:abc', 'msg-unknown')
    await flush()

    expect(webrtcService.broadcast).not.toHaveBeenCalled()
    expect(webrtcService.broadcastWhere).not.toHaveBeenCalled()
  })

  it('avatar/emoji requests (no messageId) still go to every peer', async () => {
    const { store, webrtcService } = await setup()
    store.broadcastAttachmentWant('blake3:avatar', '')

    expect(webrtcService.broadcast).toHaveBeenCalledWith({ type: 'attachment_want', contentHash: 'blake3:avatar', messageId: '' })
  })
})
