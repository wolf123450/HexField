import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { Message, Mutation } from '@/types/core'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))

// Mock stores and crypto used inside sendMessage dynamic imports
vi.mock('@/stores/identityStore', () => ({
  useIdentityStore: () => ({
    userId:        'user-alice',
    publicDHKey:   'pub-dh-alice',
    displayName:   'Alice',
    isRegistered:  true,
  }),
}))
vi.mock('@/stores/serversStore', () => ({
  useServersStore: () => ({ members: {} }),
}))
vi.mock('@/stores/devicesStore', () => ({
  useDevicesStore: () => ({ getActiveDevices: () => [], deviceDHKey: null }),
}))
vi.mock('@/stores/networkStore', () => ({
  useNetworkStore: () => ({ broadcast: vi.fn() }),
}))
vi.mock('@/services/cryptoService', () => ({
  cryptoService: {
    encryptMessage: vi.fn().mockReturnValue({
      version: 1, senderId: 'alice', recipientId: 'alice',
      ciphertext: 'enc', nonce: 'nonce', senderSignature: 'sig',
    }),
  },
}))

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id:          'msg-1',
    channelId:   'ch-1',
    serverId:    'srv-1',
    authorId:    'user-alice',
    content:     'Hello world',
    contentType: 'text',
    attachments: [],
    reactions:   [],
    isEdited:    false,
    logicalTs:   '1000000000000-000000',
    createdAt:   new Date().toISOString(),
    verified:    true,
    ...overrides,
  }
}

function makeMutation(overrides: Partial<Mutation>): Mutation {
  return {
    id:         'mut-1',
    type:       'reaction_add',
    targetId:   'msg-1',
    channelId:  'ch-1',
    authorId:   'user-alice',
    logicalTs:  '1000000000001-000000',
    createdAt:  new Date().toISOString(),
    verified:   true,
    ...overrides,
  }
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('messagesStore.getMessagesWithMutations', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('returns messages unchanged when there are no mutations', async () => {
    const { useMessagesStore } = await import('@/stores/messagesStore')
    const store = useMessagesStore()
    const msg = makeMessage()
    store.messages['ch-1'] = [msg]
    store.mutations['ch-1'] = []

    const result = store.getMessagesWithMutations('ch-1')
    expect(result).toHaveLength(1)
    expect(result[0].content).toBe('Hello world')
    expect(result[0].isEdited).toBe(false)
    expect(result[0].reactions).toEqual([])
  })

  it('returns empty array for a channel with no messages', async () => {
    const { useMessagesStore } = await import('@/stores/messagesStore')
    const store = useMessagesStore()
    const result = store.getMessagesWithMutations('unknown-channel')
    expect(result).toEqual([])
  })

  // ── isEdited flag ──────────────────────────────────────────────────────────

  it('sets isEdited = true when an edit mutation targets the message', async () => {
    const { useMessagesStore } = await import('@/stores/messagesStore')
    const store = useMessagesStore()
    store.messages['ch-1']  = [makeMessage()]
    store.mutations['ch-1'] = [makeMutation({ type: 'edit', emojiId: undefined })]

    const result = store.getMessagesWithMutations('ch-1')
    expect(result[0].isEdited).toBe(true)
  })

  it('leaves isEdited = false when the edit targets a different message', async () => {
    const { useMessagesStore } = await import('@/stores/messagesStore')
    const store = useMessagesStore()
    store.messages['ch-1']  = [makeMessage({ id: 'msg-1' })]
    store.mutations['ch-1'] = [makeMutation({ type: 'edit', targetId: 'msg-OTHER' })]

    const result = store.getMessagesWithMutations('ch-1')
    expect(result[0].isEdited).toBe(false)
  })

  // ── Reaction folding ───────────────────────────────────────────────────────

  it('folds a reaction_add into the reactions array', async () => {
    const { useMessagesStore } = await import('@/stores/messagesStore')
    const store = useMessagesStore()
    store.messages['ch-1']  = [makeMessage()]
    store.mutations['ch-1'] = [
      makeMutation({ type: 'reaction_add', emojiId: '👍', authorId: 'user-bob' }),
    ]

    const result = store.getMessagesWithMutations('ch-1')
    expect(result[0].reactions).toHaveLength(1)
    expect(result[0].reactions[0]).toMatchObject({ emojiId: '👍', count: 1, selfReacted: false })
  })

  it('multiple reaction_adds from different users increment count', async () => {
    const { useMessagesStore } = await import('@/stores/messagesStore')
    const store = useMessagesStore()
    store.messages['ch-1']  = [makeMessage()]
    store.mutations['ch-1'] = [
      makeMutation({ id: 'm1', type: 'reaction_add', emojiId: '❤️', authorId: 'user-alice' }),
      makeMutation({ id: 'm2', type: 'reaction_add', emojiId: '❤️', authorId: 'user-bob' }),
    ]

    store.setMyUserId('user-alice')
    const result = store.getMessagesWithMutations('ch-1')
    const heart  = result[0].reactions.find(r => r.emojiId === '❤️')
    expect(heart?.count).toBe(2)
    expect(heart?.selfReacted).toBe(true)
  })

  it('sets selfReacted = true only for the current user\'s reaction', async () => {
    const { useMessagesStore } = await import('@/stores/messagesStore')
    const store = useMessagesStore()
    store.setMyUserId('user-alice')
    store.messages['ch-1']  = [makeMessage()]
    store.mutations['ch-1'] = [
      makeMutation({ id: 'm1', type: 'reaction_add', emojiId: '🔥', authorId: 'user-alice' }),
      makeMutation({ id: 'm2', type: 'reaction_add', emojiId: '❄️', authorId: 'user-bob' }),
    ]

    const result = store.getMessagesWithMutations('ch-1')
    const fire = result[0].reactions.find(r => r.emojiId === '🔥')
    const ice  = result[0].reactions.find(r => r.emojiId === '❄️')
    expect(fire?.selfReacted).toBe(true)
    expect(ice?.selfReacted).toBe(false)
  })

  it('reaction_remove after reaction_add decrements count to 0 and hides the entry', async () => {
    const { useMessagesStore } = await import('@/stores/messagesStore')
    const store = useMessagesStore()
    store.messages['ch-1']  = [makeMessage()]
    store.mutations['ch-1'] = [
      makeMutation({ id: 'm1', type: 'reaction_add',    emojiId: '👎', authorId: 'user-bob' }),
      makeMutation({ id: 'm2', type: 'reaction_remove', emojiId: '👎', authorId: 'user-bob' }),
    ]

    const result = store.getMessagesWithMutations('ch-1')
    // count reaches 0, so it should be filtered out
    expect(result[0].reactions.find(r => r.emojiId === '👎')).toBeUndefined()
  })

  it('reaction_remove without a prior add is a no-op', async () => {
    const { useMessagesStore } = await import('@/stores/messagesStore')
    const store = useMessagesStore()
    store.messages['ch-1']  = [makeMessage()]
    store.mutations['ch-1'] = [
      makeMutation({ type: 'reaction_remove', emojiId: '🤔', authorId: 'user-bob' }),
    ]

    const result = store.getMessagesWithMutations('ch-1')
    expect(result[0].reactions).toHaveLength(0)
  })

  it('mutations for different messages do not bleed into each other', async () => {
    const { useMessagesStore } = await import('@/stores/messagesStore')
    const store = useMessagesStore()
    store.messages['ch-1']  = [
      makeMessage({ id: 'msg-A' }),
      makeMessage({ id: 'msg-B' }),
    ]
    store.mutations['ch-1'] = [
      makeMutation({ targetId: 'msg-A', emojiId: '🎉', authorId: 'user-bob' }),
    ]

    const result = store.getMessagesWithMutations('ch-1')
    const msgA = result.find(m => m.id === 'msg-A')!
    const msgB = result.find(m => m.id === 'msg-B')!
    expect(msgA.reactions).toHaveLength(1)
    expect(msgB.reactions).toHaveLength(0)
  })
})

// ── applyMutation (edit / delete in-memory side effects) ──────────────────────

describe('messagesStore.applyMutation', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  it('delete mutation nulls content in messages.value', async () => {
    const { invoke } = await import('@tauri-apps/api/core')
    vi.mocked(invoke).mockResolvedValue(undefined)

    const { useMessagesStore } = await import('@/stores/messagesStore')
    const store = useMessagesStore()
    store.messages['ch-1'] = [makeMessage({ id: 'msg-1', content: 'keep this' })]

    await store.applyMutation(makeMutation({ type: 'delete', targetId: 'msg-1' }))

    expect(store.messages['ch-1'][0].content).toBeNull()
    expect(store.messages['ch-1'][0].attachments).toEqual([])
  })

  it('edit mutation with newer logicalTs updates content (LWW)', async () => {
    const { invoke } = await import('@tauri-apps/api/core')
    vi.mocked(invoke).mockResolvedValue(undefined)

    const { useMessagesStore } = await import('@/stores/messagesStore')
    const store = useMessagesStore()
    store.messages['ch-1'] = [makeMessage({ id: 'msg-1', logicalTs: '1000000000000-000000' })]

    await store.applyMutation(makeMutation({
      type:       'edit',
      targetId:   'msg-1',
      newContent: 'updated content',
      logicalTs:  '2000000000000-000000',
    }))

    expect(store.messages['ch-1'][0].content).toBe('updated content')
    expect(store.messages['ch-1'][0].isEdited).toBe(true)
  })

  it('stale edit mutation (older logicalTs) does not overwrite content', async () => {
    const { invoke } = await import('@tauri-apps/api/core')
    vi.mocked(invoke).mockResolvedValue(undefined)

    const { useMessagesStore } = await import('@/stores/messagesStore')
    const store = useMessagesStore()
    // Message already has a high-ts (it was already edited once on the DB side)
    store.messages['ch-1'] = [
      makeMessage({ id: 'msg-1', content: 'final version', logicalTs: '9000000000000-000000' }),
    ]

    await store.applyMutation(makeMutation({
      type:       'edit',
      targetId:   'msg-1',
      newContent: 'stale edit',
      logicalTs:  '1000000000000-000001',  // older than message ts
    }))

    expect(store.messages['ch-1'][0].content).toBe('final version')
  })
})

// ── loadMessages ──────────────────────────────────────────────────────────────

describe('messagesStore.loadMessages', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  function makeRow(id: string, logicalTs: string) {
    return {
      id,
      channel_id:      'ch-1',
      server_id:       'srv-1',
      author_id:       'user-alice',
      content:         'hello',
      content_type:    'text',
      reply_to_id:     null,
      created_at:      '2025-01-01T00:00:00.000Z',
      logical_ts:      logicalTs,
      verified:        1,
      raw_attachments: null,
    }
  }

  it('populates messages[channelId] from DB rows (newest last)', async () => {
    const { invoke } = await import('@tauri-apps/api/core')
    // DB returns rows in DESC order (newest first) — loadMessages reverses them
    vi.mocked(invoke).mockResolvedValue([
      makeRow('msg-3', '1000000000000-000002'),
      makeRow('msg-2', '1000000000000-000001'),
      makeRow('msg-1', '1000000000000-000000'),
    ])

    const { useMessagesStore } = await import('@/stores/messagesStore')
    const store = useMessagesStore()
    await store.loadMessages('ch-1')

    expect(store.messages['ch-1']).toHaveLength(3)
    expect(store.messages['ch-1'][0].id).toBe('msg-1')  // oldest first after reverse
    expect(store.messages['ch-1'][2].id).toBe('msg-3')
  })

  it('sets cursors[channelId] to the id of the oldest loaded message', async () => {
    const { invoke } = await import('@tauri-apps/api/core')
    vi.mocked(invoke).mockResolvedValue([
      makeRow('msg-3', '1000000000000-000002'),
      makeRow('msg-2', '1000000000000-000001'),
      makeRow('msg-1', '1000000000000-000000'),
    ])

    const { useMessagesStore } = await import('@/stores/messagesStore')
    const store = useMessagesStore()
    await store.loadMessages('ch-1')

    // After reverse, loaded[0] is the oldest row — its id becomes the cursor
    expect(store.cursors['ch-1']).toBe('msg-1')
  })

  it('loadMessages on empty channel sets messages to [] without throwing', async () => {
    const { invoke } = await import('@tauri-apps/api/core')
    vi.mocked(invoke).mockResolvedValue([])

    const { useMessagesStore } = await import('@/stores/messagesStore')
    const store = useMessagesStore()
    await expect(store.loadMessages('empty-channel')).resolves.not.toThrow()

    expect(store.messages['empty-channel']).toEqual([])
    expect(store.cursors['empty-channel']).toBeNull()
  })

  it('cursor load prepends older messages without replacing the existing window', async () => {
    const { invoke } = await import('@tauri-apps/api/core')
    const { useMessagesStore } = await import('@/stores/messagesStore')
    const store = useMessagesStore()

    // Seed the current window with newer messages
    store.messages['ch-1'] = [makeMessage({ id: 'msg-new', logicalTs: '2000000000000-000000' })]

    // Cursor load returns older messages
    vi.mocked(invoke).mockResolvedValue([
      makeRow('msg-old', '1000000000000-000000'),
    ])

    await store.loadMessages('ch-1', 'msg-new')  // pass a cursor

    expect(store.messages['ch-1']).toHaveLength(2)
    expect(store.messages['ch-1'][0].id).toBe('msg-old')  // prepended
    expect(store.messages['ch-1'][1].id).toBe('msg-new')
  })
})

// ── sendMessage ───────────────────────────────────────────────────────────────

describe('messagesStore.sendMessage', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  it('message appears in messages[channelId] with the same id after send', async () => {
    const { invoke } = await import('@tauri-apps/api/core')
    vi.mocked(invoke).mockResolvedValue(undefined)

    const { useMessagesStore } = await import('@/stores/messagesStore')
    const store = useMessagesStore()

    const result = await store.sendMessage('ch-1', 'srv-1', 'Hello world!')

    expect(result.id).toBeTruthy()
    const found = store.messages['ch-1'].find(m => m.id === result.id)
    expect(found).toBeDefined()
    expect(found?.content).toBe('Hello world!')
  })

  it('sendMessage persists to DB via db_save_message', async () => {
    const { invoke } = await import('@tauri-apps/api/core')
    vi.mocked(invoke).mockResolvedValue(undefined)

    const { useMessagesStore } = await import('@/stores/messagesStore')
    const store = useMessagesStore()

    await store.sendMessage('ch-1', 'srv-1', 'Persist me!')

    expect(invoke).toHaveBeenCalledWith('db_save_message', expect.objectContaining({
      msg: expect.objectContaining({
        channel_id: 'ch-1',
        content:    'Persist me!',
      }),
    }))
  })
})
