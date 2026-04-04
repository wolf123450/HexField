import { defineStore } from 'pinia'
import { ref } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import { v7 as uuidv7 } from 'uuid'
import type { Server, ServerMember, Mutation, ServerManifest } from '@/types/core'

export interface InviteCode {
  code: string
  serverId: string
  createdBy: string
  maxUses: number | null
  useCount: number
  expiresAt: string | null  // ISO-8601 or null
  createdAt: string
}

export interface BanRecord {
  serverId:  string
  userId:    string
  bannedBy:  string
  reason:    string | null
  bannedAt:  string
  expiresAt: string | null
}

export const useServersStore = defineStore('servers', () => {
  const servers         = ref<Record<string, Server>>({})
  const members         = ref<Record<string, Record<string, ServerMember>>>({})
  const joinedServerIds = ref<string[]>([])
  const activeServerId  = ref<string | null>(null)
  // invite codes: code → InviteCode (DB-backed)
  const inviteCodes     = ref<Map<string, InviteCode>>(new Map())

  async function loadServers() {
    const rows = await invoke<any[]>('db_load_servers')
    for (const row of rows) {
      try {
        const parsed: Server = JSON.parse(row.raw_json)
        servers.value[parsed.id] = parsed
        if (!joinedServerIds.value.includes(parsed.id)) {
          joinedServerIds.value.push(parsed.id)
        }
      } catch {
        // raw_json malformed — skip
      }
    }
    // Load server avatars from key-value store
    for (const serverId of joinedServerIds.value) {
      const dataUrl = await invoke<string | null>('db_load_key', { keyId: `server_avatar_${serverId}` })
        .catch(() => null)
      if (dataUrl && servers.value[serverId]) {
        servers.value[serverId].avatarDataUrl = dataUrl
      }
    }
  }

  async function createServer(name: string, _iconFile?: File): Promise<Server> {
    const { useIdentityStore } = await import('./identityStore')
    const identityStore = useIdentityStore()

    const server: Server = {
      id:           uuidv7(),
      name,
      description:  undefined,
      iconUrl:      undefined,
      ownerId:      identityStore.userId!,
      memberCount:  1,
      createdAt:    new Date().toISOString(),
      inviteCode:   uuidv7().replace(/-/g, '').slice(0, 12),
      customEmoji:  [],
    }

    const row = {
      id:          server.id,
      name:        server.name,
      description: server.description ?? null,
      icon_url:    server.iconUrl ?? null,
      owner_id:    server.ownerId,
      invite_code: server.inviteCode ?? null,
      created_at:  server.createdAt,
      raw_json:    JSON.stringify(server),
    }
    await invoke('db_save_server', { server: row })
    servers.value[server.id] = server
    joinedServerIds.value.push(server.id)

    // Add self as admin member
    const selfMember: ServerMember = {
      userId:       identityStore.userId!,
      serverId:     server.id,
      displayName:  identityStore.displayName || 'Player',
      roles:        ['admin'],
      joinedAt:     server.createdAt,
      publicSignKey: identityStore.publicSignKey ?? '',
      publicDHKey:   identityStore.publicDHKey ?? '',
      onlineStatus:  'online',
    }
    await invoke('db_upsert_member', {
      member: {
        user_id:         selfMember.userId,
        server_id:       selfMember.serverId,
        display_name:    selfMember.displayName,
        roles:           JSON.stringify(selfMember.roles),
        joined_at:       selfMember.joinedAt,
        public_sign_key: selfMember.publicSignKey,
        public_dh_key:   selfMember.publicDHKey,
        online_status:   selfMember.onlineStatus,
        avatar_data_url: identityStore.avatarDataUrl ?? null,
      },
    })
    if (!members.value[server.id]) members.value[server.id] = {}
    members.value[server.id][selfMember.userId] = selfMember

    return server
  }

  async function fetchMembers(serverId: string) {
    const rows = await invoke<any[]>('db_load_members', { serverId })
    const existing = members.value[serverId] ?? {}
    const { useIdentityStore } = await import('./identityStore')
    const identityStore = useIdentityStore()
    const uid = identityStore.userId
    const statusKey = uid ? `gamechat_own_status_${uid}` : 'gamechat_own_status'
    const ownStatus = (localStorage.getItem(statusKey) as 'online' | 'idle' | 'dnd' | 'offline' | null) ?? 'online'
    const map: Record<string, ServerMember> = {}
    for (const r of rows) {
      // Remote members (anyone who is not us) start as 'offline' on load.
      // Their live status arrives via presence_update / heartbeat once they connect.
      // Own record uses the current locally-stored status.
      const onlineStatus: ServerMember['onlineStatus'] =
        r.user_id === uid ? ownStatus : 'offline'
      map[r.user_id] = {
        userId:       r.user_id,
        serverId:     r.server_id,
        displayName:  r.display_name,
        roles:        r.roles ? JSON.parse(r.roles) : [],
        joinedAt:     r.joined_at,
        publicSignKey: r.public_sign_key,
        publicDHKey:   r.public_dh_key,
        onlineStatus,
        // Prefer DB-persisted avatar; fall back to any in-memory gossip value not yet flushed.
        avatarDataUrl: r.avatar_data_url ?? existing[r.user_id]?.avatarDataUrl,
        bio:           existing[r.user_id]?.bio,
        bannerColor:   existing[r.user_id]?.bannerColor,
        bannerDataUrl: existing[r.user_id]?.bannerDataUrl,
      }
    }
    // Hydrate own member record with current identity data (source of truth for name/avatar).
    if (uid && map[uid]) {
      map[uid].displayName   = identityStore.displayName
      map[uid].avatarDataUrl = identityStore.avatarDataUrl
    }
    members.value[serverId] = map
  }

  function setActiveServer(serverId: string | null) {
    activeServerId.value = serverId
  }

  function updateMemberStatus(serverId: string, userId: string, status: ServerMember['onlineStatus']) {
    if (members.value[serverId]?.[userId]) {
      members.value[serverId][userId].onlineStatus = status
    }
  }

  function updateMemberDisplayName(serverId: string, userId: string, displayName: string) {
    if (members.value[serverId]?.[userId]) {
      members.value[serverId][userId].displayName = displayName
    }
  }

  function updateMemberProfile(
    serverId: string,
    userId: string,
    payload: {
      displayName?: string
      avatarDataUrl?: string | null
      bio?: string | null
      bannerColor?: string | null
      bannerDataUrl?: string | null
    },
  ) {
    const m = members.value[serverId]?.[userId]
    if (!m) return
    if (payload.displayName   !== undefined) m.displayName   = payload.displayName
    if (payload.avatarDataUrl !== undefined) m.avatarDataUrl = payload.avatarDataUrl
    if (payload.bio           !== undefined) m.bio           = payload.bio
    if (payload.bannerColor   !== undefined) m.bannerColor   = payload.bannerColor
    if (payload.bannerDataUrl !== undefined) m.bannerDataUrl = payload.bannerDataUrl
  }

  async function updateServerAvatar(serverId: string, dataUrl: string | null) {
    if (servers.value[serverId]) {
      servers.value[serverId].avatarDataUrl = dataUrl
    }
    await invoke('db_save_key', {
      keyId:   `server_avatar_${serverId}`,
      keyType: 'server_avatar',
      keyData: dataUrl ?? '',
    })
  }

  function applyServerMutation(mutation: Mutation) {
    if (mutation.type === 'server_update' && mutation.newContent) {
      const patch = JSON.parse(mutation.newContent)
      const server = servers.value[mutation.targetId]
      if (server) {
        Object.assign(server, patch)
      }
    } else if (mutation.type === 'role_assign' && mutation.newContent) {
      const { roleName, serverId } = JSON.parse(mutation.newContent)
      const member = members.value[serverId]?.[mutation.targetId]
      if (member && !member.roles.includes(roleName)) {
        member.roles = [...member.roles, roleName]
      }
    } else if (mutation.type === 'role_revoke' && mutation.newContent) {
      const { roleName, serverId } = JSON.parse(mutation.newContent)
      const member = members.value[serverId]?.[mutation.targetId]
      if (member) {
        member.roles = member.roles.filter(r => r !== roleName)
      }
    } else if (mutation.type === 'member_kick' && mutation.newContent) {
      const { serverId } = JSON.parse(mutation.newContent)
      if (serverId && members.value[serverId]) {
        delete members.value[serverId][mutation.targetId]
      }
    } else if (mutation.type === 'member_ban' && mutation.newContent) {
      const { serverId, reason, expiresAt } = JSON.parse(mutation.newContent)
      if (serverId && members.value[serverId]) {
        delete members.value[serverId][mutation.targetId]
      }
      // Persist ban locally
      invoke('db_save_ban', {
        ban: {
          server_id:  serverId,
          user_id:    mutation.targetId,
          banned_by:  mutation.authorId,
          reason:     reason ?? null,
          banned_at:  mutation.createdAt,
          expires_at: expiresAt ?? null,
        },
      }).catch(() => {})
    } else if (mutation.type === 'member_unban' && mutation.newContent) {
      const { serverId } = JSON.parse(mutation.newContent)
      if (serverId) {
        invoke('db_delete_ban', { serverId, userId: mutation.targetId }).catch(() => {})
      }
    }
  }

  /** Exported interface for the bans list — defined at module level above. */

  async function loadBans(serverId: string): Promise<BanRecord[]> {
    const rows = await invoke<Array<{
      server_id: string; user_id: string; banned_by: string
      reason: string | null; banned_at: string; expires_at: string | null
    }>>('db_load_bans', { serverId })
    return rows.map(r => ({
      serverId:  r.server_id,
      userId:    r.user_id,
      bannedBy:  r.banned_by,
      reason:    r.reason,
      bannedAt:  r.banned_at,
      expiresAt: r.expires_at,
    }))
  }

  async function isBanned(serverId: string, userId: string): Promise<boolean> {
    return invoke<boolean>('db_is_banned', { serverId, userId })
  }

  /**
   * Kick a member from the server (session-level, non-persistent).
   * Broadcasts mutation, writes mod log, closes their WebRTC connection.
   */
  async function kickMember(serverId: string, targetId: string, reason: string): Promise<void> {
    const { useIdentityStore } = await import('./identityStore')
    const identity = useIdentityStore()
    const myId = identity.userId!

    const mutation: Mutation = {
      id:         uuidv7(),
      type:       'member_kick',
      targetId,
      channelId:  '__server__',
      authorId:   myId,
      newContent: JSON.stringify({ serverId, reason }),
      logicalTs:  new Date().toISOString(),
      createdAt:  new Date().toISOString(),
      verified:   true,
    }

    // Apply locally
    applyServerMutation(mutation)
    // Log
    await logModAction(serverId, 'kick', targetId, reason || undefined)
    // Broadcast
    const { useNetworkStore } = await import('./networkStore')
    useNetworkStore().broadcast({ type: 'mutation', serverId, mutation: serializeMutation(mutation) })
    // Destroy WebRTC connection so they can't keep sending
    const { webrtcService } = await import('@/services/webrtcService')
    webrtcService.destroyPeer(targetId)
  }

  /**
   * Ban a member (persistent; blocks rejoin).
   * Also fires a co-incident kick so they are removed from the session immediately.
   */
  async function banMember(
    serverId: string,
    targetId: string,
    reason: string,
    expiresAt: string | null,
  ): Promise<void> {
    const { useIdentityStore } = await import('./identityStore')
    const identity = useIdentityStore()
    const myId = identity.userId!

    const mutation: Mutation = {
      id:         uuidv7(),
      type:       'member_ban',
      targetId,
      channelId:  '__server__',
      authorId:   myId,
      newContent: JSON.stringify({ serverId, reason, expiresAt }),
      logicalTs:  new Date().toISOString(),
      createdAt:  new Date().toISOString(),
      verified:   true,
    }

    applyServerMutation(mutation)
    await logModAction(serverId, 'ban', targetId, reason || undefined,
      expiresAt ? JSON.stringify({ expiresAt }) : undefined)

    const { useNetworkStore } = await import('./networkStore')
    useNetworkStore().broadcast({ type: 'mutation', serverId, mutation: serializeMutation(mutation) })

    const { webrtcService } = await import('@/services/webrtcService')
    webrtcService.destroyPeer(targetId)
  }

  /** Unban a member — removes from DB and lets them rejoin. */
  async function unbanMember(serverId: string, targetId: string): Promise<void> {
    const { useIdentityStore } = await import('./identityStore')
    const identity = useIdentityStore()
    const myId = identity.userId!

    const mutation: Mutation = {
      id:         uuidv7(),
      type:       'member_unban',
      targetId,
      channelId:  '__server__',
      authorId:   myId,
      newContent: JSON.stringify({ serverId }),
      logicalTs:  new Date().toISOString(),
      createdAt:  new Date().toISOString(),
      verified:   true,
    }

    applyServerMutation(mutation)
    await logModAction(serverId, 'unban', targetId)

    const { useNetworkStore } = await import('./networkStore')
    useNetworkStore().broadcast({ type: 'mutation', serverId, mutation: serializeMutation(mutation) })
  }

  /** Serialize a Mutation to the wire-safe subset (no internal fields). */
  function serializeMutation(m: Mutation) {
    return {
      id: m.id, type: m.type, targetId: m.targetId,
      channelId: m.channelId, authorId: m.authorId,
      newContent: m.newContent, logicalTs: m.logicalTs, createdAt: m.createdAt,
    }
  }

  /**
   * Kick a user from a specific voice channel (server membership unaffected).
   * Only admins/owners should call this.
   */
  async function kickFromVoice(serverId: string, targetId: string, channelId: string, reason: string): Promise<void> {
    const { useIdentityStore } = await import('./identityStore')
    const identity = useIdentityStore()
    const myId = identity.userId!

    const mutation: Mutation = {
      id:         uuidv7(),
      type:       'voice_kick',
      targetId,
      channelId,
      authorId:   myId,
      newContent: JSON.stringify({ channelId, reason }),
      logicalTs:  new Date().toISOString(),
      createdAt:  new Date().toISOString(),
      verified:   true,
    }

    // Log before broadcast
    await logModAction(serverId, 'voice_kick', targetId, reason || undefined,
      JSON.stringify({ channelId }))

    const { useNetworkStore } = await import('./networkStore')
    useNetworkStore().broadcast({ type: 'mutation', serverId, mutation: serializeMutation(mutation) })
  }

  async function voiceMuteMember(serverId: string, targetId: string, reason: string): Promise<void> {
    const { useIdentityStore } = await import('./identityStore')
    const myId = useIdentityStore().userId!

    const mutation: Mutation = {
      id:         uuidv7(),
      type:       'voice_mute',
      targetId,
      channelId:  '',
      authorId:   myId,
      newContent: JSON.stringify({ reason }),
      logicalTs:  new Date().toISOString(),
      createdAt:  new Date().toISOString(),
      verified:   true,
    }

    await logModAction(serverId, 'voice_mute', targetId, reason || undefined)

    const { useNetworkStore } = await import('./networkStore')
    useNetworkStore().broadcast({ type: 'mutation', serverId, mutation: serializeMutation(mutation) })
  }

  async function voiceUnmuteMember(serverId: string, targetId: string): Promise<void> {
    const { useIdentityStore } = await import('./identityStore')
    const myId = useIdentityStore().userId!

    const mutation: Mutation = {
      id:         uuidv7(),
      type:       'voice_unmute',
      targetId,
      channelId:  '',
      authorId:   myId,
      newContent: JSON.stringify({}),
      logicalTs:  new Date().toISOString(),
      createdAt:  new Date().toISOString(),
      verified:   true,
    }

    await logModAction(serverId, 'voice_unmute', targetId)

    const { useNetworkStore } = await import('./networkStore')
    useNetworkStore().broadcast({ type: 'mutation', serverId, mutation: serializeMutation(mutation) })
  }

  async function updateChannelAcl(serverId: string, acl: import('@/types/core').ChannelACL): Promise<void> {
    const { useIdentityStore } = await import('./identityStore')
    const myId = useIdentityStore().userId!

    const mutation: Mutation = {
      id:         uuidv7(),
      type:       'channel_acl_update',
      targetId:   acl.channelId,
      channelId:  acl.channelId,
      authorId:   myId,
      newContent: JSON.stringify(acl),
      logicalTs:  new Date().toISOString(),
      createdAt:  new Date().toISOString(),
      verified:   true,
    }

    // Apply locally first
    const { useChannelsStore } = await import('./channelsStore')
    await useChannelsStore().persistAndSetAcl(acl)

    const { useNetworkStore: useNet2 } = await import('./networkStore')
    useNet2().broadcast({ type: 'mutation', serverId, mutation: serializeMutation(mutation) })
  }

  /**
   * Bootstrap a server locally from a self-contained ServerManifest decoded
   * from an invite link.  Idempotent — calling it again for the same server
   * just ensures membership is up-to-date.
   */
  async function joinFromManifest(manifest: ServerManifest): Promise<Server> {
    const { useIdentityStore } = await import('./identityStore')
    const { useChannelsStore }  = await import('./channelsStore')
    const identityStore = useIdentityStore()
    const channelsStore = useChannelsStore()

    const server = manifest.server

    // Persist server (INSERT OR REPLACE is idempotent)
    await invoke('db_save_server', {
      server: {
        id:          server.id,
        name:        server.name,
        description: server.description ?? null,
        icon_url:    server.iconUrl ?? null,
        owner_id:    server.ownerId,
        invite_code: server.inviteCode ?? null,
        created_at:  server.createdAt,
        raw_json:    JSON.stringify(server),
      },
    })
    servers.value[server.id] = server
    if (!joinedServerIds.value.includes(server.id)) {
      joinedServerIds.value.push(server.id)
    }

    // Persist channels
    for (const ch of manifest.channels) {
      await invoke('db_save_channel', {
        channel: {
          id:         ch.id,
          server_id:  ch.serverId,
          name:       ch.name,
          type:       ch.type,
          position:   ch.position,
          topic:      ch.topic ?? null,
          created_at: new Date().toISOString(),
        },
      })
    }
    await channelsStore.loadChannels(server.id)

    // Persist owner as admin member
    if (manifest.owner?.userId) {
      await invoke('db_upsert_member', {
        member: {
          user_id:         manifest.owner.userId,
          server_id:       server.id,
          display_name:    manifest.owner.displayName,
          roles:           JSON.stringify(['admin']),
          joined_at:       server.createdAt,
          public_sign_key: manifest.owner.publicSignKey,
          public_dh_key:   manifest.owner.publicDHKey,
          online_status:   'offline',
        },
      })
    }

    // Persist self as member (unless we are the owner)
    const uid = identityStore.userId
    if (uid && uid !== manifest.owner?.userId) {
      const selfMember: ServerMember = {
        userId:        uid,
        serverId:      server.id,
        displayName:   identityStore.displayName || 'Player',
        roles:         ['member'],
        joinedAt:      new Date().toISOString(),
        publicSignKey: identityStore.publicSignKey ?? '',
        publicDHKey:   identityStore.publicDHKey ?? '',
        onlineStatus:  'online',
      }
      await invoke('db_upsert_member', {
        member: {
          user_id:         selfMember.userId,
          server_id:       selfMember.serverId,
          display_name:    selfMember.displayName,
          roles:           JSON.stringify(selfMember.roles),
          joined_at:       selfMember.joinedAt,
          public_sign_key: selfMember.publicSignKey,
          public_dh_key:   selfMember.publicDHKey,
          online_status:   selfMember.onlineStatus,
        },
      })
    }

    await fetchMembers(server.id)
    return server
  }

  /**
   * Upsert a single member by identity. Safe to call with data from a remote peer.
   * Only accepts members for servers this instance already knows about.
   */
  async function upsertMember(m: {
    userId: string
    serverId: string
    displayName: string
    publicSignKey: string
    publicDHKey: string
    roles: string[]
    joinedAt: string
    onlineStatus: string
    avatarDataUrl?: string
  }) {
    if (!servers.value[m.serverId]) return // Unknown server — reject silently
    await invoke('db_upsert_member', {
      member: {
        user_id:          m.userId,
        server_id:        m.serverId,
        display_name:     m.displayName,
        roles:            JSON.stringify(m.roles),
        joined_at:        m.joinedAt,
        public_sign_key:  m.publicSignKey,
        public_dh_key:    m.publicDHKey,
        online_status:    m.onlineStatus,
        avatar_data_url:  m.avatarDataUrl ?? null,
      },
    })
    if (!members.value[m.serverId]) members.value[m.serverId] = {}
    // Preserve existing avatarDataUrl if caller didn't supply a new one
    const existingAvatar = members.value[m.serverId][m.userId]?.avatarDataUrl
    members.value[m.serverId][m.userId] = {
      userId:        m.userId,
      serverId:      m.serverId,
      displayName:   m.displayName,
      publicSignKey: m.publicSignKey,
      publicDHKey:   m.publicDHKey,
      roles:         m.roles,
      joinedAt:      m.joinedAt,
      onlineStatus:  m.onlineStatus as ServerMember['onlineStatus'],
      avatarDataUrl: m.avatarDataUrl ?? existingAvatar,
    }
  }

  /**
   * Load invite codes from DB for a given server into the in-memory map.
   * Call this on server select / modal open.
   */
  async function loadInviteCodes(serverId: string): Promise<InviteCode[]> {
    const rows = await invoke<Array<{
      code: string; server_id: string; created_by: string;
      max_uses: number | null; use_count: number;
      expires_at: string | null; created_at: string;
    }>>('db_load_invite_codes', { serverId })
    const codes: InviteCode[] = rows.map(r => ({
      code:      r.code,
      serverId:  r.server_id,
      createdBy: r.created_by,
      maxUses:   r.max_uses,
      useCount:  r.use_count,
      expiresAt: r.expires_at,
      createdAt: r.created_at,
    }))
    for (const c of codes) inviteCodes.value.set(c.code, c)
    return codes
  }

  /**
   * Generate a new invite token, persist to DB, and return the code string.
   * Options:
   *   expiresInMs — milliseconds from now; null = never expires
   *   maxUses     — positive int; null = unlimited
   */
  async function createInviteToken(
    serverId: string,
    options?: { expiresInMs?: number | null; maxUses?: number | null },
  ): Promise<string> {
    const { useIdentityStore } = await import('./identityStore')
    const identityStore = useIdentityStore()

    const code = uuidv7().replace(/-/g, '').slice(0, 16)
    const expiresIn = options?.expiresInMs !== undefined ? options.expiresInMs : 24 * 60 * 60 * 1000
    const expiresAt = expiresIn != null ? new Date(Date.now() + expiresIn).toISOString() : null
    const maxUses   = options?.maxUses ?? null

    const entry: InviteCode = {
      code,
      serverId,
      createdBy:  identityStore.userId ?? '',
      maxUses,
      useCount:   0,
      expiresAt,
      createdAt:  new Date().toISOString(),
    }
    await invoke('db_save_invite_code', {
      code: {
        code:       entry.code,
        server_id:  entry.serverId,
        created_by: entry.createdBy,
        max_uses:   entry.maxUses,
        use_count:  0,
        expires_at: entry.expiresAt,
        created_at: entry.createdAt,
      },
    })
    inviteCodes.value.set(code, entry)
    return code
  }

  /**
   * Validate an invite token. Checks expiry and max-uses.
   * Increments use_count in DB and in-memory on success.
   * Returns 'ok' | 'not_found' | 'invite_expired' | 'invite_exhausted'
   */
  async function validateInviteToken(
    token: string,
    serverId: string,
  ): Promise<'ok' | 'not_found' | 'invite_expired' | 'invite_exhausted'> {
    // Ensure loaded from DB for this server
    let entry = inviteCodes.value.get(token)
    if (!entry) {
      await loadInviteCodes(serverId)
      entry = inviteCodes.value.get(token)
    }
    if (!entry || entry.serverId !== serverId) return 'not_found'
    if (entry.expiresAt && new Date(entry.expiresAt).getTime() < Date.now()) return 'invite_expired'
    if (entry.maxUses !== null && entry.useCount >= entry.maxUses) return 'invite_exhausted'

    // Increment use count
    try {
      const newCount = await invoke<number>('db_increment_invite_use_count', { code: token })
      entry.useCount = newCount
    } catch {
      // Non-fatal if increment fails — validation still passed
    }
    return 'ok'
  }

  /** Revoke (delete) an invite code from DB and in-memory map. */
  async function revokeInviteCode(code: string): Promise<void> {
    await invoke('db_delete_invite_code', { code })
    inviteCodes.value.delete(code)
  }

  /**
   * Write an entry to the server's moderation audit log.
   * Call after performing any moderation action (kick, ban, voice mute, etc.)
   */
  async function logModAction(
    serverId: string,
    action: string,
    targetId: string,
    reason?: string,
    detail?: string,
  ): Promise<void> {
    const { useIdentityStore } = await import('./identityStore')
    const identity = useIdentityStore()
    await invoke('db_save_mod_log_entry', {
      entry: {
        id: uuidv7(),
        server_id: serverId,
        action,
        target_id: targetId,
        issued_by: identity.userId ?? '',
        reason: reason ?? null,
        detail: detail ?? null,
        created_at: new Date().toISOString(),
      },
    })
  }

  return {
    servers,
    members,
    joinedServerIds,
    activeServerId,
    inviteCodes,
    loadServers,
    createServer,
    fetchMembers,
    upsertMember,
    setActiveServer,
    updateMemberStatus,
    updateMemberDisplayName,
    updateMemberProfile,
    updateServerAvatar,
    applyServerMutation,
    joinFromManifest,
    loadInviteCodes,
    createInviteToken,
    validateInviteToken,
    revokeInviteCode,
    logModAction,
    kickMember,
    banMember,
    unbanMember,
    loadBans,
    isBanned,
    kickFromVoice,
    voiceMuteMember,
    voiceUnmuteMember,
    updateChannelAcl,
  }
})
