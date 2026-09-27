/**
 * mutationAuth — sign mutations at creation and authorize them on receive
 * (spec 08 §5). One helper serves both receive paths: the live `mutation`
 * data-channel message (`networkStore.handleMutationMessage`) and history
 * sync (`syncService._onPush`, mutations branch).
 *
 * A mutation is applied only when `authorizeMutation` returns `ok`. Unsigned
 * mutations are rejected outright; there is no compatibility path.
 */

import { invoke } from '@tauri-apps/api/core'
import type { Mutation, MutationRow } from '@/types/core'
import { cryptoService } from './cryptoService'

/** Version tag inside the signed payload, so the signed field set can change later. */
export const MUTATION_SIG_VERSION = 1

/** Mutations whose `targetId` is a chat message. */
const MESSAGE_TARGET_TYPES = new Set(['edit', 'delete', 'reaction_add', 'reaction_remove'])

/** `channelId` values that are not a real channel (server-scope / no channel). */
function isPseudoChannel(channelId: string): boolean {
  return channelId === '__server__' || channelId === ''
}

/**
 * The exact object that is signed. Absent optional fields are `null` (never
 * `undefined`), so a mutation from the wire (key absent), from a DB row (`null`)
 * and from local creation (`undefined`) all canonicalize to the same string.
 * `verified` and `sig` are local/transport fields and are not signed.
 */
export function mutationSigningPayload(m: Mutation): Record<string, unknown> {
  return {
    v:          MUTATION_SIG_VERSION,
    id:         m.id,
    type:       m.type,
    targetId:   m.targetId,
    channelId:  m.channelId,
    authorId:   m.authorId,
    newContent: m.newContent ?? null,
    emojiId:    m.emojiId ?? null,
    logicalTs:  m.logicalTs,
    createdAt:  m.createdAt,
  }
}

/** Sign a locally-authored mutation with the identity key held by `cryptoService`. */
export function signMutation(m: Omit<Mutation, 'sig' | 'verified'>): Mutation {
  const unsigned: Mutation = { ...m, verified: true }
  const { __sig } = cryptoService.signJson(mutationSigningPayload(unsigned))
  return { ...unsigned, sig: __sig }
}

/** True when `m.sig` is a valid signature over `m` by `publicSignKey`. */
export function verifyMutationSignature(m: Mutation, publicSignKey: string): boolean {
  if (!m.sig || !publicSignKey) return false
  // `__pub` is the key we already trust for the author — never one sent by the peer.
  const signed = { ...mutationSigningPayload(m), __sig: m.sig, __pub: publicSignKey }
  return cryptoService.verifyJsonSignature(signed) === publicSignKey
}

// ── Row / wire conversion ────────────────────────────────────────────────────

export function mutationToRow(m: Mutation): MutationRow {
  return {
    id:          m.id,
    type:        m.type,
    target_id:   m.targetId,
    channel_id:  m.channelId,
    author_id:   m.authorId,
    new_content: m.newContent ?? null,
    emoji_id:    m.emojiId ?? null,
    logical_ts:  m.logicalTs,
    created_at:  m.createdAt,
    verified:    m.verified,
    sig:         m.sig ?? null,
  }
}

/** Raw wire object → Mutation. `verified` is always false until authorized. */
export function wireToUnverifiedMutation(raw: Record<string, unknown>): Mutation {
  const str = (v: unknown) => (typeof v === 'string' ? v : undefined)
  return {
    id:         str(raw.id) ?? '',
    type:       (str(raw.type) ?? '') as Mutation['type'],
    targetId:   str(raw.targetId) ?? '',
    channelId:  str(raw.channelId) ?? '',
    authorId:   str(raw.authorId) ?? '',
    newContent: str(raw.newContent),
    emojiId:    str(raw.emojiId),
    logicalTs:  str(raw.logicalTs) ?? '',
    createdAt:  str(raw.createdAt) ?? '',
    verified:   false,
    sig:        str(raw.sig),
  }
}

/** Wire form of a mutation (no local-only `verified` flag). */
export function serializeMutation(m: Mutation): Record<string, unknown> {
  return {
    id: m.id, type: m.type, targetId: m.targetId,
    channelId: m.channelId, authorId: m.authorId,
    newContent: m.newContent, emojiId: m.emojiId,
    logicalTs: m.logicalTs, createdAt: m.createdAt, sig: m.sig,
  }
}

// ── Authorization ────────────────────────────────────────────────────────────

export interface TargetMessage {
  authorId:  string
  channelId: string
  serverId:  string
}

/** Local lookups the checks need; injectable for tests. */
export interface MutationAuthDeps {
  /** Known Ed25519 identity keys for a user (own identity, member records). */
  knownSignKeys(userId: string): Promise<string[]>
  /** The target chat message, or null when it is not in our DB. */
  getMessage(messageId: string): Promise<TargetMessage | null>
  /** Server a channel belongs to, or null when the channel is unknown. */
  channelServerId(channelId: string): Promise<string | null>
  /** Owner of a server, or null when the server is unknown. */
  serverOwnerId(serverId: string): Promise<string | null>
  /** True when the user holds the `admin` or `owner` role in the server. */
  isServerAdmin(userId: string, serverId: string): Promise<boolean>
}

export interface MutationAuthContext {
  /** Live path: the peer the mutation arrived from. Must equal `authorId`. */
  senderId?: string
  /** Live path: the `serverId` stated on the wire message. */
  serverId?: string
}

export type MutationAuthResult =
  | { ok: true;  mutation: Mutation }
  | { ok: false; reason: string }

function reject(reason: string): MutationAuthResult {
  return { ok: false, reason }
}

/**
 * Check a received mutation. On success the returned copy has `verified: true`.
 *
 * Rules (spec 08 §5):
 * - `sig` must be present and valid under a key we already know for `authorId`.
 *   Exception: `member_join` introduces the key, so a self-join is verified with
 *   the key in its payload — but only if that key matches any key already known.
 * - Live path: the sending peer must be the author, and a real `channelId` must
 *   belong to the wire's `serverId`.
 * - edit / delete / reactions: the target message must be in our DB and in the
 *   mutation's channel (and the wire's server). Edit: author owns the message.
 *   Delete: author owns it, or is admin/owner of its server.
 *   An unknown target is dropped, not held: it is not persisted, so negentropy
 *   offers it again on the next sync, after the message has arrived.
 * - member_join: author === target === payload.userId; roles other than `member`
 *   only for the server owner.
 * - member_profile_update: author === target.
 * - Server / role / channel / moderation / emoji / voice / governance mutations:
 *   signature only for now — no per-author permission check (docs/TODO.md).
 */
export async function authorizeMutation(
  m: Mutation,
  ctx: MutationAuthContext = {},
  deps: MutationAuthDeps = defaultDeps,
): Promise<MutationAuthResult> {
  if (!m.id || !m.type || !m.targetId || !m.authorId || !m.logicalTs || !m.createdAt) {
    return reject('missing required field')
  }
  if (typeof m.channelId !== 'string') return reject('missing channelId')
  if (!m.sig) return reject('unsigned')

  if (ctx.senderId !== undefined && ctx.senderId !== m.authorId) {
    return reject('sender is not the author')
  }

  if (ctx.serverId !== undefined && !isPseudoChannel(m.channelId)) {
    const sid = await deps.channelServerId(m.channelId)
    if (sid !== ctx.serverId) return reject('channel does not belong to server')
  }

  // ── Signature ────────────────────────────────────────────────────────────
  const known = await deps.knownSignKeys(m.authorId)
  if (m.type === 'member_join') {
    const res = await checkMemberJoin(m, known, ctx, deps)
    if (res) return res
  } else {
    if (known.length === 0) return reject('unknown author key')
    if (!known.some(k => verifyMutationSignature(m, k))) return reject('bad signature')
  }

  // ── Per-type authorship ──────────────────────────────────────────────────
  if (MESSAGE_TARGET_TYPES.has(m.type)) {
    const target = await deps.getMessage(m.targetId)
    if (!target) return reject('unknown target message')
    if (target.channelId !== m.channelId) return reject('target is in another channel')
    if (ctx.serverId !== undefined && target.serverId !== ctx.serverId) {
      return reject('target is in another server')
    }
    if (m.type === 'edit' && target.authorId !== m.authorId) {
      return reject('edit of another user\'s message')
    }
    if (m.type === 'delete' && target.authorId !== m.authorId &&
        !(await deps.isServerAdmin(m.authorId, target.serverId))) {
      return reject('delete of another user\'s message by non-admin')
    }
    if ((m.type === 'reaction_add' || m.type === 'reaction_remove') && !m.emojiId) {
      return reject('reaction without emoji')
    }
  }

  if (m.type === 'member_profile_update' && m.targetId !== m.authorId) {
    return reject('profile update for another user')
  }

  return { ok: true, mutation: { ...m, verified: true } }
}

async function checkMemberJoin(
  m: Mutation,
  known: string[],
  ctx: MutationAuthContext,
  deps: MutationAuthDeps,
): Promise<MutationAuthResult | null> {
  if (m.targetId !== m.authorId) return reject('member_join for another user')
  let payload: { userId?: unknown; serverId?: unknown; publicSignKey?: unknown; roles?: unknown }
  try {
    payload = JSON.parse(m.newContent ?? '')
  } catch {
    return reject('member_join payload is not JSON')
  }
  if (!payload || typeof payload !== 'object') return reject('member_join payload is not an object')
  if (payload.userId !== m.authorId) return reject('member_join userId mismatch')
  if (typeof payload.serverId !== 'string' || !payload.serverId) return reject('member_join without serverId')
  if (ctx.serverId !== undefined && payload.serverId !== ctx.serverId) return reject('member_join for another server')
  const introducedKey = payload.publicSignKey
  if (typeof introducedKey !== 'string' || !introducedKey) return reject('member_join without publicSignKey')
  // Key replacement: a join may not introduce a different key for a user we already know.
  if (known.length > 0 && !known.includes(introducedKey)) return reject('member_join key conflicts with known key')
  if (!verifyMutationSignature(m, introducedKey)) return reject('bad signature')

  const roles = Array.isArray(payload.roles) ? payload.roles : []
  if (roles.some(r => r !== 'member')) {
    const owner = await deps.serverOwnerId(payload.serverId)
    if (!owner || owner !== m.authorId) return reject('member_join claims elevated roles')
  }
  return null
}

// ── Default (store/DB-backed) lookups ────────────────────────────────────────

export const defaultDeps: MutationAuthDeps = {
  async knownSignKeys(userId) {
    const { useIdentityStore } = await import('@/stores/identityStore')
    const identity = useIdentityStore()
    // Our own mutations must carry our own identity key and nothing else.
    if (identity.userId && userId === identity.userId) {
      return identity.publicSignKey ? [identity.publicSignKey] : []
    }
    const keys = new Set<string>()
    const { useServersStore } = await import('@/stores/serversStore')
    for (const byUser of Object.values(useServersStore().members)) {
      const k = byUser[userId]?.publicSignKey
      if (k) keys.add(k)
    }
    const fromDb = await invoke<string[]>('db_get_member_sign_keys', { userId }).catch(() => [])
    for (const k of fromDb ?? []) if (k) keys.add(k)
    return [...keys]
  },

  async getMessage(messageId) {
    const rows = await invoke<Array<{ author_id: string; channel_id: string; server_id: string }>>(
      'sync_get_messages', { ids: [messageId] },
    ).catch(() => [])
    const r = rows?.[0]
    return r ? { authorId: r.author_id, channelId: r.channel_id, serverId: r.server_id } : null
  },

  async channelServerId(channelId) {
    const { useChannelsStore } = await import('@/stores/channelsStore')
    for (const [serverId, list] of Object.entries(useChannelsStore().channels)) {
      if (list.some(c => c.id === channelId)) return serverId
    }
    return (await invoke<string | null>('db_get_channel_server', { channelId }).catch(() => null)) ?? null
  },

  async serverOwnerId(serverId) {
    const { useServersStore } = await import('@/stores/serversStore')
    return useServersStore().servers[serverId]?.ownerId ?? null
  },

  async isServerAdmin(userId, serverId) {
    const { useServersStore } = await import('@/stores/serversStore')
    const serversStore = useServersStore()
    if (serversStore.servers[serverId]?.ownerId === userId) return true
    if (!serversStore.members[serverId]) await serversStore.fetchMembers(serverId).catch(() => {})
    return serversStore.members[serverId]?.[userId]?.roles.some(r => r === 'admin' || r === 'owner') ?? false
  },
}
