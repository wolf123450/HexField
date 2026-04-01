import { defineStore } from 'pinia'
import { ref } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import { v7 as uuidv7 } from 'uuid'
import type { Server, ServerMember, Mutation } from '@/types/core'

export const useServersStore = defineStore('servers', () => {
  const servers         = ref<Record<string, Server>>({})
  const members         = ref<Record<string, Record<string, ServerMember>>>({})
  const joinedServerIds = ref<string[]>([])
  const activeServerId  = ref<string | null>(null)

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

  async function createServer(name: string, iconFile?: File): Promise<Server> {
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
    applyServerMutation,
  }
})
