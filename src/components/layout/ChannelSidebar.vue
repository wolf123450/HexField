<template>
  <aside class="channel-sidebar">
    <div class="server-header">
      <button v-if="isMobile" class="mobile-back-btn" aria-label="Back to servers" @click="uiStore.setMobilePanelView('servers')">
        <AppIcon :path="mdiChevronLeft" :size="20" />
      </button>
      <span class="server-name">{{ activeServer?.name ?? 'No server selected' }}</span>
      <div class="server-header-actions">
        <button
          v-if="activeServer"
          class="icon-btn"
          title="Invite People"
          @click="openServerInvite"
        >
          <AppIcon :path="mdiAccountPlus" :size="16" />
        </button>
        <button
          v-if="activeServer"
          class="icon-btn"
          title="Server Settings"
          @click="openServerSettingsDirect"
        >
          <AppIcon :path="mdiCog" :size="16" />
        </button>
      </div>
    </div>

    <div class="channel-list">
      <!-- Text channels header + add button -->
      <div class="channel-category-row">
        <span class="channel-category-label">TEXT CHANNELS</span>
        <button
          v-if="isAdmin"
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
          v-if="isAdmin"
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
            <AvatarImage :src="identityStore.avatarDataUrl" :name="identityStore.displayName" :size="24" />
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
          @contextmenu.prevent="onVoicePeerContextMenu($event, uid, ch.id)"
        >
          <div class="vp-avatar-wrap">
            <div class="vp-speaking-ring" />
            <AvatarImage :src="serversStore.members[serversStore.activeServerId ?? '']?.[uid]?.avatarDataUrl ?? null" :name="peerDisplayName(uid)" :size="24" />
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

    <!-- Voice-kick confirm modal (admin-only) -->
    <ModerationActionModal
      :show="voiceKickModal.show"
      title="Kick from voice"
      :body="`Remove ${voiceKickModal.displayName} from this voice channel?`"
      confirm-label="Kick from voice"
      @confirm="doVoiceKick"
      @cancel="voiceKickModal.show = false"
    />

    <!-- Admin-mute confirm modal (admin-only) -->
    <ModerationActionModal
      :show="voiceMuteModal.show"
      title="Admin mute in voice"
      :body="`Mute ${voiceMuteModal.displayName} in voice? They won't be able to unmute themselves.`"
      confirm-label="Admin mute"
      @confirm="doVoiceMute"
      @cancel="voiceMuteModal.show = false"
    />

    <!-- Per-channel notification popover -->
    <ChannelNotifPopover
      v-if="channelNotifState"
      :channelId="channelNotifState.channelId"
      :serverId="channelNotifState.serverId"
      :x="channelNotifState.x"
      :y="channelNotifState.y"
      @close="channelNotifState = null"
    />

    <!-- Channel access settings modal (admin-only) -->
    <ChannelAccessModal
      :show="channelAccessState.show"
      :channelId="channelAccessState.channelId"
      :serverId="serversStore.activeServerId ?? ''"
      @close="channelAccessState.show = false"
    />

    <!-- Hidden file input for server icon upload -->
    <!-- NOTE: Icon upload is now handled inside ServerSettingsModal. -->

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
import { computed, ref, watchEffect, onMounted, onUnmounted, nextTick } from 'vue'
import { mdiCog, mdiMicrophone, mdiMicrophoneOff, mdiAccountPlus, mdiChevronLeft } from '@mdi/js'
import { useServersStore } from '@/stores/serversStore'
import { useChannelsStore } from '@/stores/channelsStore'
import { useMessagesStore } from '@/stores/messagesStore'
import { useIdentityStore } from '@/stores/identityStore'
import { useVoiceStore } from '@/stores/voiceStore'
import { useUIStore } from '@/stores/uiStore'
import { useNetworkStore } from '@/stores/networkStore'
import { usePersonalBlocksStore } from '@/stores/personalBlocksStore'
import { useBreakpoint } from '@/utils/useBreakpoint'
import VoiceBar from '@/components/chat/VoiceBar.vue'
import ChannelNotifPopover from '@/components/layout/ChannelNotifPopover.vue'
import ModerationActionModal from '@/components/modals/ModerationActionModal.vue'
import ChannelAccessModal from '@/components/modals/ChannelAccessModal.vue'
import type { ChannelType } from '@/types/core'
import type { MenuItem } from '@/stores/uiStore'

const serversStore  = useServersStore()
const channelsStore = useChannelsStore()
const messagesStore = useMessagesStore()
const identityStore = useIdentityStore()
const voiceStore    = useVoiceStore()
const uiStore       = useUIStore()
const networkStore        = useNetworkStore()
const personalBlocksStore = usePersonalBlocksStore()
const { isMobile } = useBreakpoint()

function peerDisplayName(userId: string): string {
  const sid = serversStore.activeServerId
  if (!sid) return userId.slice(0, 8)
  return serversStore.members[sid]?.[userId]?.displayName ?? userId.slice(0, 8)
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

const myRoles = computed(() => {
  const sid = serversStore.activeServerId
  const uid = identityStore.userId
  if (!sid || !uid) return []
  return serversStore.members[sid]?.[uid]?.roles ?? []
})

const textChannels  = computed(() =>
  serverChannels.value.filter(c =>
    (c.type === 'text' || c.type === 'announcement') &&
    (isAdmin.value || channelsStore.isChannelVisible(c.id, identityStore.userId, myRoles.value))
  )
)
const voiceChannels = computed(() =>
  serverChannels.value.filter(c =>
    c.type === 'voice' &&
    (isAdmin.value || channelsStore.isChannelVisible(c.id, identityStore.userId, myRoles.value))
  )
)

const isAdmin = computed(() => {
  const sid = serversStore.activeServerId
  const uid = identityStore.userId
  if (!sid || !uid) return false
  return serversStore.members[sid]?.[uid]?.roles.some(r => r === 'admin' || r === 'owner') ?? false
})

// ── Voice-kick modal state ────────────────────────────────────────────────────

const voiceKickModal = ref<{
  show: boolean
  targetId: string
  channelId: string
  displayName: string
}>({ show: false, targetId: '', channelId: '', displayName: '' })

const voiceMuteModal = ref<{
  show: boolean
  targetId: string
  muting: boolean
  displayName: string
}>({ show: false, targetId: '', muting: true, displayName: '' })

function onVoicePeerContextMenu(e: MouseEvent, userId: string, channelId: string) {
  const items: MenuItem[] = []
  if (isAdmin.value) {
    const peer = voiceStore.peers[userId]
    const isAdminMuted = peer?.adminMuted === true
    if (!isAdminMuted) {
      items.push({
        type: 'action',
        label: 'Admin mute in voice',
        callback: () => {
          voiceMuteModal.value = {
            show: true,
            targetId: userId,
            muting: true,
            displayName: peerDisplayName(userId),
          }
        },
      })
    } else {
      items.push({
        type: 'action',
        label: 'Admin unmute in voice',
        callback: async () => {
          const sid = serversStore.activeServerId
          if (sid) await serversStore.voiceUnmuteMember(sid, userId)
        },
      })
    }
    items.push({
      type: 'action',
      label: 'Kick from voice',
      danger: true,
      callback: () => {
        voiceKickModal.value = {
          show: true,
          targetId: userId,
          channelId,
          displayName: peerDisplayName(userId),
        }
      },
    })
  }

  // Personal mute/unmute — available for all non-self voice peers
  const isPersonallyMuted = personalBlocksStore.isMuted(userId)
  items.push(isPersonallyMuted
    ? {
        type: 'action',
        label: 'Personally unmute',
        callback: () => personalBlocksStore.unmuteUser(userId),
      }
    : {
        type: 'action',
        label: 'Personally mute',
        callback: () => personalBlocksStore.muteUser(userId),
      }
  )

  if (items.length) uiStore.showContextMenu(e.clientX, e.clientY, items)
}

async function doVoiceKick(reason: string) {
  const sid = serversStore.activeServerId
  if (!sid) return
  const { targetId, channelId } = voiceKickModal.value
  voiceKickModal.value.show = false
  await serversStore.kickFromVoice(sid, targetId, channelId, reason)
}

async function doVoiceMute(reason: string) {
  const sid = serversStore.activeServerId
  if (!sid) return
  const { targetId } = voiceMuteModal.value
  voiceMuteModal.value.show = false
  await serversStore.voiceMuteMember(sid, targetId, reason)
}

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
  if (!isAdmin.value) return  // guard: only admins/owners can create channels
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
const channelNotifState  = ref<{ channelId: string; serverId: string; x: number; y: number } | null>(null)
const channelAccessState = ref<{ show: boolean; channelId: string }>({ show: false, channelId: '' })

function openChannelMenu(e: MouseEvent, channelId: string) {
  const items: MenuItem[] = []

  if (isAdmin.value) {
    items.push({
      type: 'action',
      label: 'Rename',
      callback: () => startRename(channelId),
    })
    items.push({
      type: 'action',
      label: 'Access Settings',
      callback: () => { channelAccessState.value = { show: true, channelId } },
    })
  }

  items.push({
    type: 'action',
    label: 'Notification settings',
    callback: () => openChannelNotifPopover(e, channelId),
  })

  if (isAdmin.value) {
    items.push({ type: 'separator' })
    items.push({
      type: 'action',
      label: 'Delete Channel',
      danger: true,
      callback: () => deleteChannel(channelId),
    })
  }

  uiStore.showContextMenu(e.clientX, e.clientY, items)
}

function openChannelNotifPopover(e: MouseEvent, channelId: string) {
  const serverId = serversStore.activeServerId ?? ''
  channelNotifState.value = { channelId, serverId, x: e.clientX, y: e.clientY }
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

function openServerSettingsDirect() {
  const sid = serversStore.activeServerId
  if (!sid) return
  uiStore.openServerSettings(sid)
}

function openServerInvite() {
  const sid = serversStore.activeServerId
  if (!sid) return
  uiStore.openInviteModal(sid)
}

// ── Own status ────────────────────────────────────────────────────────────────

const STATUS_KEY = 'gamechat_own_status'
const statusKey  = () => identityStore.userId ? `${STATUS_KEY}_${identityStore.userId}` : STATUS_KEY
// Read the correct scoped key once userId is known (identity loads asynchronously).
const ownStatus = ref<'online' | 'idle' | 'dnd' | 'offline'>('online')
watchEffect(() => {
  if (identityStore.userId) {
    ownStatus.value = (localStorage.getItem(statusKey()) as typeof ownStatus.value | null) ?? 'online'
  }
})

// ── Auto-idle ─────────────────────────────────────────────────────────────────
// Automatically transition to 'idle' after the window has been unfocused for
// IDLE_DELAY_MS. Reverts to 'online' when focus returns (only if we auto-set it).

const IDLE_DELAY_MS = 5 * 60 * 1000 // 5 minutes
let idleTimer: ReturnType<typeof setTimeout> | null = null
let autoIdled = false

function onWindowBlur() {
  if (ownStatus.value !== 'online') return
  idleTimer = setTimeout(() => {
    autoIdled = true
    setOwnStatus('idle')
  }, IDLE_DELAY_MS)
}

function onWindowFocus() {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null }
  if (autoIdled) {
    autoIdled = false
    setOwnStatus('online')
  }
}

onMounted(() => {
  window.addEventListener('blur',  onWindowBlur)
  window.addEventListener('focus', onWindowFocus)
})

onUnmounted(() => {
  window.removeEventListener('blur',  onWindowBlur)
  window.removeEventListener('focus', onWindowFocus)
  if (idleTimer) clearTimeout(idleTimer)
})

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
  // If the user manually sets a status, cancel any pending auto-idle and clear the flag.
  if (!autoIdled) {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null }
  }
  autoIdled = false
  ownStatus.value = status
  localStorage.setItem(statusKey(), status)
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

.mobile-back-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  background: none;
  border: none;
  color: var(--text-secondary);
  cursor: pointer;
  padding: 0;
  transform: none;
  flex-shrink: 0;
  margin-right: 4px;
}

.mobile-back-btn:hover {
  color: var(--text-primary);
  transform: none;
}

.server-name {
  font-weight: 600;
  font-size: 15px;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
}

.server-header-actions {
  display: flex;
  align-items: center;
  gap: 2px;
  flex-shrink: 0;
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
