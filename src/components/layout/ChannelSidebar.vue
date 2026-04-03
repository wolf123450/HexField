<template>
  <aside class="channel-sidebar">
    <div class="server-header">
      <span class="server-name">{{ activeServer?.name ?? 'No server selected' }}</span>
      <button class="icon-btn" title="Server settings" @click="openServerSettings">
        <AppIcon :path="mdiCog" :size="16" />
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
        :class="{ active: voiceStore.session?.channelId === ch.id }"
        @click="selectVoiceChannel(ch.id)"
        @contextmenu.prevent="(e) => openChannelMenu(e, ch.id)"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" class="voice-icon">
          <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02z"/>
        </svg>
        <span class="channel-name">{{ ch.name }}</span>
        <span v-if="voiceStore.session?.channelId === ch.id" class="voice-live-dot" title="Connected" />
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

    <VoiceBar />

    <div class="self-panel">
      <div class="self-info">
        <div class="self-avatar">{{ identityInitials }}</div>
        <div class="self-name">{{ identityStore.displayName }}</div>
      </div>
      <div class="self-controls">
        <button
          class="icon-btn"
          :class="{ 'icon-btn--active': voiceStore.isMuted }"
          :title="voiceStore.isMuted ? 'Unmute' : 'Mute'"
          @click="voiceStore.toggleMute()"
        >
          <AppIcon :path="voiceStore.isMuted ? mdiMicrophoneOff : mdiMicrophone" :size="16" />
        </button>
        <button class="icon-btn" title="Settings" @click="uiStore.toggleSettings()">
          <AppIcon :path="mdiCog" :size="16" />
        </button>
      </div>
    </div>
  </aside>
</template>

<script setup lang="ts">
import { computed, ref, nextTick } from 'vue'
import { mdiCog, mdiMicrophone, mdiMicrophoneOff } from '@mdi/js'
import { useServersStore } from '@/stores/serversStore'
import { useChannelsStore } from '@/stores/channelsStore'
import { useMessagesStore } from '@/stores/messagesStore'
import { useIdentityStore } from '@/stores/identityStore'
import { useVoiceStore } from '@/stores/voiceStore'
import { useUIStore } from '@/stores/uiStore'
import VoiceBar from '@/components/chat/VoiceBar.vue'
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

async function selectVoiceChannel(channelId: string) {
  const serverId = serversStore.activeServerId
  if (!serverId) return
  // Toggle: leave if already in this channel
  if (voiceStore.session?.channelId === channelId) {
    await voiceStore.leaveVoiceChannel()
  } else {
    try {
      await voiceStore.joinVoiceChannel(channelId, serverId)
    } catch (e) {
      console.error('[sidebar] failed to join voice channel:', e)
    }
  }
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

.voice-live-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #3ba55d;
  flex-shrink: 0;
  margin-left: auto;
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

.icon-btn--active {
  color: var(--error-color);
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
