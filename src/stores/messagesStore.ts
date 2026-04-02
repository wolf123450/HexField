import { defineStore } from 'pinia'
import { ref } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import { v7 as uuidv7 } from 'uuid'
import type { Message, Mutation, Attachment, ReactionSummary, EncryptedEnvelope } from '@/types/core'
import { cryptoService } from '@/services/cryptoService'

// Wire message shape for chat_message payloads sent over the network
interface ChatWireMessage {
  type: 'chat_message'
  messageId: string
  channelId: string
  serverId: string
  authorId: string
  logicalTs: string
  createdAt: string
  contentType: 'text' | 'markdown' | 'system'
  envelopes: EncryptedEnvelope[]
}

export const useMessagesStore = defineStore('messages', () => {
  // channelId -> messages sorted by logicalTs ascending
  const messages        = ref<Record<string, Message[]>>({})
  // channelId -> oldest loaded message id (for cursor pagination)
  const cursors         = ref<Record<string, string | null>>({})
  // channelId -> optimistic send queue
  const pendingMessages = ref<Record<string, Message[]>>({})
  // channelId -> unread count
  const unreadCounts    = ref<Record<string, number>>({})
  // mutations per channel (source of truth for reactions/edits)
  const mutations       = ref<Record<string, Mutation[]>>({})

  // Local user ID — set once after identity init so we avoid circular store deps
  // in synchronous getters (see computeReactions).
  const _myUserId = ref<string | null>(null)

  function setMyUserId(id: string) {
    _myUserId.value = id
  }

  // ── Loading ────────────────────────────────────────────────────────────────

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

  // ── Derived view ───────────────────────────────────────────────────────────

  function getMessagesWithMutations(channelId: string): Message[] {
    const msgs = messages.value[channelId] ?? []
    const muts = mutations.value[channelId] ?? []
    const myId = _myUserId.value

    return msgs.map(msg => {
      const reactions = computeReactions(msg.id, muts, myId)
      const isEdited  = muts.some(m => m.type === 'edit' && m.targetId === msg.id)
      return { ...msg, reactions, isEdited }
    })
  }

  function computeReactions(messageId: string, muts: Mutation[], myId: string | null): ReactionSummary[] {
    const counts: Record<string, { count: number; selfReacted: boolean }> = {}
    for (const m of muts) {
      if (m.targetId !== messageId) continue
      if (m.type === 'reaction_add' && m.emojiId) {
        if (!counts[m.emojiId]) counts[m.emojiId] = { count: 0, selfReacted: false }
        counts[m.emojiId].count++
        if (myId && m.authorId === myId) counts[m.emojiId].selfReacted = true
      } else if (m.type === 'reaction_remove' && m.emojiId) {
        if (counts[m.emojiId]) {
          counts[m.emojiId].count = Math.max(0, counts[m.emojiId].count - 1)
          if (myId && m.authorId === myId) counts[m.emojiId].selfReacted = false
        }
      }
    }
    return Object.entries(counts)
      .filter(([, v]) => v.count > 0)
      .map(([emojiId, v]) => ({ emojiId, ...v }))
  }

  // ── Send ───────────────────────────────────────────────────────────────────

  async function sendMessage(
    channelId: string,
    serverId: string,
    content: string,
    attachments: Attachment[] = []
  ) {
    const { useIdentityStore } = await import('./identityStore')
    const identityStore = useIdentityStore()

    const now     = new Date().toISOString()
    const msgId   = uuidv7()
    const logical = generateHLC()

    const msg: Message = {
      id:          msgId,
      channelId,
      serverId,
      authorId:    identityStore.userId!,
      content,
      contentType: 'text',
      attachments,
      reactions:   [],
      isEdited:    false,
      logicalTs:   logical,
      createdAt:   now,
      verified:    true,
    }

    // 1. Optimistic display
    if (!pendingMessages.value[channelId]) pendingMessages.value[channelId] = []
    pendingMessages.value[channelId].push(msg)

    // 2. Save to SQLite
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

    // 3. Encrypt for each server member and broadcast
    try {
      const { useServersStore } = await import('./serversStore')
      const serversStore = useServersStore()
      const memberMap = serversStore.members[serverId] ?? {}
      const myUserId  = identityStore.userId!

      const envelopes: EncryptedEnvelope[] = []
      for (const member of Object.values(memberMap)) {
        if (!member.publicDHKey) continue
        envelopes.push(
          cryptoService.encryptMessage(content, myUserId, member.userId, member.publicDHKey)
        )
      }
      // Also encrypt for self so own device can verify its own history
      if (!memberMap[myUserId] && identityStore.publicDHKey) {
        envelopes.push(
          cryptoService.encryptMessage(content, myUserId, myUserId, identityStore.publicDHKey)
        )
      }

      if (envelopes.length > 0) {
        const { useNetworkStore } = await import('./networkStore')
        const networkStore = useNetworkStore()
        const wireMsg: ChatWireMessage = {
          type:        'chat_message',
          messageId:   msgId,
          channelId,
          serverId,
          authorId:    myUserId,
          logicalTs:   logical,
          createdAt:   now,
          contentType: 'text',
          envelopes,
        }
        networkStore.broadcast(wireMsg)
      }
    } catch (e) {
      // Encryption/broadcast failure is non-fatal — message is already saved locally
      console.error('[messages] encrypt/broadcast error:', e)
    }

    // 4. Move from pending to confirmed
    pendingMessages.value[channelId] = pendingMessages.value[channelId].filter(m => m.id !== msg.id)
    if (!messages.value[channelId]) messages.value[channelId] = []
    messages.value[channelId] = [...messages.value[channelId], msg]

    return msg
  }

  // ── Receive (encrypted from network) ──────────────────────────────────────

  async function receiveEncryptedMessage(rawMsg: unknown) {
    const wire = rawMsg as ChatWireMessage
    if (!wire.envelopes || !Array.isArray(wire.envelopes)) return

    const myUserId = _myUserId.value
    if (!myUserId) return

    // Find our envelope
    const envelope = wire.envelopes.find(e => e.recipientId === myUserId)
    if (!envelope) return

    // Look up sender's public keys
    const { useServersStore } = await import('./serversStore')
    const serversStore = useServersStore()
    const member = serversStore.members[wire.serverId]?.[wire.authorId]
    if (!member?.publicDHKey || !member?.publicSignKey) {
      console.warn('[messages] unknown sender keys for', wire.authorId)
      return
    }

    // Decrypt + verify signature
    const plaintext = cryptoService.decryptMessage(envelope, member.publicDHKey, member.publicSignKey)
    if (plaintext === null) {
      console.warn('[messages] decryption/verification failed for message', wire.messageId)
      return
    }

    // Deduplicate — may arrive over multiple transports
    const existing = messages.value[wire.channelId]
    if (existing?.some(m => m.id === wire.messageId)) return

    const msg: Message = {
      id:          wire.messageId,
      channelId:   wire.channelId,
      serverId:    wire.serverId,
      authorId:    wire.authorId,
      content:     plaintext,
      contentType: wire.contentType,
      attachments: [],
      reactions:   [],
      isEdited:    false,
      logicalTs:   wire.logicalTs,
      createdAt:   wire.createdAt,
      verified:    true,
    }

    // Persist to SQLite
    await invoke('db_save_message', {
      msg: {
        id:              msg.id,
        channel_id:      msg.channelId,
        server_id:       msg.serverId,
        author_id:       msg.authorId,
        content:         msg.content,
        content_type:    msg.contentType,
        reply_to_id:     null,
        created_at:      msg.createdAt,
        logical_ts:      msg.logicalTs,
        verified:        true,
        raw_attachments: null,
      },
    })

    // Add to reactive state
    if (!messages.value[wire.channelId]) messages.value[wire.channelId] = []
    messages.value[wire.channelId] = [...messages.value[wire.channelId], msg]
      .sort((a, b) => a.logicalTs.localeCompare(b.logicalTs))

    incrementUnread(wire.channelId)
  }

  // ── Mutations ──────────────────────────────────────────────────────────────

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

  // ── Unread / read tracking ─────────────────────────────────────────────────

  function markChannelRead(channelId: string) {
    unreadCounts.value[channelId] = 0
  }

  function incrementUnread(channelId: string) {
    unreadCounts.value[channelId] = (unreadCounts.value[channelId] ?? 0) + 1
  }

  return {
    messages,
    cursors,
    pendingMessages,
    unreadCounts,
    mutations,
    setMyUserId,
    loadMessages,
    loadMutationsForChannel,
    getMessagesWithMutations,
    sendMessage,
    receiveEncryptedMessage,
    applyMutation,
    markChannelRead,
  }
})

// ── Helpers ───────────────────────────────────────────────────────────────────

let _hlcLogical  = 0
let _hlcLastWall = 0

function generateHLC(): string {
  const wall = Date.now()
  if (wall > _hlcLastWall) {
    _hlcLastWall = wall
    _hlcLogical  = 0
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
