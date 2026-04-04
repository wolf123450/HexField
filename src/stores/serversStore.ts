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
    }
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
  }
})
