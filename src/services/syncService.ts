/**
 * syncService — P2P history reconciliation using Negentropy (via Tauri Rust backend).
 *
 * Three-pass sync per peer connection:
 *   Pass 0: messages  table, per channel
 *   Pass 1: mutations table, per channel
 *   Pass 2: mutations table, channel_id = '__server__' (server-level mutations)
 *
 * Wire message types (over WebRTC data channel):
 *   sync_neg_init  — initiator starts negentropy for one channel+pass
 *   sync_neg_reply — responder's negentropy reply
 *   sync_push      — sender pushes content the receiver is missing
 *   sync_want      — request content by ID from the other peer
 */

import { invoke } from '@tauri-apps/api/core'
import type { MessageRow, MutationRow, Mutation } from '@/types/core'
import { logger } from '@/utils/logger'

// ── Wire types ────────────────────────────────────────────────────────────────

type SyncTable = 'messages' | 'mutations'

interface SyncNegInit {
  type: 'sync_neg_init'
  sessionId: string
  channelId: string
  table: SyncTable
  msg: string // base64 negentropy message
}

interface SyncNegReply {
  type: 'sync_neg_reply'
  sessionId: string
  msg: string // base64 negentropy reply
}

interface SyncPush {
  type: 'sync_push'
  sessionId: string
  table: SyncTable
  channelId: string
  messages?: MessageRow[]
  mutations?: MutationRow[]
}

interface SyncWant {
  type: 'sync_want'
  sessionId: string
  table: SyncTable
  channelId: string
  ids: string[]
}

export type SyncWireMessage =
  | SyncNegInit
  | SyncNegReply
  | SyncPush
  | SyncWant

// ── Session state ─────────────────────────────────────────────────────────────

interface PendingSession {
  channelId: string
  table: SyncTable
}

// sessionId → pending context (what we're waiting for the responder to reply to)
const _pendingSessions = new Map<string, PendingSession>()

// ── Send callback (set by networkStore) ──────────────────────────────────────

type SendFn = (peerId: string, data: unknown) => void
let _sendToPeer: SendFn = () => {}

export function setSendFn(fn: SendFn): void {
  _sendToPeer = fn
}

// ── Initiator: start sync for a newly connected peer ─────────────────────────

export async function startSync(peerId: string): Promise<void> {
  logger.debug('sync', 'startSync with peer:', peerId)
  try {
    // Pass 0: Server-level mutations FIRST (members, channels, devices, emoji, server updates)
    await _startNegSession(peerId, '__server__', 'mutations')

    // Then per-channel passes
    const channelIds: string[] = await invoke('sync_list_channels')
    for (const channelId of channelIds) {
      await _startNegSession(peerId, channelId, 'messages')
      await _startNegSession(peerId, channelId, 'mutations')
    }
  } catch (e) {
    logger.warn('sync', 'startSync error:', e)
  }
}

async function _startNegSession(
  peerId: string,
  channelId: string,
  table: SyncTable,
): Promise<void> {
  logger.debug('sync', 'neg session:', channelId, table, '→', peerId)
  try {
    const msg: string = await invoke('sync_initiate', { channelId, table })
    const sessionId = `${Date.now()}-${Math.random().toString(36).slice(2)}`
    _pendingSessions.set(sessionId, { channelId, table })
    _sendToPeer(peerId, { type: 'sync_neg_init', sessionId, channelId, table, msg } satisfies SyncNegInit)
  } catch (e) {
    logger.warn('sync', `initiate failed for ${channelId}/${table}:`, e)
  }
}

// ── Dispatch incoming sync messages ──────────────────────────────────────────

export async function handleSyncMessage(
  peerId: string,
  msg: SyncWireMessage,
): Promise<void> {
  switch (msg.type) {
    case 'sync_neg_init':
      await _onNegInit(peerId, msg)
      break
    case 'sync_neg_reply':
      await _onNegReply(peerId, msg)
      break
    case 'sync_push':
      await _onPush(msg)
      break
    case 'sync_want':
      await _onWant(peerId, msg)
      break
  }
}

// ── Responder: received initiator's first negentropy message ─────────────────

async function _onNegInit(peerId: string, wire: SyncNegInit): Promise<void> {
  try {
    const reply: string = await invoke('sync_respond', {
      channelId: wire.channelId,
      table:     wire.table,
      msg:       wire.msg,
    })
    _sendToPeer(peerId, { type: 'sync_neg_reply', sessionId: wire.sessionId, msg: reply } satisfies SyncNegReply)
  } catch (e) {
    logger.warn('sync', 'sync_respond error:', e)
  }
}

// ── Initiator: received responder's negentropy reply ─────────────────────────

async function _onNegReply(peerId: string, wire: SyncNegReply): Promise<void> {
  const session = _pendingSessions.get(wire.sessionId)
  if (!session) {
    logger.warn('sync', 'received neg_reply for unknown session', wire.sessionId)
    return
  }
  _pendingSessions.delete(wire.sessionId)

  const { channelId, table } = session

  try {
    const diff: { have_ids: string[]; need_ids: string[] } = await invoke('sync_process_response', {
      channelId,
      table,
      msg: wire.msg,
    })
    logger.debug('sync', 'diff', channelId, table, 'have:', diff.have_ids.length, 'need:', diff.need_ids.length)

    // Push content we have that the peer needs
    if (diff.have_ids.length > 0) {
      await _pushItems(peerId, wire.sessionId, channelId, table, diff.have_ids)
    }

    // Request content the peer has that we need
    if (diff.need_ids.length > 0) {
      _sendToPeer(peerId, {
        type: 'sync_want',
        sessionId: wire.sessionId,
        table,
        channelId,
        ids: diff.need_ids,
      } satisfies SyncWant)
    }
  } catch (e) {
    logger.warn('sync', 'process_response error:', e)
  }
}

// ── Push content to peer ──────────────────────────────────────────────────────

// WebRTC data channels (SCTP) have a ~65 KB max message size.  Chunk by
// serialized byte size so every individual SCTP frame stays well under the
// limit.  A message whose content is a base64-encoded image can easily exceed
// this on its own (100 KB binary → ~133 KB base64); those are stripped to a
// placeholder so the endless negentropy retry loop is broken.  New messages
// use a 40 KB inline cap (see MessageInput.vue) so they always fit.
const SCTP_SAFE_BYTES = 60_000
// The sync_push JSON envelope wraps the items array and adds a fixed overhead
// (type, sessionId, table, channelId fields ≈ 160 chars).  We subtract a
// generous bound so the FULL wire payload always fits within SCTP_SAFE_BYTES.
const SYNC_PUSH_OVERHEAD = 256
const ITEM_BUDGET = SCTP_SAFE_BYTES - SYNC_PUSH_OVERHEAD // 59,744

async function _pushItems(
  peerId: string,
  sessionId: string,
  channelId: string,
  table: SyncTable,
  ids: string[],
): Promise<void> {
  try {
    if (table === 'messages') {
      const messages: MessageRow[] = await invoke('sync_get_messages', { ids })
      let batch: MessageRow[] = []
      let batchBytes = 0
      const flush = () => {
        if (batch.length === 0) return
        _sendToPeer(peerId, { type: 'sync_push', sessionId, table, channelId, messages: batch } satisfies SyncPush)
        batch = []
        batchBytes = 0
      }
      for (const msg of messages) {
        // Strip oversized inline payloads so the SCTP frame stays under the
        // limit and negentropy stops re-trying these rows forever.
        let safe: MessageRow = msg
        // Strip large data: URIs from content
        if (msg.content?.startsWith('data:') && msg.content.length > ITEM_BUDGET) {
          safe = { ...safe, content: '[image: too large to sync inline]' }
        }
        // Strip inlineData from raw_attachments entries
        if (safe.raw_attachments) {
          try {
            const atts = JSON.parse(safe.raw_attachments) as Array<Record<string, unknown>>
            const stripped = atts.map(a => {
              if (typeof a.inlineData === 'string' && a.inlineData.length > ITEM_BUDGET) {
                const { inlineData: _, ...rest } = a
                return { ...rest, transferState: 'stripped' }
              }
              return a
            })
            safe = { ...safe, raw_attachments: JSON.stringify(stripped) }
          } catch { /* leave as-is if not valid JSON */ }
        }
        const itemBytes = JSON.stringify(safe).length
        // Final guard: skip items that are still too large even after all stripping.
        // This prevents a single item from blowing the SCTP frame regardless of source.
        if (itemBytes > ITEM_BUDGET) {
          logger.warn('sync', 'item too large to send even after stripping, skipping:', msg.id, itemBytes)
          continue
        }
        if (batchBytes + itemBytes > ITEM_BUDGET && batch.length > 0) flush()
        batch.push(safe)
        batchBytes += itemBytes
      }
      flush()
    } else {
      const mutations: MutationRow[] = await invoke('sync_get_mutations', { ids })
      let batch: MutationRow[] = []
      let batchBytes = 0
      const flush = () => {
        if (batch.length === 0) return
        _sendToPeer(peerId, { type: 'sync_push', sessionId, table, channelId, mutations: batch } satisfies SyncPush)
        batch = []
        batchBytes = 0
      }
      for (const mut of mutations) {
        const itemBytes = JSON.stringify(mut).length
        if (batchBytes + itemBytes > ITEM_BUDGET && batch.length > 0) flush()
        batch.push(mut)
        batchBytes += itemBytes
      }
      flush()
    }
  } catch (e) {
    logger.warn('sync', 'push error:', e)
  }
}

// ── Receive pushed content ────────────────────────────────────────────────────

function _rowToMutation(r: MutationRow): Mutation {
  return {
    id:         r.id,
    type:       r.type as Mutation['type'],
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

async function _onPush(wire: SyncPush): Promise<void> {
  try {
    if (wire.table === 'messages' && wire.messages && wire.messages.length > 0) {
      await invoke('sync_save_messages', { messages: wire.messages })
      // Refresh in-memory state for the affected channel
      const { useMessagesStore } = await import('@/stores/messagesStore')
      const messagesStore = useMessagesStore()
      await messagesStore.loadMessages(wire.channelId)
    } else if (wire.table === 'mutations' && wire.mutations && wire.mutations.length > 0) {
      await invoke('sync_save_mutations', { mutations: wire.mutations })
      // Refresh mutations for the affected channel
      const { useMessagesStore } = await import('@/stores/messagesStore')
      const messagesStore = useMessagesStore()
      if (wire.channelId !== '__server__') {
        await messagesStore.loadMutationsForChannel(wire.channelId)
      }

      // Hydrate channels, members, emoji from server-level mutations
      if (wire.channelId === '__server__') {
        const { useChannelsStore } = await import('@/stores/channelsStore')
        const channelsStore = useChannelsStore()
        const { useServersStore } = await import('@/stores/serversStore')
        const serversStore = useServersStore()
        const { useEmojiStore } = await import('@/stores/emojiStore')
        const emojiStore = useEmojiStore()

        for (const row of wire.mutations) {
          const mutation = _rowToMutation(row)

          if (['channel_create', 'channel_update', 'channel_delete'].includes(mutation.type)) {
            await channelsStore.applyChannelMutation(mutation)
          }

          if (mutation.type === 'member_join' && mutation.newContent) {
            const payload = JSON.parse(mutation.newContent)
            if (payload.serverId && payload.userId) {
              const member = {
                userId:        payload.userId        as string,
                serverId:      payload.serverId      as string,
                displayName:   (payload.displayName  as string) ?? '',
                roles:         (payload.roles        as string[]) ?? ['member'],
                joinedAt:      (payload.joinedAt     as string) ?? mutation.createdAt,
                publicSignKey: (payload.publicSignKey as string) ?? '',
                publicDHKey:   (payload.publicDHKey   as string) ?? '',
                onlineStatus:  'offline' as const,
              }
              // Update in-memory reactive map
              if (!serversStore.members[member.serverId]) serversStore.members[member.serverId] = {}
              serversStore.members[member.serverId][member.userId] = member
              // Persist to SQLite so fetchMembers can reload C after restart or server switch
              await invoke('db_upsert_member', {
                member: {
                  user_id:         member.userId,
                  server_id:       member.serverId,
                  display_name:    member.displayName,
                  roles:           JSON.stringify(member.roles),
                  joined_at:       member.joinedAt,
                  public_sign_key: member.publicSignKey,
                  public_dh_key:   member.publicDHKey,
                  online_status:   member.onlineStatus,
                },
              })
            }
          }

          if (mutation.type === 'member_profile_update' && mutation.newContent) {
            const patch = JSON.parse(mutation.newContent)
            if (patch.serverId) {
              serversStore.updateMemberProfile(patch.serverId, mutation.targetId, patch)
            }
          }

          if (mutation.type === 'emoji_add' && mutation.newContent) {
            emojiStore.applyEmojiAddMutation(JSON.parse(mutation.newContent))
          }
          if (mutation.type === 'emoji_remove') {
            emojiStore.applyEmojiRemoveMutation(mutation.targetId)
          }
        }
      }
    }
  } catch (e) {
    console.warn('[sync] save error:', e)
  }
}

// ── Respond to a want request ─────────────────────────────────────────────────

async function _onWant(peerId: string, wire: SyncWant): Promise<void> {
  await _pushItems(peerId, wire.sessionId, wire.channelId, wire.table, wire.ids)
}
