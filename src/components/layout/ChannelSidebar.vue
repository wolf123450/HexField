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
      <template v-for="ch in voiceChannels" :key="ch.id">
      <div
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

      <!-- Voice participants sub-list (visible to all users, not just participants) -->
      <template v-if="voiceStore.session?.channelId === ch.id || voiceChannelPeerIds(ch.id).length > 0">
        <!-- Local user (self) — only shown when we are in this channel -->
        <div v-if="voiceStore.session?.channelId === ch.id" class="voice-participant" :class="{ speaking: voiceStore.speakingPeers.has('self') }">
          <div class="vp-avatar-wrap">
            <div class="vp-speaking-ring" />
            <div class="vp-avatar">{{ identityInitials }}</div>
            <div v-if="voiceStore.isMuted" class="vp-mute">
              <AppIcon :path="mdiMicrophoneOff" :size="8" />
            </div>
          </div>
          <span class="vp-name">{{ identityStore.displayName }} <em class="vp-you">(you)</em></span>
        </div>
        <!-- Remote peers -->
        <div
          v-for="uid in voiceChannelPeerIds(ch.id)"
          :key="uid"
          class="voice-participant"
          :class="{ speaking: voiceStore.speakingPeers.has(uid) }"
        >
          <div class="vp-avatar-wrap">
            <div class="vp-speaking-ring" />
            <div class="vp-avatar">{{ peerInitials(uid) }}</div>
            <div v-if="voiceStore.peers[uid] && !voiceStore.peers[uid].audioEnabled" class="vp-mute">
              <AppIcon :path="mdiMicrophoneOff" :size="8" />
            </div>
          </div>
          <span class="vp-name">{{ peerDisplayName(uid) }}</span>
        </div>
      </template>
      </template>
    </div><!-- end .channel-list -->

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

    <!-- Hidden file input for server icon upload -->
    <input
      ref="serverIconInput"
      type="file"
      accept="image/*,.gif"
      style="display:none"
      @change="onServerIconSelected"
    />

    <div class="self-panel">
      <div class="self-info">
        <div
          class="self-avatar-wrap"
          title="View profile (right-click to set status)"
          @click="uiStore.openUserProfile(identityStore.userId ?? '', serversStore.activeServerId ?? '')"
          @contextmenu.prevent="openStatusPicker"
        >
          <AvatarImage :src="identityStore.avatarDataUrl" :name="identityStore.displayName" :size="32" />
          <StatusBadge
            :status="ownStatus"
            :size="12"
            class="self-status-badge"
          />
        </div>
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
import { useNetworkStore } from '@/stores/networkStore'
import VoiceBar from '@/components/chat/VoiceBar.vue'
import type { ChannelType } from '@/types/core'
import type { MenuItem } from '@/stores/uiStore'

const serversStore  = useServersStore()
const channelsStore = useChannelsStore()
const messagesStore = useMessagesStore()
const identityStore = useIdentityStore()
const voiceStore    = useVoiceStore()
const uiStore       = useUIStore()
const networkStore  = useNetworkStore()

function peerDisplayName(userId: string): string {
  const sid = serversStore.activeServerId
  if (!sid) return userId.slice(0, 8)
  return serversStore.members[sid]?.[userId]?.displayName ?? userId.slice(0, 8)
}

function peerInitials(userId: string): string {
  const name = peerDisplayName(userId)
  return name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase()
}

/**
 * Returns the user IDs of remote peers currently in a given voice channel.
 * When the local user is IN the channel, returns ids from voiceStore.peers (which
 * have active WebRTC connections). When the local user is NOT in the channel,
 * returns ids from peerVoiceChannels (presence gossiped via voice_join).
 */
function voiceChannelPeerIds(channelId: string): string[] {
  if (voiceStore.session?.channelId === channelId) {
    return Object.keys(voiceStore.peers)
  }
  return Object.entries(voiceStore.peerVoiceChannels)
    .filter(([, cid]) => cid === channelId)
    .map(([uid]) => uid)
}

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
  // Minimise voice view so the text channel is visible
  if (voiceStore.session) voiceStore.voiceViewActive = false
}

async function selectVoiceChannel(channelId: string) {
  const serverId = serversStore.activeServerId
  if (!serverId) return
  // If already in this channel: toggle voice view active
  if (voiceStore.session?.channelId === channelId) {
    voiceStore.voiceViewActive = !voiceStore.voiceViewActive
    return
  }
  // Leave current if in one, then join
  try {
    await voiceStore.joinVoiceChannel(channelId, serverId)
  } catch (e) {
    console.error('[sidebar] failed to join voice channel:', e)
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

const renameState        = ref({ active: false, channelId: '', name: '' })
const renameInput        = ref<HTMLInputElement | null>(null)
const serverIconInput    = ref<HTMLInputElement | null>(null)

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

const SERVER_ICON_DIM = 64
const SERVER_ICON_MAX_GIF = 512 * 1024   // 512 KB
const SERVER_ICON_MAX_STATIC = 4 * 1024 * 1024 // 4 MB

function openServerSettings() {
  const sid = serversStore.activeServerId
  if (!sid) return
  const uid = identityStore.userId
  const isAdmin = uid ? (serversStore.members[sid]?.[uid]?.roles.includes('admin') ?? false) : false
  const items: MenuItem[] = [
    {
      type: 'action',
      label: 'Invite People',
      callback: () => uiStore.openInviteModal(sid),
    },
  ]
  if (isAdmin) {
    items.push({
      type: 'action',
      label: 'Change Server Icon',
      callback: () => { serverIconInput.value?.click() },
    })
  }
  uiStore.showContextMenu(0, 48, items)
}

async function onServerIconSelected(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0]
  if (!file) return
  ;(e.target as HTMLInputElement).value = ''
  const sid = serversStore.activeServerId
  if (!sid) return

  if (file.type === 'image/gif') {
    if (file.size > SERVER_ICON_MAX_GIF) return
    const dataUrl = await readServerIconAsDataUrl(file)
    await serversStore.updateServerAvatar(sid, dataUrl)
    networkStore.broadcastServerAvatar(sid, dataUrl).catch(() => {})
    return
  }

  if (file.size > SERVER_ICON_MAX_STATIC) return
  const objectUrl = URL.createObjectURL(file)
  const imgEl = new Image()
  imgEl.onload = async () => {
    URL.revokeObjectURL(objectUrl)
    const canvas = document.createElement('canvas')
    canvas.width  = SERVER_ICON_DIM
    canvas.height = SERVER_ICON_DIM
    const ctx = canvas.getContext('2d')!
    const scale = Math.max(SERVER_ICON_DIM / imgEl.width, SERVER_ICON_DIM / imgEl.height)
    const w = imgEl.width  * scale
    const h = imgEl.height * scale
    ctx.drawImage(imgEl, (SERVER_ICON_DIM - w) / 2, (SERVER_ICON_DIM - h) / 2, w, h)
    const dataUrl = canvas.toDataURL('image/png', 0.9)
    await serversStore.updateServerAvatar(sid, dataUrl)
    networkStore.broadcastServerAvatar(sid, dataUrl).catch(() => {})
  }
  imgEl.onerror = () => URL.revokeObjectURL(objectUrl)
  imgEl.src = objectUrl
}

function readServerIconAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload  = () => resolve(reader.result as string)
    reader.onerror = () => reject(new Error('FileReader error'))
    reader.readAsDataURL(file)
  })
}

// ── Own status ────────────────────────────────────────────────────────────────

const STATUS_KEY = 'gamechat_own_status'
const ownStatus = ref<'online' | 'idle' | 'dnd' | 'offline'>(
  (localStorage.getItem(STATUS_KEY) as any) ?? 'online'
)

function openStatusPicker(e: MouseEvent) {
  const items: MenuItem[] = [
    { type: 'action', label: '\u25cf Online',         callback: () => setOwnStatus('online') },
    { type: 'action', label: '\u25cf Idle',           callback: () => setOwnStatus('idle') },
    { type: 'action', label: '\u25cf Do Not Disturb', callback: () => setOwnStatus('dnd') },
    { type: 'action', label: '\u25cb Invisible',      callback: () => setOwnStatus('offline') },
  ]
  uiStore.showContextMenu(e.clientX, e.clientY, items)
}

function setOwnStatus(status: 'online' | 'idle' | 'dnd' | 'offline') {
  ownStatus.value = status
  localStorage.setItem(STATUS_KEY, status)
  // Update member record for every joined server
  const uid = identityStore.userId
  if (!uid) return
  for (const sid of serversStore.joinedServerIds) {
    serversStore.updateMemberStatus(sid, uid, status)
  }
  // Broadcast to all connected peers
  networkStore.broadcastPresence(status).catch(() => {})
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

.self-avatar-wrap {
  position: relative;
  flex-shrink: 0;
  cursor: pointer;
}
.self-avatar-wrap:hover :deep(.avatar-image) { opacity: 0.85; }

.self-status-badge {
  position: absolute;
  bottom: -1px;
  right: -1px;
  background: var(--bg-tertiary);
  border-radius: 50%;
  padding: 1px;
  box-sizing: content-box;
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

/* Voice participant sub-list */
.voice-participant {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  padding: 3px var(--spacing-sm) 3px 28px;
  border-radius: 4px;
  cursor: default;
}

.vp-avatar-wrap {
  position: relative;
  width: 24px;
  height: 24px;
  flex-shrink: 0;
}

.vp-speaking-ring {
  position: absolute;
  inset: -2px;
  border-radius: 50%;
  border: 2px solid transparent;
  pointer-events: none;
  transition: border-color 0.15s;
}

.voice-participant.speaking .vp-speaking-ring {
  border-color: #3ba55d;
  box-shadow: 0 0 0 2px rgba(59, 165, 93, 0.35);
  animation: pulse-ring 1.2s ease-in-out infinite;
}

@keyframes pulse-ring {
  0%, 100% { box-shadow: 0 0 0 2px rgba(59, 165, 93, 0.35); }
  50%       { box-shadow: 0 0 0 4px rgba(59, 165, 93, 0.12); }
}

.vp-avatar {
  width: 24px;
  height: 24px;
  border-radius: 50%;
  background: var(--accent-color);
  color: white;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 9px;
  font-weight: 700;
  user-select: none;
}

.vp-mute {
  position: absolute;
  bottom: -1px;
  right: -1px;
  width: 12px;
  height: 12px;
  background: #ed4245;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--bg-secondary);
}

.vp-name {
  font-size: 12px;
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.vp-you {
  font-style: italic;
  font-size: 10px;
  color: var(--text-tertiary);
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
