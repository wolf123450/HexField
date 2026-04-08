import { defineStore } from 'pinia'
import { ref } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import { v7 as uuidv7 } from 'uuid'
import type { Channel, ChannelACL, ChannelType, Mutation } from '@/types/core'
import { generateHLC } from '@/utils/hlc'

export const useChannelsStore = defineStore('channels', () => {
  const channels        = ref<Record<string, Channel[]>>({})  // keyed by serverId
  const activeChannelId = ref<string | null>(null)
  const channelAcls     = ref<Record<string, ChannelACL>>({}) // keyed by channelId

  async function loadChannels(serverId: string) {
    const rows = await invoke<any[]>('db_load_channels', { serverId })
    channels.value[serverId] = rows.map(r => ({
      id:            r.id,
      serverId:      r.server_id,
      name:          r.name,
      type:          r.type as ChannelType,
      position:      r.position,
      topic:         r.topic ?? undefined,
    }))
    await loadChannelAcls(serverId)
  }

  async function loadChannelAcls(serverId: string) {
    const rows = await invoke<any[]>('db_load_channel_acls', { serverId })
    for (const r of rows) {
      channelAcls.value[r.channel_id] = {
        channelId:      r.channel_id,
        allowedRoles:   JSON.parse(r.allowed_roles ?? '[]'),
        allowedUsers:   JSON.parse(r.allowed_users ?? '[]'),
        deniedUsers:    JSON.parse(r.denied_users  ?? '[]'),
        privateChannel: r.private_channel === true || r.private_channel === 1,
      }
    }
  }

  // ACL resolution: returns true if myUserId may access the channel.
  // Falls back to open if no ACL entry exists or myUserId is unknown.
  function isChannelVisible(channelId: string, myUserId: string | null, myRoles: string[]): boolean {
    if (!myUserId) return true
    const acl = channelAcls.value[channelId]
    if (!acl) return true

    const { deniedUsers = [], privateChannel = false, allowedUsers = [], allowedRoles = [] } = acl

    // Rule 1: explicitly denied
    if (deniedUsers.includes(myUserId)) return false
    // Rule 2: private — only allowed users
    if (privateChannel) return allowedUsers.includes(myUserId)
    // Rule 3: allowedUsers whitelist
    if (allowedUsers.length > 0 && allowedUsers.includes(myUserId)) return true
    // Rule 4: role gate
    if (allowedRoles.length > 0) return myRoles.some(r => allowedRoles.includes(r))
    // Rule 5: default open
    return true
  }

  async function persistAndSetAcl(acl: ChannelACL) {
    channelAcls.value[acl.channelId] = acl
    await invoke('db_upsert_channel_acl', {
      acl: {
        channel_id:      acl.channelId,
        allowed_roles:   JSON.stringify(acl.allowedRoles ?? []),
        allowed_users:   JSON.stringify(acl.allowedUsers ?? []),
        denied_users:    JSON.stringify(acl.deniedUsers  ?? []),
        private_channel: acl.privateChannel ?? false,
      },
    })
  }

  async function createChannel(serverId: string, name: string, type: ChannelType = 'text'): Promise<Channel> {
    const { useIdentityStore } = await import('./identityStore')
    const identityStore = useIdentityStore()
    const { useMessagesStore } = await import('./messagesStore')
    const messagesStore = useMessagesStore()

    const existing = channels.value[serverId] ?? []
    const channel: Channel = {
      id:       uuidv7(),
      serverId,
      name,
      type,
      position: existing.length,
    }

    const mutation: Mutation = {
      id:         uuidv7(),
      type:       'channel_create',
      targetId:   channel.id,
      channelId:  '__server__',
      authorId:   identityStore.userId!,
      newContent: JSON.stringify(channel),
      logicalTs:  generateHLC(),
      createdAt:  new Date().toISOString(),
      verified:   true,
    }

    // Persist mutation (Rust side effects create the channel row)
    await messagesStore.applyMutation(mutation)
    // Update in-memory state
    channels.value[serverId] = [...existing, channel]

    // Broadcast mutation to peers
    const { useNetworkStore } = await import('./networkStore')
    const { useServersStore } = await import('./serversStore')
    const { serializeMutation } = useServersStore()
    useNetworkStore().broadcast({ type: 'mutation', serverId, mutation: serializeMutation(mutation) })

    return channel
  }

  async function deleteChannel(channelId: string) {
    const { useIdentityStore } = await import('./identityStore')
    const identityStore = useIdentityStore()
    const { useMessagesStore } = await import('./messagesStore')
    const messagesStore = useMessagesStore()

    // Find serverId for this channel
    let serverId = ''
    for (const [sid, list] of Object.entries(channels.value)) {
      if (list.find(c => c.id === channelId)) { serverId = sid; break }
    }

    const mutation: Mutation = {
      id:         uuidv7(),
      type:       'channel_delete',
      targetId:   channelId,
      channelId:  '__server__',
      authorId:   identityStore.userId!,
      logicalTs:  generateHLC(),
      createdAt:  new Date().toISOString(),
      verified:   true,
    }

    await messagesStore.applyMutation(mutation)

    for (const [sid, list] of Object.entries(channels.value)) {
      channels.value[sid] = list.filter(c => c.id !== channelId)
    }
    if (activeChannelId.value === channelId) activeChannelId.value = null

    if (serverId) {
      const { useNetworkStore } = await import('./networkStore')
      const { useServersStore } = await import('./serversStore')
      const { serializeMutation } = useServersStore()
      useNetworkStore().broadcast({ type: 'mutation', serverId, mutation: serializeMutation(mutation) })
    }
  }

  async function renameChannel(channelId: string, newName: string) {
    const { useIdentityStore } = await import('./identityStore')
    const identityStore = useIdentityStore()
    const { useMessagesStore } = await import('./messagesStore')
    const messagesStore = useMessagesStore()

    let serverId = ''
    for (const [sid, list] of Object.entries(channels.value)) {
      const ch = list.find(c => c.id === channelId)
      if (ch) { serverId = sid; ch.name = newName; break }
    }

    const mutation: Mutation = {
      id:         uuidv7(),
      type:       'channel_update',
      targetId:   channelId,
      channelId:  '__server__',
      authorId:   identityStore.userId!,
      newContent: JSON.stringify({ name: newName }),
      logicalTs:  generateHLC(),
      createdAt:  new Date().toISOString(),
      verified:   true,
    }

    await messagesStore.applyMutation(mutation)

    if (serverId) {
      const { useNetworkStore } = await import('./networkStore')
      const { useServersStore } = await import('./serversStore')
      const { serializeMutation } = useServersStore()
      useNetworkStore().broadcast({ type: 'mutation', serverId, mutation: serializeMutation(mutation) })
    }
  }

  function setActiveChannel(channelId: string | null) {
    activeChannelId.value = channelId
    if (channelId) {
      import('./messagesStore').then(({ useMessagesStore }) => {
        useMessagesStore().markChannelRead(channelId)
      }).catch(e => console.warn('[channels] markChannelRead error:', e))
    }
  }

  async function applyChannelMutation(mutation: Mutation) {
    if (mutation.type === 'channel_create' && mutation.newContent) {
      const ch: Channel = JSON.parse(mutation.newContent)
      const list = channels.value[ch.serverId] ?? []
      if (!list.find(c => c.id === ch.id)) {
        channels.value[ch.serverId] = [...list, ch]
        // Persist so the channel survives restart
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
    } else if (mutation.type === 'channel_update' && mutation.newContent) {
      const patch = JSON.parse(mutation.newContent)
      for (const list of Object.values(channels.value)) {
        const ch = list.find(c => c.id === mutation.targetId)
        if (ch) Object.assign(ch, patch)
      }
    } else if (mutation.type === 'channel_delete') {
      for (const [sid, list] of Object.entries(channels.value)) {
        channels.value[sid] = list.filter(c => c.id !== mutation.targetId)
      }
      await invoke('db_delete_channel', { channelId: mutation.targetId })
    } else if (mutation.type === 'channel_acl_update' && mutation.newContent) {
      const acl: ChannelACL = JSON.parse(mutation.newContent)
      await persistAndSetAcl(acl)
    }
  }

  return {
    channels,
    activeChannelId,
    channelAcls,
    loadChannels,
    loadChannelAcls,
    isChannelVisible,
    persistAndSetAcl,
    createChannel,
    deleteChannel,
    renameChannel,
    setActiveChannel,
    applyChannelMutation,
  }
})
