import { defineStore } from 'pinia'
import { ref } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import { v7 as uuidv7 } from 'uuid'
import type { Server, ServerMember, Mutation, ServerManifest } from '@/types/core'

const INVITE_TOKEN_TTL_MS = 3_600_000 // 1 hour

export const useServersStore = defineStore('servers', () => {
  const servers         = ref<Record<string, Server>>({})
  const members         = ref<Record<string, Record<string, ServerMember>>>({})
  const joinedServerIds = ref<string[]>([])
  const activeServerId  = ref<string | null>(null)
  // invite token → { serverId, expiresAt }
  const activeInviteTokens = ref<Map<string, { serverId: string; expiresAt: number }>>(new Map())

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
        user_id:        selfMember.userId,
        server_id:      selfMember.serverId,
        display_name:   selfMember.displayName,
        roles:          JSON.stringify(selfMember.roles),
        joined_at:      selfMember.joinedAt,
        public_sign_key: selfMember.publicSignKey,
        public_dh_key:  selfMember.publicDHKey,
        online_status:  selfMember.onlineStatus,
      },
    })
    if (!members.value[server.id]) members.value[server.id] = {}
    members.value[server.id][selfMember.userId] = selfMember

    return server
  }

  async function fetchMembers(serverId: string) {
    const rows = await invoke<any[]>('db_load_members', { serverId })
    const map: Record<string, ServerMember> = {}
    for (const r of rows) {
      map[r.user_id] = {
        userId:       r.user_id,
        serverId:     r.server_id,
        displayName:  r.display_name,
        roles:        r.roles ? JSON.parse(r.roles) : [],
        joinedAt:     r.joined_at,
        publicSignKey: r.public_sign_key,
        publicDHKey:   r.public_dh_key,
        onlineStatus:  r.online_status as any,
      }
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
   * Generate and store a short-lived invite token for the given server.
   * Tokens expire after 1 hour in-memory (no persistence needed).
   */
  function createInviteToken(serverId: string): string {
    const token = uuidv7()
    activeInviteTokens.value.set(token, {
      serverId,
      expiresAt: Date.now() + INVITE_TOKEN_TTL_MS,
    })
    return token
  }

  /**
   * Returns true if the token is valid and matches the expected serverId.
   * Does NOT consume the token (a single invite may be used by multiple peers).
   */
  function validateInviteToken(token: string, serverId: string): boolean {
    const entry = activeInviteTokens.value.get(token)
    if (!entry) return false
    if (entry.serverId !== serverId) return false
    if (entry.expiresAt < Date.now()) {
      activeInviteTokens.value.delete(token)
      return false
    }
    return true
  }

  return {
    servers,
    members,
    joinedServerIds,
    activeServerId,
    loadServers,
    createServer,
    fetchMembers,
    setActiveServer,
    updateMemberStatus,
    updateMemberDisplayName,
    applyServerMutation,
    joinFromManifest,
    createInviteToken,
    validateInviteToken,
  }
})
