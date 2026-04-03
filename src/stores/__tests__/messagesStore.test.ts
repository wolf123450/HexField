import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { Message, Mutation } from '@/types/core'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))

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
