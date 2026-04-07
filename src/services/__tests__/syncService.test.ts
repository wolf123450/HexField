/**
 * Unit tests for syncService.ts
 *
 * The service owns the P2P negentropy sync protocol — initiator and responder
 * sides, push/want content exchange. It relies on Tauri `invoke` for Rust-side
 * negentropy computation; all invoke calls are mocked here.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Mocks ──────────────────────────────────────────────────────────────────────

const mockInvoke = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({ invoke: mockInvoke }))

const mockLoadMessages           = vi.fn().mockResolvedValue(undefined)
const mockLoadMutationsForChannel = vi.fn().mockResolvedValue(undefined)
vi.mock('@/stores/messagesStore', () => ({
  useMessagesStore: () => ({
    loadMessages:               mockLoadMessages,
    loadMutationsForChannel:    mockLoadMutationsForChannel,
  }),
}))

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeMessageRow(id: string) {
  return {
    id,
    channel_id:      'chan-1',
    server_id:       'srv-1',
    author_id:       'user-a',
    content:         'hello',
    content_type:    'text',
    reply_to_id:     null,
    created_at:      '2025-01-01T00:00:00Z',
    logical_ts:      '1000000-000001',
    verified:        true,
    raw_attachments: null,
  }
}

function makeMutationRow(id: string) {
  return {
    id,
    type:         'reaction_add',
    target_id:    'msg-1',
    channel_id:   'chan-1',
    author_id:    'user-a',
    new_content:  null,
    emoji_id:     '👍',
    created_at:   '2025-01-01T00:00:00Z',
    logical_ts:   '1000000-000002',
    verified:     true,
  }
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('syncService.startSync', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('sends sync_neg_init for each channel × table plus server-level mutations', async () => {
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'sync_list_channels') return ['chan-1', 'chan-2']
      if (cmd === 'sync_initiate')      return 'base64-neg-msg'
      return null
    })

    const { setSendFn, startSync } = await import('@/services/syncService')
    const sendFn = vi.fn()
    setSendFn(sendFn)

    await startSync('peer-bob')

    // 2 channels × 2 tables + 1 server-level mutations pass = 5 sessions
    const negInits = sendFn.mock.calls.filter((c) => c[1]?.type === 'sync_neg_init')
    expect(negInits).toHaveLength(5)
    expect(negInits[0][0]).toBe('peer-bob')
    expect(negInits[0][1]).toMatchObject({ type: 'sync_neg_init', channelId: 'chan-1', table: 'messages' })
    expect(negInits[1][1]).toMatchObject({ type: 'sync_neg_init', channelId: 'chan-1', table: 'mutations' })
    expect(negInits[2][1]).toMatchObject({ type: 'sync_neg_init', channelId: 'chan-2', table: 'messages' })
    expect(negInits[4][1]).toMatchObject({ type: 'sync_neg_init', channelId: '__server__', table: 'mutations' })
  })

  it('does not throw when sync_list_channels returns empty list', async () => {
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'sync_list_channels') return []
      return null
    })

    const { setSendFn, startSync } = await import('@/services/syncService')
    setSendFn(vi.fn())
    await expect(startSync('peer-bob')).resolves.not.toThrow()
  })

  it('does not throw when invoke rejects', async () => {
    mockInvoke.mockRejectedValue(new Error('Tauri error'))

    const { setSendFn, startSync } = await import('@/services/syncService')
    setSendFn(vi.fn())
    await expect(startSync('peer-bob')).resolves.not.toThrow()
  })
})

// ── Responder path ─────────────────────────────────────────────────────────────

describe('syncService.handleSyncMessage — sync_neg_init (responder)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('calls sync_respond and sends sync_neg_reply back', async () => {
    mockInvoke.mockResolvedValue('reply-base64')

    const { setSendFn, handleSyncMessage } = await import('@/services/syncService')
    const sendFn = vi.fn()
    setSendFn(sendFn)

    await handleSyncMessage('peer-alice', {
      type:      'sync_neg_init',
      sessionId: 'sess-1',
      channelId: 'chan-1',
      table:     'messages',
      msg:       'init-base64',
    })

    expect(mockInvoke).toHaveBeenCalledWith('sync_respond', {
      channelId: 'chan-1',
      table:     'messages',
      msg:       'init-base64',
    })
    expect(sendFn).toHaveBeenCalledWith(
      'peer-alice',
      expect.objectContaining({ type: 'sync_neg_reply', sessionId: 'sess-1', msg: 'reply-base64' }),
    )
  })

  it('does not throw when sync_respond rejects', async () => {
    mockInvoke.mockRejectedValue(new Error('backend unavailable'))

    const { setSendFn, handleSyncMessage } = await import('@/services/syncService')
    setSendFn(vi.fn())

    await expect(
      handleSyncMessage('peer-alice', {
        type: 'sync_neg_init', sessionId: 's', channelId: 'c', table: 'messages', msg: 'm',
      }),
    ).resolves.not.toThrow()
  })
})

// ── Initiator path: handle reply ───────────────────────────────────────────────

describe('syncService.handleSyncMessage — sync_neg_reply (initiator)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('pushes items the peer needs and requests items we need', async () => {
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'sync_list_channels') return ['chan-1']
      if (cmd === 'sync_initiate')      return 'neg-msg'
      if (cmd === 'sync_process_response') return { have_ids: ['msg-a'], need_ids: ['msg-b'] }
      if (cmd === 'sync_get_messages')  return [makeMessageRow('msg-a')]
      return null
    })

    const { setSendFn, startSync, handleSyncMessage } = await import('@/services/syncService')
    const sendFn = vi.fn()
    setSendFn(sendFn)

    // Trigger startSync so that a pending session is registered
    await startSync('peer-bob')
    // Capture the sessionId from the first sync_neg_init
    const initCall = sendFn.mock.calls.find((c) => c[1]?.type === 'sync_neg_init')
    expect(initCall).toBeDefined()
    const sessionId = initCall![1].sessionId as string

    sendFn.mockClear()
    mockInvoke.mockClear()
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'sync_process_response') return { have_ids: ['msg-a'], need_ids: ['msg-b'] }
      if (cmd === 'sync_get_messages')     return [makeMessageRow('msg-a')]
      return null
    })

    await handleSyncMessage('peer-bob', {
      type:      'sync_neg_reply',
      sessionId,
      msg:       'reply-msg',
    })

    // Should push content (sync_push with messages for msg-a)
    const pushCall = sendFn.mock.calls.find((c) => c[1]?.type === 'sync_push')
    expect(pushCall).toBeDefined()
    expect(pushCall![1]).toMatchObject({ type: 'sync_push', table: 'messages', channelId: 'chan-1' })

    // Should send a want request for msg-b
    const wantCall = sendFn.mock.calls.find((c) => c[1]?.type === 'sync_want')
    expect(wantCall).toBeDefined()
    expect(wantCall![1]).toMatchObject({ type: 'sync_want', ids: ['msg-b'] })
  })

  it('ignores sync_neg_reply for unknown sessionId without throwing', async () => {
    const { setSendFn, handleSyncMessage } = await import('@/services/syncService')
    setSendFn(vi.fn())

    await expect(
      handleSyncMessage('peer-bob', { type: 'sync_neg_reply', sessionId: 'unknown-session', msg: 'm' }),
    ).resolves.not.toThrow()
    expect(mockInvoke).not.toHaveBeenCalled()
  })
})

// ── Push path (receive content from peer) ──────────────────────────────────────

describe('syncService.handleSyncMessage — sync_push', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('saves received messages and triggers loadMessages', async () => {
    mockInvoke.mockResolvedValue(undefined)

    const { setSendFn, handleSyncMessage } = await import('@/services/syncService')
    setSendFn(vi.fn())

    const messages = [makeMessageRow('msg-x')]
    await handleSyncMessage('peer-alice', {
      type:      'sync_push',
      sessionId: 'sess-3',
      table:     'messages',
      channelId: 'chan-1',
      messages,
    })

    expect(mockInvoke).toHaveBeenCalledWith('sync_save_messages', { messages })
    expect(mockLoadMessages).toHaveBeenCalledWith('chan-1')
  })

  it('saves received mutations and triggers loadMutationsForChannel', async () => {
    mockInvoke.mockResolvedValue(undefined)

    const { setSendFn, handleSyncMessage } = await import('@/services/syncService')
    setSendFn(vi.fn())

    const mutations = [makeMutationRow('mut-x')]
    await handleSyncMessage('peer-alice', {
      type:      'sync_push',
      sessionId: 'sess-4',
      table:     'mutations',
      channelId: 'chan-1',
      mutations,
    })

    expect(mockInvoke).toHaveBeenCalledWith('sync_save_mutations', { mutations })
    expect(mockLoadMutationsForChannel).toHaveBeenCalledWith('chan-1')
  })

  it('does NOT call loadMutationsForChannel for server-level mutations', async () => {
    mockInvoke.mockResolvedValue(undefined)

    const { setSendFn, handleSyncMessage } = await import('@/services/syncService')
    setSendFn(vi.fn())

    await handleSyncMessage('peer-alice', {
      type:      'sync_push',
      sessionId: 'sess-5',
      table:     'mutations',
      channelId: '__server__',
      mutations: [makeMutationRow('mut-s')],
    })

    expect(mockLoadMutationsForChannel).not.toHaveBeenCalled()
  })

  it('does not call invoke when messages list is empty', async () => {
    const { setSendFn, handleSyncMessage } = await import('@/services/syncService')
    setSendFn(vi.fn())

    await handleSyncMessage('peer-alice', {
      type: 'sync_push', sessionId: 's', table: 'messages', channelId: 'c', messages: [],
    })

    expect(mockInvoke).not.toHaveBeenCalled()
  })
})

// ── Want path (peer requests content we have) ──────────────────────────────────

describe('syncService.handleSyncMessage — sync_want', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('fetches requested messages and sends sync_push', async () => {
    const messages = [makeMessageRow('msg-y')]
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'sync_get_messages') return messages
      return null
    })

    const { setSendFn, handleSyncMessage } = await import('@/services/syncService')
    const sendFn = vi.fn()
    setSendFn(sendFn)

    await handleSyncMessage('peer-alice', {
      type:      'sync_want',
      sessionId: 'sess-6',
      table:     'messages',
      channelId: 'chan-1',
      ids:       ['msg-y'],
    })

    expect(mockInvoke).toHaveBeenCalledWith('sync_get_messages', { ids: ['msg-y'] })
    expect(sendFn).toHaveBeenCalledWith(
      'peer-alice',
      expect.objectContaining({ type: 'sync_push', table: 'messages', channelId: 'chan-1', messages }),
    )
  })

  it('fetches requested mutations and sends sync_push', async () => {
    const mutations = [makeMutationRow('mut-y')]
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'sync_get_mutations') return mutations
      return null
    })

    const { setSendFn, handleSyncMessage } = await import('@/services/syncService')
    const sendFn = vi.fn()
    setSendFn(sendFn)

    await handleSyncMessage('peer-alice', {
      type:      'sync_want',
      sessionId: 'sess-7',
      table:     'mutations',
      channelId: 'chan-1',
      ids:       ['mut-y'],
    })

    expect(mockInvoke).toHaveBeenCalledWith('sync_get_mutations', { ids: ['mut-y'] })
    expect(sendFn).toHaveBeenCalledWith(
      'peer-alice',
      expect.objectContaining({ type: 'sync_push', table: 'mutations', channelId: 'chan-1', mutations }),
    )
  })
})
