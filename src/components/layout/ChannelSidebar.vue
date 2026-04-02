<template>
  <aside class="channel-sidebar">
    <div class="server-header">
      <span class="server-name">{{ activeServer?.name ?? 'No server selected' }}</span>
      <button class="icon-btn" title="Server settings" @click="openServerSettings">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
          <path d="M19.14,12.94c0.04-0.3,0.06-0.61,0.06-0.94c0-0.32-0.02-0.64-0.07-0.94l2.03-1.58c0.18-0.14,0.23-0.41,0.12-0.61l-1.92-3.32c-0.12-0.22-0.37-0.29-0.59-0.22l-2.39,0.96c-0.5-0.38-1.03-0.7-1.62-0.94L14.4,2.81c-0.04-0.24-0.24-0.41-0.48-0.41h-3.84c-0.24,0-0.43,0.17-0.47,0.41L9.25,5.35C8.66,5.59,8.12,5.92,7.63,6.29L5.24,5.33c-0.22-0.08-0.47,0-0.59,0.22L2.74,8.87C2.62,9.08,2.66,9.34,2.86,9.48l2.03,1.58C4.84,11.36,4.8,11.69,4.8,12s0.02,0.64,0.07,0.94l-2.03,1.58c-0.18,0.14-0.23,0.41-0.12,0.61l1.92,3.32c0.12,0.22,0.37,0.29,0.59,0.22l2.39-0.96c0.5,0.38,1.03,0.7,1.62,0.94l0.36,2.54c0.05,0.24,0.24,0.41,0.48,0.41h3.84c0.24,0,0.44-0.17,0.47-0.41l0.36-2.54c0.59-0.24,1.13-0.56,1.62-0.94l2.39,0.96c0.22,0.08,0.47,0,0.59-0.22l1.92-3.32c0.12-0.22,0.07-0.47-0.12-0.61L19.14,12.94z M12,15.6c-1.98,0-3.6-1.62-3.6-3.6s1.62-3.6,3.6-3.6s3.6,1.62,3.6,3.6S13.98,15.6,12,15.6z"/>
        </svg>
      </button>
    </div>

    <div class="channel-list">
      <!-- Text channels header + add button -->
      <div class="channel-category-row">
        <span class="channel-category-label">TEXT CHANNELS</span>
        <button
          v-if="serversStore.activeServerId"
          class="add-channel-btn"
          title="Add text channel"
          @click="promptAddChannel('text')"
        >+</button>
      </div>

      <div
        v-for="ch in textChannels"
        :key="ch.id"
        class="channel-item"
        :class="{ active: ch.id === channelsStore.activeChannelId }"
        @click="selectChannel(ch.id)"
        @contextmenu.prevent="(e) => openChannelMenu(e, ch.id)"
      >
        <span class="channel-hash">#</span>
        <span class="channel-name">{{ ch.name }}</span>
        <span v-if="unread(ch.id)" class="channel-unread">{{ unread(ch.id) }}</span>
      </div>

      <!-- Voice channels header + add button -->
      <div v-if="voiceChannels.length || serversStore.activeServerId" class="channel-category-row" style="margin-top: var(--spacing-sm)">
        <span class="channel-category-label">VOICE CHANNELS</span>
        <button
          v-if="serversStore.activeServerId"
          class="add-channel-btn"
          title="Add voice channel"
          @click="promptAddChannel('voice')"
        >+</button>
      </div>
      <div
        v-for="ch in voiceChannels"
        :key="ch.id"
        class="channel-item channel-voice"
        :class="{ active: ch.id === channelsStore.activeChannelId }"
        @click="selectChannel(ch.id)"
        @contextmenu.prevent="(e) => openChannelMenu(e, ch.id)"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" class="voice-icon">
          <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02z"/>
        </svg>
        <span class="channel-name">{{ ch.name }}</span>
      </div>
    </div>

    <!-- Inline rename input (shown below the renamed channel) -->
    <Teleport to="body">
      <div v-if="renameState.active" class="rename-backdrop" @click.self="cancelRename">
        <div class="rename-popup">
          <p class="rename-label">Rename channel</p>
          <input
            ref="renameInput"
            v-model="renameState.name"
            class="rename-text-input"
            maxlength="80"
            @keydown.enter="submitRename"
            @keydown.esc="cancelRename"
          />
          <div class="rename-actions">
            <button class="btn-secondary-sm" @click="cancelRename">Cancel</button>
            <button class="btn-primary-sm" :disabled="!renameState.name.trim()" @click="submitRename">Rename</button>
          </div>
        </div>
      </div>
    </Teleport>

    <div class="self-panel">
      <div class="self-info">
        <div class="self-avatar">{{ identityInitials }}</div>
        <div class="self-name">{{ identityStore.displayName }}</div>
      </div>
      <div class="self-controls">
        <button class="icon-btn" title="Mute" @click="voiceStore.toggleMute()">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 14c1.66 0 2.99-1.34 2.99-3L15 5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.3-3c0 3-2.54 5.1-5.3 5.1S6.7 14 6.7 11H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c3.28-.48 6-3.3 6-6.72h-1.7z"/>
          </svg>
        </button>
        <button class="icon-btn" title="Settings" @click="uiStore.toggleSettings()">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
            <path d="M19.14,12.94c0.04-0.3,0.06-0.61,0.06-0.94c0-0.32-0.02-0.64-0.07-0.94l2.03-1.58c0.18-0.14,0.23-0.41,0.12-0.61l-1.92-3.32c-0.12-0.22-0.37-0.29-0.59-0.22l-2.39,0.96c-0.5-0.38-1.03-0.7-1.62-0.94L14.4,2.81c-0.04-0.24-0.24-0.41-0.48-0.41h-3.84c-0.24,0-0.43,0.17-0.47,0.41L9.25,5.35C8.66,5.59,8.12,5.92,7.63,6.29L5.24,5.33c-0.22-0.08-0.47,0-0.59,0.22L2.74,8.87C2.62,9.08,2.66,9.34,2.86,9.48l2.03,1.58C4.84,11.36,4.8,11.69,4.8,12s0.02,0.64,0.07,0.94l-2.03,1.58c-0.18,0.14-0.23,0.41-0.12,0.61l1.92,3.32c0.12,0.22,0.37,0.29,0.59,0.22l2.39-0.96c0.5,0.38,1.03,0.7,1.62,0.94l0.36,2.54c0.05,0.24,0.24,0.41,0.48,0.41h3.84c0.24,0,0.44-0.17,0.47-0.41l0.36-2.54c0.59-0.24,1.13-0.56,1.62-0.94l2.39,0.96c0.22,0.08,0.47,0,0.59-0.22l1.92-3.32c0.12-0.22,0.07-0.47-0.12-0.61L19.14,12.94z"/>
          </svg>
        </button>
      </div>
    </div>
  </aside>
</template>

<script setup lang="ts">
import { computed, ref, nextTick } from 'vue'
import { useServersStore } from '@/stores/serversStore'
import { useChannelsStore } from '@/stores/channelsStore'
import { useMessagesStore } from '@/stores/messagesStore'
import { useIdentityStore } from '@/stores/identityStore'
import { useVoiceStore } from '@/stores/voiceStore'
import { useUIStore } from '@/stores/uiStore'
import type { ChannelType } from '@/types/core'
import type { MenuItem } from '@/stores/uiStore'

const serversStore  = useServersStore()
const channelsStore = useChannelsStore()
const messagesStore = useMessagesStore()
const identityStore = useIdentityStore()
const voiceStore    = useVoiceStore()
const uiStore       = useUIStore()

const activeServer = computed(() =>
  serversStore.activeServerId ? serversStore.servers[serversStore.activeServerId] : null
)

const serverChannels = computed(() =>
  serversStore.activeServerId ? (channelsStore.channels[serversStore.activeServerId] ?? []) : []
)

const textChannels  = computed(() => serverChannels.value.filter(c => c.type === 'text' || c.type === 'announcement'))
const voiceChannels = computed(() => serverChannels.value.filter(c => c.type === 'voice'))

const identityInitials = computed(() => {
  const name = identityStore.displayName || '?'
  return name.split(' ').map((w: string) => w[0]).join('').slice(0, 2).toUpperCase()
})

async function selectChannel(channelId: string) {
  channelsStore.setActiveChannel(channelId)
  messagesStore.markChannelRead(channelId)
  await messagesStore.loadMessages(channelId)
  await messagesStore.loadMutationsForChannel(channelId)
}

function unread(channelId: string): number {
  return messagesStore.unreadCounts[channelId] ?? 0
}

// ── Add channel ───────────────────────────────────────────────────────────────

async function promptAddChannel(type: ChannelType) {
  const serverId = serversStore.activeServerId
  if (!serverId) return
  const rawName = window.prompt(type === 'voice' ? 'Voice channel name:' : 'Channel name:')
  if (!rawName?.trim()) return
  const channel = await channelsStore.createChannel(serverId, rawName.trim(), type)
  if (type === 'text') {
    channelsStore.setActiveChannel(channel.id)
    await messagesStore.loadMessages(channel.id)
  }
}

// ── Channel context menu ──────────────────────────────────────────────────────

const renameState  = ref({ active: false, channelId: '', name: '' })
const renameInput  = ref<HTMLInputElement | null>(null)

function openChannelMenu(e: MouseEvent, channelId: string) {
  const items: MenuItem[] = [
    {
      type: 'action',
      label: 'Rename',
      callback: () => startRename(channelId),
    },
    { type: 'separator' },
    {
      type: 'action',
      label: 'Delete Channel',
      danger: true,
      callback: () => deleteChannel(channelId),
    },
  ]
  uiStore.showContextMenu(e.clientX, e.clientY, items)
}

async function startRename(channelId: string) {
  const ch = serverChannels.value.find(c => c.id === channelId)
  if (!ch) return
  renameState.value = { active: true, channelId, name: ch.name }
  await nextTick()
  renameInput.value?.select()
}

async function submitRename() {
  const { channelId, name } = renameState.value
  if (!name.trim()) return
  await channelsStore.renameChannel(channelId, name.trim())
  renameState.value.active = false
}

function cancelRename() {
  renameState.value.active = false
}

async function deleteChannel(channelId: string) {
  if (!window.confirm('Delete this channel and all its messages?')) return
  await channelsStore.deleteChannel(channelId)
}

// ── Server settings ───────────────────────────────────────────────────────────

function openServerSettings() {
  const sid = serversStore.activeServerId
  if (!sid) return
  uiStore.openInviteModal(sid)
}
</script>

<style scoped>
.channel-sidebar {
  display: flex;
  flex-direction: column;
  background: var(--bg-secondary);
  border-right: 1px solid var(--border-color);
  overflow: hidden;
}

.server-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 var(--spacing-md);
  height: 48px;
  border-bottom: 1px solid var(--border-color);
  flex-shrink: 0;
}

.server-name {
  font-weight: 600;
  font-size: 15px;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.channel-list {
  flex: 1;
  overflow-y: auto;
  padding: var(--spacing-md) var(--spacing-sm);
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.channel-category-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--spacing-md) var(--spacing-sm) var(--spacing-xs);
}

.channel-category-label {
  font-size: 11px;
  font-weight: 700;
  color: var(--text-tertiary);
  letter-spacing: 0.04em;
}

.add-channel-btn {
  background: none;
  border: none;
  color: var(--text-tertiary);
  cursor: pointer;
  font-size: 18px;
  line-height: 1;
  padding: 0 4px;
  border-radius: 4px;
}
.add-channel-btn:hover { color: var(--text-primary); background: var(--bg-tertiary); }

.channel-item {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  padding: 5px var(--spacing-sm);
  border-radius: 4px;
  cursor: pointer;
  color: var(--text-secondary);
  font-size: 14px;
  transition: background 0.1s ease, color 0.1s ease;
}

.channel-item:hover {
  background: var(--bg-tertiary);
  color: var(--text-primary);
}

.channel-item.active {
  background: var(--bg-tertiary);
  color: var(--text-primary);
}

.channel-hash {
  color: var(--text-tertiary);
  font-size: 16px;
  flex-shrink: 0;
}

.voice-icon {
  color: var(--text-tertiary);
  flex-shrink: 0;
}

.channel-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.channel-unread {
  background: var(--error-color);
  color: white;
  font-size: 11px;
  font-weight: 700;
  border-radius: 10px;
  padding: 1px 5px;
  min-width: 16px;
  text-align: center;
}

.self-panel {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--spacing-sm) var(--spacing-md);
  background: var(--bg-tertiary);
  border-top: 1px solid var(--border-color);
  flex-shrink: 0;
  height: 52px;
}

.self-info {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  overflow: hidden;
}

.self-avatar {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  background: var(--accent-color);
  color: white;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  font-weight: 700;
  flex-shrink: 0;
}

.self-name {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.self-controls {
  display: flex;
  gap: var(--spacing-xs);
}

.icon-btn {
  background: none;
  border: none;
  cursor: pointer;
  color: var(--text-secondary);
  padding: 4px;
  border-radius: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.icon-btn:hover {
  background: var(--bg-primary);
  color: var(--text-primary);
}

/* Rename popup */
.rename-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.rename-popup {
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  padding: var(--spacing-lg);
  width: 320px;
  display: flex;
  flex-direction: column;
  gap: var(--spacing-sm);
}

.rename-label {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
}

.rename-text-input {
  background: var(--bg-primary);
  border: 1px solid var(--border-color);
  border-radius: 4px;
  padding: 8px var(--spacing-md);
  color: var(--text-primary);
  font-size: 14px;
  outline: none;
}
.rename-text-input:focus { border-color: var(--accent-color); }

.rename-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--spacing-sm);
}

.btn-secondary-sm {
  background: none;
  border: 1px solid var(--border-color);
  border-radius: 4px;
  padding: 6px 12px;
  color: var(--text-primary);
  font-size: 13px;
  cursor: pointer;
}
.btn-secondary-sm:hover { background: var(--bg-tertiary); }

.btn-primary-sm {
  background: var(--accent-color);
  border: none;
  border-radius: 4px;
  padding: 6px 12px;
  color: white;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}
.btn-primary-sm:hover:not(:disabled) { filter: brightness(1.1); }
.btn-primary-sm:disabled { opacity: 0.5; cursor: not-allowed; }
</style>
