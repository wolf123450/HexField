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
const serversMock = vi.hoisted(() => ({
  members: {} as Record<string, Record<string, Record<string, unknown>>>,
  fetchMembers: async (serverId: string) => {
    serversMock.members[serverId] ??= {}
  },
}))
vi.mock('@/stores/serversStore', () => ({
  useServersStore: () => serversMock,
}))
vi.mock('@/stores/devicesStore', () => ({
  useDevicesStore: () => ({ getActiveDevices: () => [], deviceDHKey: null }),
}))
const networkMock = vi.hoisted(() => ({ broadcast: vi.fn(), broadcastToServer: vi.fn() }))
vi.mock('@/stores/networkStore', () => ({
  useNetworkStore: () => networkMock,
}))
vi.mock('@/stores/notificationStore', () => ({
  useNotificationStore: () => ({ notify: vi.fn() }),
}))
vi.mock('@/stores/channelsStore', () => ({
  useChannelsStore: () => ({ channels: {} }),
}))
vi.mock('@/services/cryptoService', () => ({
  cryptoService: {
    encryptMessage: vi.fn().mockReturnValue({
      version: 1, senderId: 'alice', recipientId: 'alice',
      ciphertext: 'enc', nonce: 'nonce', senderSignature: 'sig',
    }),
    decryptMessage: vi.fn().mockReturnValue('decrypted text'),
    sealForRecipients: vi.fn((_plain: string, keys: string[]) => ({
      sealed:   { ciphertext: 'blob', nonce: 'blob-nonce' },
      keyBoxes: keys.map(k => ({ ciphertext: `key-for-${k}`, nonce: 'n' })),
    })),
    openSealed: vi.fn(),
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

// ── sendEditMutation ──────────────────────────────────────────────────────────

describe('messagesStore.sendEditMutation', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  it('reflects edit immediately in getMessagesWithMutations (optimistic)', async () => {
    const { invoke } = await import('@tauri-apps/api/core')
    vi.mocked(invoke).mockResolvedValue(undefined)

    const { useMessagesStore } = await import('@/stores/messagesStore')
    const store = useMessagesStore()
    store.messages['ch-1'] = [makeMessage({ id: 'msg-1', content: 'original' })]
    store.mutations['ch-1'] = []

    await store.sendEditMutation('msg-1', 'ch-1', 'srv-1', 'edited content')

    const result = store.getMessagesWithMutations('ch-1')
    expect(result[0].content).toBe('edited content')
    expect(result[0].isEdited).toBe(true)
  })

  it('HLC last-write-wins: newer edit wins over older message ts', async () => {
    const { invoke } = await import('@tauri-apps/api/core')
    vi.mocked(invoke).mockResolvedValue(undefined)

    const { useMessagesStore } = await import('@/stores/messagesStore')
    const store = useMessagesStore()
    // Message has a low timestamp so the generated HLC will be newer
    store.messages['ch-1'] = [makeMessage({ id: 'msg-1', logicalTs: '0000000000001-000000', content: 'old' })]
    store.mutations['ch-1'] = []

    await store.sendEditMutation('msg-1', 'ch-1', 'srv-1', 'new content')

    expect(store.messages['ch-1'][0].content).toBe('new content')
    expect(store.messages['ch-1'][0].isEdited).toBe(true)
  })

  it('persists the edit mutation to DB via db_save_mutation', async () => {
    const { invoke } = await import('@tauri-apps/api/core')
    vi.mocked(invoke).mockResolvedValue(undefined)

    const { useMessagesStore } = await import('@/stores/messagesStore')
    const store = useMessagesStore()
    store.messages['ch-1'] = [makeMessage({ id: 'msg-1' })]
    store.mutations['ch-1'] = []

    await store.sendEditMutation('msg-1', 'ch-1', 'srv-1', 'db edit')

    expect(invoke).toHaveBeenCalledWith('db_save_mutation', expect.objectContaining({
      mutation: expect.objectContaining({ type: 'edit', new_content: 'db edit' }),
    }))
  })
})

// ── sendDeleteMutation ────────────────────────────────────────────────────────

describe('messagesStore.sendDeleteMutation', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  it('message becomes content: null in reactive state after delete', async () => {
    const { invoke } = await import('@tauri-apps/api/core')
    vi.mocked(invoke).mockResolvedValue(undefined)

    const { useMessagesStore } = await import('@/stores/messagesStore')
    const store = useMessagesStore()
    store.messages['ch-1'] = [makeMessage({ id: 'msg-1', content: 'delete me' })]
    store.mutations['ch-1'] = []

    await store.sendDeleteMutation('msg-1', 'ch-1', 'srv-1')

    expect(store.messages['ch-1'][0].content).toBeNull()
  })

  it('persists the delete mutation to DB via db_save_mutation', async () => {
    const { invoke } = await import('@tauri-apps/api/core')
    vi.mocked(invoke).mockResolvedValue(undefined)

    const { useMessagesStore } = await import('@/stores/messagesStore')
    const store = useMessagesStore()
    store.messages['ch-1'] = [makeMessage({ id: 'msg-1' })]
    store.mutations['ch-1'] = []

    await store.sendDeleteMutation('msg-1', 'ch-1', 'srv-1')

    expect(invoke).toHaveBeenCalledWith('db_save_mutation', expect.objectContaining({
      mutation: expect.objectContaining({ type: 'delete', target_id: 'msg-1' }),
    }))
  })
})

// ── Privacy: server-scoped delivery + encrypted attachment metadata ──────────

describe('messagesStore privacy (server members only)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    serversMock.members = {}
  })

  it('sendMessage sends only to server members and never puts attachments in plaintext', async () => {
    const { invoke } = await import('@tauri-apps/api/core')
    vi.mocked(invoke).mockResolvedValue(undefined)
    serversMock.members['srv-1'] = {
      'user-bob': { userId: 'user-bob', publicDHKey: 'pub-dh-bob', publicSignKey: 'sign-bob' },
    }

    const { useMessagesStore } = await import('@/stores/messagesStore')
    const store = useMessagesStore()
    const attachment = {
      id: 'att-1', name: 'secret-plans.png', size: 10, mimeType: 'image/png',
      contentHash: 'blake3:abc', transferState: 'complete' as const,
    }
    await store.sendMessage('ch-1', 'srv-1', 'see file', [attachment])

    expect(networkMock.broadcast).not.toHaveBeenCalled()
    expect(networkMock.broadcastToServer).toHaveBeenCalledTimes(1)
    const [serverId, wire] = networkMock.broadcastToServer.mock.calls[0]
    expect(serverId).toBe('srv-1')
    expect(wire.attachments).toBeUndefined()
    expect(wire.attachmentsCipher).toEqual({ ciphertext: 'blob', nonce: 'blob-nonce' })
    expect(JSON.stringify(wire)).not.toContain('secret-plans')
    expect(JSON.stringify(wire)).not.toContain('blake3:abc')
    for (const env of wire.envelopes) expect(env.attachmentKey).toBeDefined()
  })

  it('chat mutations (reactions, edit, delete) go only to server members', async () => {
    const { invoke } = await import('@tauri-apps/api/core')
    vi.mocked(invoke).mockResolvedValue(undefined)
    const { useMessagesStore } = await import('@/stores/messagesStore')
    const store = useMessagesStore()
    store.messages['ch-1'] = [makeMessage({ id: 'msg-1' })]
    store.mutations['ch-1'] = []

    await store.addReaction('msg-1', 'ch-1', 'srv-1', 'thumbsup')
    await store.removeReaction('msg-1', 'ch-1', 'srv-1', 'thumbsup')
    await store.sendEditMutation('msg-1', 'ch-1', 'srv-1', 'edited')
    await store.sendDeleteMutation('msg-1', 'ch-1', 'srv-1')

    expect(networkMock.broadcast).not.toHaveBeenCalled()
    expect(networkMock.broadcastToServer).toHaveBeenCalledTimes(4)
    for (const [serverId, payload] of networkMock.broadcastToServer.mock.calls) {
      expect(serverId).toBe('srv-1')
      expect(payload.type).toBe('mutation')
    }
  })

  function wireFrom(authorId: string, extra: Record<string, unknown> = {}) {
    return {
      type: 'chat_message', messageId: `m-${authorId}`, channelId: 'ch-1', serverId: 'srv-1',
      authorId, logicalTs: '1000000000000-000000', createdAt: new Date().toISOString(),
      contentType: 'text',
      envelopes: [{ version: 1, senderId: authorId, recipientId: 'user-alice',
        ciphertext: 'c', nonce: 'n', senderSignature: 's' }],
      ...extra,
    }
  }

  it('accepts a message once the author becomes a member (retry covers member_join race)', async () => {
    vi.useFakeTimers()
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      vi.mocked(invoke).mockResolvedValue([])
      const { useMessagesStore } = await import('@/stores/messagesStore')
      const store = useMessagesStore()
      store.setMyUserId('user-alice')

      await store.receiveEncryptedMessage(wireFrom('user-carol'))
      expect(store.messages['ch-1']).toBeUndefined()

      serversMock.members['srv-1']['user-carol'] = { userId: 'user-carol', publicDHKey: 'dh-carol', publicSignKey: 'sign-carol' }
      await vi.advanceTimersByTimeAsync(2000)

      expect(store.messages['ch-1']?.map(m => m.id)).toEqual(['m-user-carol'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('drops a message from a non-member after the retries run out', async () => {
    vi.useFakeTimers()
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      vi.mocked(invoke).mockResolvedValue([])
      const { useMessagesStore } = await import('@/stores/messagesStore')
      const store = useMessagesStore()
      store.setMyUserId('user-alice')

      await store.receiveEncryptedMessage(wireFrom('user-mallory'))
      await vi.advanceTimersByTimeAsync(2000 * 6)

      expect(store.messages['ch-1']).toBeUndefined()
      expect(invoke).not.toHaveBeenCalledWith('db_save_message', expect.anything())
    } finally {
      vi.useRealTimers()
    }
  })

  it('still accepts plaintext attachments from an old (pre-0.2.14) sender', async () => {
    const { invoke } = await import('@tauri-apps/api/core')
    vi.mocked(invoke).mockResolvedValue(undefined)
    serversMock.members['srv-1'] = {
      'user-bob': { userId: 'user-bob', publicDHKey: 'dh-bob', publicSignKey: 'sign-bob' },
    }
    const { useMessagesStore } = await import('@/stores/messagesStore')
    const store = useMessagesStore()
    store.setMyUserId('user-alice')

    const legacy = [{ id: 'att-9', name: 'old.txt', size: 3, mimeType: 'text/plain', transferState: 'complete' }]
    await store.receiveEncryptedMessage(wireFrom('user-bob', { attachments: legacy }))

    expect(store.messages['ch-1'][0].attachments).toEqual(legacy)
  })
})
