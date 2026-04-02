import { defineStore } from 'pinia'
import { ref } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import { v7 as uuidv7 } from 'uuid'
import type { Channel, ChannelType, Mutation } from '@/types/core'

export const useChannelsStore = defineStore('channels', () => {
  const channels        = ref<Record<string, Channel[]>>({})  // keyed by serverId
  const activeChannelId = ref<string | null>(null)

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
  }

  async function createChannel(serverId: string, name: string, type: ChannelType = 'text'): Promise<Channel> {
    const existing = channels.value[serverId] ?? []
    const channel: Channel = {
      id:       uuidv7(),
      serverId,
      name,
      type,
      position: existing.length,
    }
    await invoke('db_save_channel', {
      channel: {
        id:         channel.id,
        server_id:  channel.serverId,
        name:       channel.name,
        type:       channel.type,
        position:   channel.position,
        topic:      null,
        created_at: new Date().toISOString(),
      },
    })
    channels.value[serverId] = [...existing, channel]
    return channel
  }

  async function deleteChannel(channelId: string) {
    await invoke('db_delete_channel', { channelId })
    for (const [sid, list] of Object.entries(channels.value)) {
      channels.value[sid] = list.filter(c => c.id !== channelId)
    }
    if (activeChannelId.value === channelId) activeChannelId.value = null
  }

  async function renameChannel(channelId: string, newName: string) {
    for (const list of Object.values(channels.value)) {
      const ch = list.find(c => c.id === channelId)
      if (ch) {
        ch.name = newName
        await invoke('db_save_channel', {
          channel: {
            id: ch.id, server_id: ch.serverId, name: newName,
            type: ch.type, position: ch.position, topic: ch.topic ?? null,
            created_at: new Date().toISOString(),
          },
        })
        break
      }
    }
  }

  function setActiveChannel(channelId: string | null) {
    activeChannelId.value = channelId
  }

  function applyChannelMutation(mutation: Mutation) {
    if (mutation.type === 'channel_create' && mutation.newContent) {
      const ch: Channel = JSON.parse(mutation.newContent)
      const list = channels.value[ch.serverId] ?? []
      if (!list.find(c => c.id === ch.id)) {
        channels.value[ch.serverId] = [...list, ch]
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
    }
  }

  return {
    channels,
    activeChannelId,
    loadChannels,
    createChannel,
    deleteChannel,
    renameChannel,
    setActiveChannel,
    applyChannelMutation,
  }
})
