import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import { v7 as uuidv7 } from 'uuid'
import type { Message, Mutation, Attachment, ReactionSummary } from '@/types/core'

export const useMessagesStore = defineStore('messages', () => {
  // channelId → messages sorted by logicalTs ascending
  const messages        = ref<Record<string, Message[]>>({})
  // channelId → oldest loaded message id (for cursor pagination)
  const cursors         = ref<Record<string, string | null>>({})
  // channelId → optimistic send queue
  const pendingMessages = ref<Record<string, Message[]>>({})
  // channelId → unread count
  const unreadCounts    = ref<Record<string, number>>({})
  // mutations per channel (source of truth for reactions/edits)
  const mutations       = ref<Record<string, Mutation[]>>({})

  async function loadMessages(channelId: string, cursor?: string) {
    const rows = await invoke<any[]>('db_load_messages', {
      channelId,
      beforeId: cursor ?? null,
      limit: 100,
    })

    const loaded: Message[] = rows.map(rowToMessage).reverse()

    if (!cursor) {
      messages.value[channelId] = loaded
    } else {
      messages.value[channelId] = [...loaded, ...(messages.value[channelId] ?? [])]
    }
    cursors.value[channelId] = loaded[0]?.id ?? null
  }

  async function loadMutationsForChannel(channelId: string) {
    const rows = await invoke<any[]>('db_load_mutations', { channelId, afterTs: null })
    mutations.value[channelId] = rows.map(rowToMutation)
  }

  function getMessagesWithMutations(channelId: string): Message[] {
    const msgs = messages.value[channelId] ?? []
    const muts = mutations.value[channelId] ?? []

    return msgs.map(msg => {
      const reactions = computeReactions(msg.id, muts)
      const isEdited = muts.some(m => m.type === 'edit' && m.targetId === msg.id)
      return { ...msg, reactions, isEdited }
    })
  }

  function computeReactions(messageId: string, muts: Mutation[]): ReactionSummary[] {
    const { useIdentityStore } = require('./identityStore')
    const identityStore = useIdentityStore()
    const myId = identityStore.userId

    const counts: Record<string, { count: number; selfReacted: boolean }> = {}
    for (const m of muts) {
      if (m.targetId !== messageId) continue
      if (m.type === 'reaction_add' && m.emojiId) {
        if (!counts[m.emojiId]) counts[m.emojiId] = { count: 0, selfReacted: false }
        counts[m.emojiId].count++
        if (m.authorId === myId) counts[m.emojiId].selfReacted = true
      } else if (m.type === 'reaction_remove' && m.emojiId) {
        if (counts[m.emojiId]) {
          counts[m.emojiId].count = Math.max(0, counts[m.emojiId].count - 1)
          if (m.authorId === myId) counts[m.emojiId].selfReacted = false
        }
      }
    }
    return Object.entries(counts)
      .filter(([, v]) => v.count > 0)
      .map(([emojiId, v]) => ({ emojiId, ...v }))
  }

  async function sendMessage(
    channelId: string,
    serverId: string,
    content: string,
    attachments: Attachment[] = []
  ) {
    const { useIdentityStore } = await import('./identityStore')
    const identityStore = useIdentityStore()

    const now = new Date().toISOString()
    const msg: Message = {
      id:          uuidv7(),
      channelId,
      serverId,
      authorId:    identityStore.userId!,
      content,
      contentType: 'text',
      attachments,
      reactions:   [],
      isEdited:    false,
      logicalTs:   generateHLC(),
      createdAt:   now,
      verified:    true, // own messages are trusted
    }

    // Optimistic display
    if (!pendingMessages.value[channelId]) pendingMessages.value[channelId] = []
    pendingMessages.value[channelId].push(msg)

    // Save to SQLite
    await invoke('db_save_message', {
      msg: {
        id:              msg.id,
        channel_id:      msg.channelId,
        server_id:       msg.serverId,
        author_id:       msg.authorId,
        content:         msg.content,
        content_type:    msg.contentType,
        reply_to_id:     msg.replyToId ?? null,
        created_at:      msg.createdAt,
        logical_ts:      msg.logicalTs,
        verified:        true,
        raw_attachments: attachments.length ? JSON.stringify(attachments) : null,
      },
    })

    // Move from pending to confirmed
    pendingMessages.value[channelId] = pendingMessages.value[channelId].filter(m => m.id !== msg.id)
    if (!messages.value[channelId]) messages.value[channelId] = []
    messages.value[channelId] = [...messages.value[channelId], msg]

    return msg
  }

  async function applyMutation(mutation: Mutation) {
    await invoke('db_save_mutation', {
      mutation: {
        id:           mutation.id,
        type:         mutation.type,
        target_id:    mutation.targetId,
        channel_id:   mutation.channelId,
        author_id:    mutation.authorId,
        new_content:  mutation.newContent ?? null,
        emoji_id:     mutation.emojiId ?? null,
        logical_ts:   mutation.logicalTs,
        created_at:   mutation.createdAt,
        verified:     mutation.verified,
      },
    })

    const channelId = mutation.channelId
    if (!mutations.value[channelId]) mutations.value[channelId] = []
    mutations.value[channelId] = [...mutations.value[channelId], mutation]

    // Apply in-memory side effects
    if (mutation.type === 'delete') {
      const msgs = messages.value[channelId]
      if (msgs) {
        const idx = msgs.findIndex(m => m.id === mutation.targetId)
        if (idx >= 0) msgs[idx] = { ...msgs[idx], content: null, attachments: [] }
      }
    } else if (mutation.type === 'edit' && mutation.newContent) {
      const msgs = messages.value[channelId]
      if (msgs) {
        const idx = msgs.findIndex(m => m.id === mutation.targetId)
        if (idx >= 0 && msgs[idx].logicalTs < mutation.logicalTs) {
          msgs[idx] = { ...msgs[idx], content: mutation.newContent, isEdited: true }
        }
      }
    }
  }

  function markChannelRead(channelId: string) {
    unreadCounts.value[channelId] = 0
  }

  function incrementUnread(channelId: string) {
    unreadCounts.value[channelId] = (unreadCounts.value[channelId] ?? 0) + 1
  }

  function receiveMessage(msg: Message) {
    const channelId = msg.channelId
    if (!messages.value[channelId]) messages.value[channelId] = []
    if (!messages.value[channelId].find(m => m.id === msg.id)) {
      messages.value[channelId] = [...messages.value[channelId], msg]
        .sort((a, b) => a.logicalTs.localeCompare(b.logicalTs))
      incrementUnread(channelId)
    }
  }

  return {
    messages,
    cursors,
    pendingMessages,
    unreadCounts,
    mutations,
    loadMessages,
    loadMutationsForChannel,
    getMessagesWithMutations,
    sendMessage,
    applyMutation,
    markChannelRead,
    receiveMessage,
  }
})

// ── Helpers ───────────────────────────────────────────────────────────────────

let _hlcLogical = 0
let _hlcLastWall = 0

function generateHLC(): string {
  const wall = Date.now()
  if (wall > _hlcLastWall) {
    _hlcLastWall = wall
    _hlcLogical = 0
  } else {
    _hlcLogical++
  }
  return `${_hlcLastWall}-${_hlcLogical.toString().padStart(6, '0')}`
}

function rowToMessage(r: any): Message {
  return {
    id:          r.id,
    channelId:   r.channel_id,
    serverId:    r.server_id,
    authorId:    r.author_id,
    content:     r.content,
    contentType: r.content_type,
    attachments: r.raw_attachments ? JSON.parse(r.raw_attachments) : [],
    reactions:   [],
    isEdited:    false,
    replyToId:   r.reply_to_id ?? undefined,
    logicalTs:   r.logical_ts,
    createdAt:   r.created_at,
    verified:    Boolean(r.verified),
  }
}

function rowToMutation(r: any): Mutation {
  return {
    id:         r.id,
    type:       r.type,
    targetId:   r.target_id,
    channelId:  r.channel_id,
    authorId:   r.author_id,
    newContent: r.new_content ?? undefined,
    emojiId:    r.emoji_id ?? undefined,
    logicalTs:  r.logical_ts,
    createdAt:  r.created_at,
    verified:   Boolean(r.verified),
  }
}
