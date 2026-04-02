<template>
  <nav class="server-rail">
    <div class="server-list">
      <button
        v-for="serverId in serversStore.joinedServerIds"
        :key="serverId"
        class="server-icon"
        :class="{ active: serverId === serversStore.activeServerId }"
        :title="serversStore.servers[serverId]?.name"
        @click="selectServer(serverId)"
      >
        <span class="server-initials">{{ getInitials(serversStore.servers[serverId]?.name) }}</span>
        <span
          v-if="unreadForServer(serverId) > 0"
          class="unread-badge"
        >{{ unreadForServer(serverId) }}</span>
      </button>
    </div>

    <div class="server-rail-footer">
      <button class="server-icon add-server" title="Create or join a server" @click="uiStore.showContextMenu(0, 0, addServerMenu)">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
          <path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/>
        </svg>
      </button>
    </div>
  </nav>
</template>

<script setup lang="ts">
import { useServersStore } from '@/stores/serversStore'
import { useUIStore } from '@/stores/uiStore'
import { useChannelsStore } from '@/stores/channelsStore'
import { useMessagesStore } from '@/stores/messagesStore'
import type { MenuItem } from '@/stores/uiStore'

const serversStore  = useServersStore()
const channelsStore = useChannelsStore()
const messagesStore = useMessagesStore()
const uiStore       = useUIStore()

function getInitials(name?: string): string {
  if (!name) return '?'
  return name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase()
}

async function selectServer(serverId: string) {
  serversStore.setActiveServer(serverId)
  await channelsStore.loadChannels(serverId)
  const channels = channelsStore.channels[serverId] ?? []
  const first = channels.find(c => c.type === 'text')
  if (first) channelsStore.setActiveChannel(first.id)
}

function unreadForServer(serverId: string): number {
  const channels = channelsStore.channels[serverId] ?? []
  return channels.reduce((sum, ch) => sum + (messagesStore.unreadCounts[ch.id] ?? 0), 0)
}

const addServerMenu: MenuItem[] = [
  {
    type: 'action',
    label: 'Create a Server',
    callback: () => { uiStore.showServerCreateModal = true },
  },
  {
    type: 'action',
    label: 'Join a Server',
    callback: () => { uiStore.showJoinModal = true },
  },
]
</script>

<style scoped>
.server-rail {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: var(--spacing-md) 0;
  background: var(--bg-tertiary);
  gap: var(--spacing-sm);
  overflow-y: auto;
  overflow-x: hidden;
}

.server-list {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--spacing-sm);
  flex: 1;
}

.server-rail-footer {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--spacing-sm);
}

.server-icon {
  position: relative;
  width: 48px;
  height: 48px;
  border-radius: 50%;
  background: var(--bg-secondary);
  border: none;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: border-radius 0.15s ease, background 0.15s ease;
  color: var(--text-primary);
  font-weight: 600;
  font-size: 14px;
  overflow: hidden;
}

.server-icon:hover,
.server-icon.active {
  border-radius: 30%;
  background: var(--accent-color);
  color: white;
}

.server-icon.add-server {
  background: var(--bg-secondary);
  color: var(--accent-color);
}

.server-icon.add-server:hover {
  background: var(--accent-color);
  color: white;
}

.unread-badge {
  position: absolute;
  bottom: -2px;
  right: -2px;
  background: var(--error-color);
  color: white;
  font-size: 10px;
  font-weight: 700;
  border-radius: 10px;
  padding: 1px 5px;
  min-width: 16px;
  text-align: center;
  line-height: 14px;
}
</style>
