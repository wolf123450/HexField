<template>
  <nav class="server-rail">
    <div class="server-list">
      <button
        v-for="serverId in serversStore.joinedServerIds"
        :key="serverId"
        class="server-icon"
        :class="{ active: serverId === serversStore.activeServerId, 'has-avatar': !!serversStore.servers[serverId]?.avatarDataUrl }"
        :style="serverIconStyle(serverId)"
        :title="serversStore.servers[serverId]?.name"
        @click="selectServer(serverId)"
        @contextmenu.prevent="(e) => openServerMenu(e, serverId)"
      >
        <img
          v-if="serversStore.servers[serverId]?.avatarDataUrl"
          :src="serversStore.servers[serverId]!.avatarDataUrl!"
          :alt="serversStore.servers[serverId]?.name"
          class="server-avatar-img"
          draggable="false"
        />
        <span v-else class="server-initials">{{ serverInitials(serverId) }}</span>
        <span
          v-if="unreadForServer(serverId) > 0"
          class="unread-badge"
        >{{ unreadForServer(serverId) }}</span>
        <span
          v-if="pendingJoinCount(serverId) > 0"
          class="pending-badge"
          :title="`${pendingJoinCount(serverId)} pending join request(s)`"
        >{{ pendingJoinCount(serverId) }}</span>
      </button>
    </div>

    <div class="server-rail-footer">
      <button class="server-icon add-server" title="Create or join a server" @click="(e) => uiStore.showContextMenu(e.clientX, e.clientY, addServerMenu)">
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
import { useIdentityStore } from '@/stores/identityStore'

const serversStore  = useServersStore()
const channelsStore = useChannelsStore()
const messagesStore = useMessagesStore()
const uiStore       = useUIStore()
const identityStore = useIdentityStore()

function serverInitials(serverId: string): string {
  const name = serversStore.servers[serverId]?.name?.trim() || '?'
  return name.split(/\s+/).map((w: string) => w[0]).join('').slice(0, 2).toUpperCase()
}

const DEFAULT_BG_COLORS = ['#5865F2', '#3BA55D', '#ED4245', '#FAA61A', '#EB459E', '#9B59B6', '#607D8B']

function serverIconStyle(serverId: string): Record<string, string> {
  const server = serversStore.servers[serverId]
  if (!server) return {}
  // When an avatar is set, no background colour needed — image covers it
  if (server.avatarDataUrl) return { background: 'transparent' }
  // User-configured background colour or derived from server id
  const color = server.iconBgColor ?? DEFAULT_BG_COLORS[server.id.charCodeAt(0) % DEFAULT_BG_COLORS.length]
  return { background: color }
}

async function selectServer(serverId: string) {
  serversStore.setActiveServer(serverId)
  await Promise.all([
    channelsStore.loadChannels(serverId),
    serversStore.fetchMembers(serverId),
  ])
  const channels = channelsStore.channels[serverId] ?? []
  const first = channels.find(c => c.type === 'text')
  if (first) channelsStore.setActiveChannel(first.id)
}

function unreadForServer(serverId: string): number {
  const channels = channelsStore.channels[serverId] ?? []
  return channels.reduce((sum, ch) => sum + (messagesStore.unreadCounts[ch.id] ?? 0), 0)
}

function isAdminOfServer(serverId: string): boolean {
  const uid = identityStore.userId
  if (!uid) return false
  return serversStore.members[serverId]?.[uid]?.roles.some(r => r === 'admin' || r === 'owner') ?? false
}

function pendingJoinCount(serverId: string): number {
  if (!isAdminOfServer(serverId)) return 0
  return serversStore.pendingRequestCount(serverId)
}

// ── Server icon right-click menu ─────────────────────────────────────────────

function openServerMenu(e: MouseEvent, serverId: string) {
  uiStore.showContextMenu(e.clientX, e.clientY, [
    {
      type: 'action',
      label: 'Server Settings',
      callback: () => uiStore.openServerSettings(serverId),
    },
    {
      type: 'action',
      label: 'Invite People',
      callback: () => uiStore.openInviteModal(serverId),
    },
  ])
}

// ── Add server footer menu ─────────────────────────────────────────────────────

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
  border-radius: 16px;
  background: var(--bg-secondary);
  border: none;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: border-radius 0.15s ease, filter 0.15s ease;
  color: white;
  font-weight: 700;
  font-size: 16px;
  overflow: hidden;
  padding: 0;
  transform: none;
}

.server-icon:hover {
  border-radius: 12px;
}

.server-icon.active {
  border-radius: 12px;
}

/* Avatar icons — no background change on hover/active */
.server-icon.has-avatar:hover,
.server-icon.has-avatar.active {
  filter: brightness(1.08);
}

/* Default (initials) icons — subtle brightness on hover */
.server-icon:not(.has-avatar):not(.add-server):hover,
.server-icon:not(.has-avatar):not(.add-server).active {
  filter: brightness(1.15);
}

.server-icon.add-server {
  background: var(--bg-secondary);
  color: var(--accent-color);
}

.server-icon.add-server:hover {
  background: var(--accent-color);
  color: white;
}

.server-avatar-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.server-initials {
  line-height: 1;
  font-size: 16px;
  font-weight: 700;
  color: white;
  pointer-events: none;
  user-select: none;
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

.pending-badge {
  position: absolute;
  top: -2px;
  right: -2px;
  background: #f0b232;
  color: #1a1a1a;
  font-size: 10px;
  font-weight: 700;
  border-radius: 10px;
  padding: 1px 5px;
  min-width: 16px;
  text-align: center;
  line-height: 14px;
}
</style>
