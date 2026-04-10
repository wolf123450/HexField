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

const mockMembers: Record<string, Record<string, unknown>> = {}
const mockUpdateMemberProfile = vi.fn()
vi.mock('@/stores/serversStore', () => ({
  useServersStore: () => ({
    members: mockMembers,
    updateMemberProfile: mockUpdateMemberProfile,
  }),
}))

const mockApplyChannelMutation = vi.fn()
vi.mock('@/stores/channelsStore', () => ({
  useChannelsStore: () => ({
    applyChannelMutation: mockApplyChannelMutation,
  }),
}))

const mockApplyEmojiAdd    = vi.fn()
const mockApplyEmojiRemove = vi.fn()
vi.mock('@/stores/emojiStore', () => ({
  useEmojiStore: () => ({
    applyEmojiAddMutation:    mockApplyEmojiAdd,
    applyEmojiRemoveMutation: mockApplyEmojiRemove,
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

    // 1 server-level mutations + 2 channels × 2 tables = 5 sessions
    const negInits = sendFn.mock.calls.filter((c) => c[1]?.type === 'sync_neg_init')
    expect(negInits).toHaveLength(5)
    expect(negInits[0][0]).toBe('peer-bob')
    // Server-level mutations come FIRST
    expect(negInits[0][1]).toMatchObject({ type: 'sync_neg_init', channelId: '__server__', table: 'mutations' })
    expect(negInits[1][1]).toMatchObject({ type: 'sync_neg_init', channelId: 'chan-1', table: 'messages' })
    expect(negInits[2][1]).toMatchObject({ type: 'sync_neg_init', channelId: 'chan-1', table: 'mutations' })
    expect(negInits[3][1]).toMatchObject({ type: 'sync_neg_init', channelId: 'chan-2', table: 'messages' })
    expect(negInits[4][1]).toMatchObject({ type: 'sync_neg_init', channelId: 'chan-2', table: 'mutations' })
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
    // Capture the sessionId for the chan-1/messages init (not __server__/mutations which comes first)
    const initCall = sendFn.mock.calls.find(
      (c) => c[1]?.type === 'sync_neg_init' && c[1]?.channelId === 'chan-1' && c[1]?.table === 'messages',
    )
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

// ── SCTP size enforcement ──────────────────────────────────────────────────────

// The sync_push wire frame has a fixed ~160-byte envelope overhead on top of
// the serialised items.  _pushItems must account for this so the full JSON
// string passed to webrtcService.sendToPeer never exceeds SCTP_SAFE_BYTES.

const SCTP_SAFE_BYTES = 60_000   // must match the constant in syncService.ts
const SESSION_ID      = '01234567-89ab-cdef-0123-456789abcdef'
const CHANNEL_ID      = '01234567-89ab-cdef-0123-456789abcdef'

/** Returns the byte length of the full sync_push frame for a single message row. */
function envelopeLen(row: ReturnType<typeof makeMessageRow>): number {
  return JSON.stringify({
    type: 'sync_push', sessionId: SESSION_ID, table: 'messages', channelId: CHANNEL_ID,
    messages: [row],
  }).length
}

describe('syncService SCTP envelope size enforcement', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('strips inlineData from raw_attachments when item exceeds SCTP budget', async () => {
    // A message with a 100 KB image (~133 KB base64).
    // Without stripping the full envelope would be ~133 KB — well above the 65 KB SCTP limit.
    const inlineData = 'A'.repeat(133_000)
    const row = {
      ...makeMessageRow('img-msg'),
      raw_attachments: JSON.stringify([
        { id: 'att-1', name: 'photo.jpg', size: 100_000, mimeType: 'image/jpeg',
          inlineData, transferState: 'inline' },
      ]),
    }

    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'sync_get_messages') return [row]
      return null
    })

    const { setSendFn, handleSyncMessage } = await import('@/services/syncService')
    const sends: unknown[] = []
    setSendFn((_peerId, data) => sends.push(data))

    await handleSyncMessage('peer-a', {
      type: 'sync_want', sessionId: SESSION_ID, table: 'messages',
      channelId: CHANNEL_ID, ids: ['img-msg'],
    })

    // After stripping, one frame should have been sent.
    expect(sends).toHaveLength(1)
    const wireLen = JSON.stringify(sends[0]).length
    // The full wire payload must fit within SCTP_SAFE_BYTES.
    expect(wireLen).toBeLessThanOrEqual(SCTP_SAFE_BYTES)
    // The large inlineData must not appear in the wire frame.
    expect(JSON.stringify(sends[0])).not.toContain(inlineData.slice(0, 100))
  })

  it('full sync_push envelope fits within SCTP_SAFE_BYTES for items near the threshold', async () => {
    // Build a message row whose serialised form is just under SCTP_SAFE_BYTES
    // (so it is NOT stripped by the strip check), but whose full envelope—including
    // the sync_push wrapper—exceeds SCTP_SAFE_BYTES.
    // This demonstrates the envelope-overhead accounting gap.
    const base = makeMessageRow('padded-msg')
    const baseLen = JSON.stringify(base).length
    // 'hello' (5 chars) is already counted in baseLen; pad so total = SCTP_SAFE_BYTES - 1.
    const pad = 'P'.repeat(SCTP_SAFE_BYTES - 1 - baseLen + 'hello'.length)
    const row = { ...base, content: pad }

    // Confirm: item is just under the strip threshold…
    expect(JSON.stringify(row).length).toBeLessThan(SCTP_SAFE_BYTES)
    // …but its full envelope would exceed SCTP_SAFE_BYTES:
    expect(envelopeLen(row)).toBeGreaterThan(SCTP_SAFE_BYTES) // proves the bug exists pre-fix

    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'sync_get_messages') return [row]
      return null
    })

    const { setSendFn, handleSyncMessage } = await import('@/services/syncService')
    const sends: unknown[] = []
    setSendFn((_peerId, data) => sends.push(data))

    await handleSyncMessage('peer-a', {
      type: 'sync_want', sessionId: SESSION_ID, table: 'messages',
      channelId: CHANNEL_ID, ids: ['padded-msg'],
    })

    // Every payload sent must be within the SCTP budget.
    for (const payload of sends) {
      expect(JSON.stringify(payload).length).toBeLessThanOrEqual(SCTP_SAFE_BYTES)
    }
  })
})

// ── member_join persistence ────────────────────────────────────────────────────

// When B receives a member_join mutation from A via negentropy (because C joined
// while connected to A but not B), _onPush must persist C into the SQLite members
// table via db_upsert_member — not just update the in-memory serversStore.members
// map.  Without this, any fetchMembers call (startup, server switch) clears C from
// B's view and C's messages display as raw userId.

describe('syncService._onPush — member_join persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Reset the shared members map between tests
    for (const key of Object.keys(mockMembers)) delete mockMembers[key]
  })

  it('calls db_upsert_member when a member_join mutation arrives via sync_push', async () => {
    mockInvoke.mockResolvedValue(undefined)

    const { setSendFn, handleSyncMessage } = await import('@/services/syncService')
    setSendFn(vi.fn())

    const payload = {
      userId:        'user-c',
      serverId:      'srv-1',
      displayName:   'Charlie',
      publicSignKey: 'sign-key-charlie',
      publicDHKey:   'dh-key-charlie',
      roles:         ['member'],
      joinedAt:      '2025-06-01T00:00:00.000Z',
    }

    await handleSyncMessage('peer-a', {
      type:      'sync_push',
      sessionId: 'sess-member',
      table:     'mutations',
      channelId: '__server__',
      mutations: [{
        id:          'mut-join-c',
        type:        'member_join',
        target_id:   'user-c',
        channel_id:  '__server__',
        author_id:   'user-c',
        new_content: JSON.stringify(payload),
        emoji_id:    null,
        created_at:  '2025-06-01T00:00:00.000Z',
        logical_ts:  '1750000000000-000001',
        verified:    true,
      }],
    })

    // The member MUST be persisted to the SQLite members table so that
    // fetchMembers (on startup or server switch) can reload C.
    expect(mockInvoke).toHaveBeenCalledWith('db_upsert_member', {
      member: expect.objectContaining({
        user_id:      'user-c',
        server_id:    'srv-1',
        display_name: 'Charlie',
        public_sign_key: 'sign-key-charlie',
        public_dh_key:   'dh-key-charlie',
      }),
    })
  })
})
