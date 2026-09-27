/**
 * syncService — P2P history reconciliation using Negentropy (via Tauri Rust backend).
 *
 * Three-pass sync per peer connection, only for servers that both we and the
 * peer are members of (every frame carries its serverId):
 *   Pass 0: mutations table, channel_id = '__server__' (server-level mutations), per server
 *   Pass 1: messages  table, per channel
 *   Pass 2: mutations table, per channel
 *
 * Scope is enforced on both sides: we never serve or accept rows outside a
 * server shared with the peer (membership checked here, channel/server match
 * checked by the Rust `sync_*` commands).
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
  serverId: string
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
  serverId: string
  channelId: string
  messages?: MessageRow[]
  mutations?: MutationRow[]
}

interface SyncWant {
  type: 'sync_want'
  sessionId: string
  table: SyncTable
  serverId: string
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
  peerId: string
  serverId: string
  channelId: string
  table: SyncTable
}

const SERVER_CHANNEL = '__server__'

// sessionId → pending context (what we're waiting for the responder to reply to)
const _pendingSessions = new Map<string, PendingSession>()

// ── Send callback (set by networkStore) ──────────────────────────────────────

type SendFn = (peerId: string, data: unknown) => void
let _sendToPeer: SendFn = () => {}

export function setSendFn(fn: SendFn): void {
  _sendToPeer = fn
}

// ── Membership scope ─────────────────────────────────────────────────────────

/** True when both we and `peerId` are members of `serverId`. */
async function _sharesServer(peerId: string, serverId: string): Promise<boolean> {
  if (typeof serverId !== 'string' || !serverId) return false
  const { useIdentityStore } = await import('@/stores/identityStore')
  const myId = useIdentityStore().userId
  if (!myId) return false
  const { useServersStore } = await import('@/stores/serversStore')
  const serversStore = useServersStore()
  return await serversStore.isServerMember(serverId, myId)
    && await serversStore.isServerMember(serverId, peerId)
}

/** IDs of the servers that both we and `peerId` are members of. */
async function _sharedServerIds(peerId: string): Promise<string[]> {
  const { useServersStore } = await import('@/stores/serversStore')
  const shared: string[] = []
  for (const serverId of Object.keys(useServersStore().servers)) {
    if (await _sharesServer(peerId, serverId)) shared.push(serverId)
  }
  return shared
}

// ── Initiator: start sync for a newly connected peer ─────────────────────────

interface SyncChannel {
  channel_id: string
  server_id: string
}

export async function startSync(peerId: string): Promise<void> {
  logger.debug('sync', 'startSync with peer:', peerId)
  try {
    const serverIds = await _sharedServerIds(peerId)
    if (serverIds.length === 0) {
      logger.debug('sync', 'no shared servers with peer:', peerId)
      return
    }

    // Pass 0: Server-level mutations FIRST (members, channels, emoji, server updates)
    for (const serverId of serverIds) {
      await _startNegSession(peerId, serverId, SERVER_CHANNEL, 'mutations')
    }

    // Then per-channel passes, only for channels of the shared servers
    const channels: SyncChannel[] = await invoke('sync_list_channels', { serverIds })
    for (const { channel_id: channelId, server_id: serverId } of channels) {
      await _startNegSession(peerId, serverId, channelId, 'messages')
      await _startNegSession(peerId, serverId, channelId, 'mutations')
    }
  } catch (e) {
    logger.warn('sync', 'startSync error:', e)
  }
}

async function _startNegSession(
  peerId: string,
  serverId: string,
  channelId: string,
  table: SyncTable,
): Promise<void> {
  logger.debug('sync', 'neg session:', serverId, channelId, table, '→', peerId)
  try {
    const msg: string = await invoke('sync_initiate', { serverId, channelId, table })
    const sessionId = `${Date.now()}-${Math.random().toString(36).slice(2)}`
    _pendingSessions.set(sessionId, { peerId, serverId, channelId, table })
    _sendToPeer(peerId, { type: 'sync_neg_init', sessionId, serverId, channelId, table, msg } satisfies SyncNegInit)
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
      await _onPush(peerId, msg)
      break
    case 'sync_want':
      await _onWant(peerId, msg)
      break
  }
}

// ── Responder: received initiator's first negentropy message ─────────────────

async function _onNegInit(peerId: string, wire: SyncNegInit): Promise<void> {
  try {
    // Only reconcile servers the peer shares with us; Rust then checks that
    // wire.channelId really belongs to wire.serverId.
    if (!await _sharesServer(peerId, wire.serverId)) {
      logger.warn('sync', 'ignoring neg_init for a server not shared with', peerId, wire.serverId)
      return
    }
    const reply: string = await invoke('sync_respond', {
      serverId:  wire.serverId,
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
  if (!session || session.peerId !== peerId) {
    logger.warn('sync', 'received neg_reply for unknown session', wire.sessionId)
    return
  }
  _pendingSessions.delete(wire.sessionId)

  const { serverId, channelId, table } = session

  try {
    const diff: { have_ids: string[]; need_ids: string[] } = await invoke('sync_process_response', {
      serverId,
      channelId,
      table,
      msg: wire.msg,
    })
    logger.debug('sync', 'diff', channelId, table, 'have:', diff.have_ids.length, 'need:', diff.need_ids.length)

    // Push content we have that the peer needs
    if (diff.have_ids.length > 0) {
      await _pushItems(peerId, wire.sessionId, serverId, channelId, table, diff.have_ids)
    }

    // Request content the peer has that we need
    if (diff.need_ids.length > 0) {
      _sendToPeer(peerId, {
        type: 'sync_want',
        sessionId: wire.sessionId,
        table,
        serverId,
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

/**
 * Send the requested rows to `peerId`. Every push path (neg_reply diff and
 * sync_want) goes through here, so this is where the send side is gated:
 * nothing is served unless the peer shares `serverId` with us, and the Rust
 * getters only return rows whose own channel/server match the scope, whatever
 * IDs were asked for.
 */
async function _pushItems(
  peerId: string,
  sessionId: string,
  serverId: string,
  channelId: string,
  table: SyncTable,
  ids: string[],
): Promise<void> {
  try {
    if (!await _sharesServer(peerId, serverId)) {
      logger.warn('sync', 'refusing to serve a server not shared with', peerId, serverId)
      return
    }
    if (table === 'messages') {
      const messages: MessageRow[] = await invoke('sync_get_messages', { serverId, channelId, ids })
      let batch: MessageRow[] = []
      let batchBytes = 0
      const flush = () => {
        if (batch.length === 0) return
        _sendToPeer(peerId, { type: 'sync_push', sessionId, table, serverId, channelId, messages: batch } satisfies SyncPush)
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
      const mutations: MutationRow[] = await invoke('sync_get_mutations', { serverId, channelId, ids })
      let batch: MutationRow[] = []
      let batchBytes = 0
      const flush = () => {
        if (batch.length === 0) return
        _sendToPeer(peerId, { type: 'sync_push', sessionId, table, serverId, channelId, mutations: batch } satisfies SyncPush)
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
    verified:   false, // set only by authorizeMutation, never taken from the peer
    sig:        r.sig ?? undefined,
  }
}

/**
 * Receive-side gate: drop the push unless both we and the sender are members
 * of `wire.serverId`, then keep only the rows whose own channel/server match
 * the frame (Rust `sync_scope_*` also checks the channel is in that server).
 * Returns the push with only in-scope rows, or null when nothing is left.
 */
async function _scopePush(peerId: string, wire: SyncPush): Promise<SyncPush | null> {
  if (typeof wire.channelId !== 'string' || !wire.channelId) return null
  const rows = wire.table === 'messages' ? wire.messages : wire.table === 'mutations' ? wire.mutations : undefined
  if (!Array.isArray(rows) || rows.length === 0) return null
  if (!await _sharesServer(peerId, wire.serverId)) {
    logger.warn('sync', 'dropping push for a server not shared with', peerId, wire.serverId)
    return null
  }
  const scope = { serverId: wire.serverId, channelId: wire.channelId }
  if (wire.table === 'messages') {
    const messages: MessageRow[] = await invoke('sync_scope_messages', { ...scope, messages: rows })
    if (messages.length < rows.length) {
      logger.warn('sync', `dropped ${rows.length - messages.length} out-of-scope messages from`, peerId)
    }
    return messages.length > 0 ? { ...wire, messages, mutations: undefined } : null
  }
  const mutations: MutationRow[] = await invoke('sync_scope_mutations', { ...scope, mutations: rows })
  if (mutations.length < rows.length) {
    logger.warn('sync', `dropped ${rows.length - mutations.length} out-of-scope mutations from`, peerId)
  }
  return mutations.length > 0 ? { ...wire, messages: undefined, mutations } : null
}

async function _onPush(peerId: string, pushed: SyncPush): Promise<void> {
  try {
    const wire = await _scopePush(peerId, pushed)
    if (!wire) return
    if (wire.table === 'messages' && wire.messages && wire.messages.length > 0) {
      await invoke('sync_save_messages', { messages: wire.messages })
      // Refresh in-memory state for the affected channel
      const { useMessagesStore } = await import('@/stores/messagesStore')
      const messagesStore = useMessagesStore()
      await messagesStore.loadMessages(wire.channelId)
    } else if (wire.table === 'mutations' && wire.mutations && wire.mutations.length > 0) {
      // Every row is checked like a live mutation (spec 08 §5): signature by the
      // author's known key plus authorship. Rejected rows are not stored, so
      // negentropy offers them again next session (e.g. once the target message
      // has arrived). member_join rows go first: they introduce the keys the
      // other rows are verified against, so each is stored before the next check.
      const { authorizeMutation, mutationToRow } = await import('./mutationAuth')
      const ordered = [
        ...wire.mutations.filter(r => r.type === 'member_join'),
        ...wire.mutations.filter(r => r.type !== 'member_join'),
      ]
      const { useMessagesStore } = await import('@/stores/messagesStore')
      const messagesStore = useMessagesStore()
      const { useChannelsStore } = await import('@/stores/channelsStore')
      const channelsStore = useChannelsStore()
      const { useServersStore } = await import('@/stores/serversStore')
      const serversStore = useServersStore()
      const { useEmojiStore } = await import('@/stores/emojiStore')
      const emojiStore = useEmojiStore()

      let accepted = 0
      for (const row of ordered) {
        if (row.channel_id !== wire.channelId) {
          logger.warn('sync', 'mutation', row.id, 'rejected: not in pushed channel', wire.channelId)
          continue
        }
        const auth = await authorizeMutation(_rowToMutation(row))
        if (!auth.ok) {
          logger.warn('sync', 'mutation', row.id, 'rejected:', auth.reason)
          continue
        }
        const mutation = auth.mutation
        await invoke('sync_save_mutations', { mutations: [mutationToRow(mutation)] })
        accepted++

        // Hydrate channels, members, emoji from server-level mutations
        if (wire.channelId === '__server__') {
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

          if (mutation.type.startsWith('governance_') && mutation.newContent) {
            const { useGovernanceStore } = await import('@/stores/governanceStore')
            const serverId = mutation.targetId
            if (serverId) {
              await useGovernanceStore().applyGovernanceMutation(serverId, mutation.id, mutation.type, JSON.parse(mutation.newContent))
            }
          }
        }
      }

      // Refresh mutations for the affected channel
      if (accepted > 0 && wire.channelId !== '__server__') {
        await messagesStore.loadMutationsForChannel(wire.channelId)
      }
    }
  } catch (e) {
    console.warn('[sync] save error:', e)
  }
}

// ── Respond to a want request ─────────────────────────────────────────────────

async function _onWant(peerId: string, wire: SyncWant): Promise<void> {
  if (!Array.isArray(wire.ids) || wire.ids.length === 0) return
  // _pushItems checks the peer shares wire.serverId; the Rust getters then
  // return only rows of wire.channelId in that server.
  await _pushItems(peerId, wire.sessionId, wire.serverId, wire.channelId, wire.table, wire.ids)
}
