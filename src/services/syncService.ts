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
import type { MessageRow, MutationRow } from '@/types/core'

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
  try {
    const channelIds: string[] = await invoke('sync_list_channels')

    // Pass 0: messages per channel; Pass 1: mutations per channel
    for (const channelId of channelIds) {
      await _startNegSession(peerId, channelId, 'messages')
      await _startNegSession(peerId, channelId, 'mutations')
    }

    // Pass 2: server-level mutations (channel_id = '__server__')
    await _startNegSession(peerId, '__server__', 'mutations')
  } catch (e) {
    console.warn('[sync] startSync error:', e)
  }
}

async function _startNegSession(
  peerId: string,
  channelId: string,
  table: SyncTable,
): Promise<void> {
  try {
    const msg: string = await invoke('sync_initiate', { channelId, table })
    const sessionId = `${Date.now()}-${Math.random().toString(36).slice(2)}`
    _pendingSessions.set(sessionId, { channelId, table })
    _sendToPeer(peerId, { type: 'sync_neg_init', sessionId, channelId, table, msg } satisfies SyncNegInit)
  } catch (e) {
    console.warn(`[sync] initiate failed for ${channelId}/${table}:`, e)
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
    console.warn('[sync] sync_respond error:', e)
  }
}

// ── Initiator: received responder's negentropy reply ─────────────────────────

async function _onNegReply(peerId: string, wire: SyncNegReply): Promise<void> {
  const session = _pendingSessions.get(wire.sessionId)
  if (!session) {
    console.warn('[sync] received neg_reply for unknown session', wire.sessionId)
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
    console.warn('[sync] process_response error:', e)
  }
}

// ── Push content to peer ──────────────────────────────────────────────────────

// WebRTC data channels (SCTP) have a ~65 KB max message size.  A naive push of
// a large channel history easily exceeds this.  Send in fixed-size batches so
// every individual frame stays well under the limit.
const SYNC_PUSH_CHUNK_SIZE = 50

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
      for (let i = 0; i < messages.length; i += SYNC_PUSH_CHUNK_SIZE) {
        const chunk = messages.slice(i, i + SYNC_PUSH_CHUNK_SIZE)
        _sendToPeer(peerId, { type: 'sync_push', sessionId, table, channelId, messages: chunk } satisfies SyncPush)
      }
    } else {
      const mutations: MutationRow[] = await invoke('sync_get_mutations', { ids })
      for (let i = 0; i < mutations.length; i += SYNC_PUSH_CHUNK_SIZE) {
        const chunk = mutations.slice(i, i + SYNC_PUSH_CHUNK_SIZE)
        _sendToPeer(peerId, { type: 'sync_push', sessionId, table, channelId, mutations: chunk } satisfies SyncPush)
      }
    }
  } catch (e) {
    console.warn('[sync] push error:', e)
  }
}

// ── Receive pushed content ────────────────────────────────────────────────────

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
    }
  } catch (e) {
    console.warn('[sync] save error:', e)
  }
}

// ── Respond to a want request ─────────────────────────────────────────────────

async function _onWant(peerId: string, wire: SyncWant): Promise<void> {
  await _pushItems(peerId, wire.sessionId, wire.channelId, wire.table, wire.ids)
}
