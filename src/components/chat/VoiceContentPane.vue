<template>
  <div class="voice-pane">
    <!-- Toolbar -->
    <div class="voice-pane-toolbar">
      <span class="voice-pane-title">
        <AppIcon :path="mdiVolumeHigh" :size="16" />
        {{ channelName }}
      </span>
      <div class="toolbar-actions">
        <button
          class="tb-btn"
          :class="{ active: hideNonVideo }"
          title="Hide participants without video"
          @click="hideNonVideo = !hideNonVideo"
        >
          <AppIcon :path="hideNonVideo ? mdiEyeOff : mdiEye" :size="16" />
          <span>{{ hideNonVideo ? 'Show all' : 'Video only' }}</span>
        </button>
        <button
          class="tb-btn"
          title="Open chat"
          :class="{ active: chatOpen }"
          @click="chatOpen = !chatOpen"
        >
          <AppIcon :path="mdiMessageText" :size="16" />
          <span>Chat</span>
        </button>
      </div>
    </div>

    <!-- Main area -->
    <div class="voice-pane-body">
      <!-- Video grid -->
      <div class="video-grid" :class="`grid-${activeTiles.length}`">
        <!-- Own screen share -->
        <div
          v-if="voiceStore.screenStream && !hiddenStreams.has('local')"
          class="video-tile"
          :class="{ focused: focusedId === 'local' }"
          @click="toggleFocus('local')"
        >
          <video
            :srcObject="voiceStore.screenStream"
            autoplay
            muted
            playsinline
            class="video-el mirror"
          />
          <div class="tile-overlay">
            <span class="tile-label">
              <AppIcon :path="mdiMonitorShare" :size="12" />
              You (sharing)
            </span>
            <button class="tile-hide-btn" title="Hide" @click.stop="hiddenStreams.add('local')">
              <AppIcon :path="mdiEyeOff" :size="14" />
            </button>
          </div>
        </div>

        <!-- Remote screen shares -->
        <div
          v-for="[userId] in remoteShares"
          :key="userId"
          class="video-tile"
          :class="{ focused: focusedId === userId }"
          @click="toggleFocus(userId)"
        >
          <video
            :ref="el => bindVideo(el as HTMLVideoElement | null, userId)"
            autoplay
            playsinline
            class="video-el"
          />
          <div class="tile-overlay">
            <span class="tile-label">
              <AppIcon :path="mdiMonitorShare" :size="12" />
              {{ peerName(userId) }}
            </span>
            <button class="tile-hide-btn" title="Hide" @click.stop="hiddenStreams.add(userId)">
              <AppIcon :path="mdiEyeOff" :size="14" />
            </button>
          </div>
        </div>

        <!-- Non-video peers (shown unless hideNonVideo) -->
        <template v-if="!hideNonVideo">
          <div
            v-for="peer in nonVideoPeers"
            :key="peer.userId"
            class="video-tile avatar-tile"
            :class="{ speaking: voiceStore.speakingPeers.has(peer.userId) }"
          >
            <div class="av-ring" />
            <div class="av-avatar">{{ peerInitials(peer.userId) }}</div>
            <div class="tile-overlay">
              <span class="tile-label">{{ peerName(peer.userId) }}</span>
            </div>
          </div>
        </template>

        <!-- Empty state -->
        <div v-if="activeTiles.length === 0" class="empty-grid">
          <AppIcon :path="mdiVolumeHigh" :size="48" />
          <p>No one is sharing their screen yet</p>
        </div>
      </div>

      <!-- Hidden tile restore bar -->
      <div v-if="hiddenStreams.size" class="hidden-bar">
        <span class="hidden-label">{{ hiddenStreams.size }} hidden</span>
        <button class="tb-btn" @click="hiddenStreams.clear()">Show all</button>
      </div>

      <!-- Chat overlay panel -->
      <div v-if="chatOpen && channelId" class="chat-overlay">
        <MessageHistory :channel-id="channelId" />
        <MessageInput :channel-id="channelId" :server-id="serverId" />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, reactive, watchEffect } from 'vue'
import {
  mdiVolumeHigh,
  mdiMonitorShare,
  mdiEye,
  mdiEyeOff,
  mdiMessageText,
} from '@mdi/js'
import { useVoiceStore }    from '@/stores/voiceStore'
import { useChannelsStore } from '@/stores/channelsStore'
import { useServersStore }  from '@/stores/serversStore'
import MessageHistory from '@/components/chat/MessageHistory.vue'
import MessageInput   from '@/components/chat/MessageInput.vue'

const voiceStore    = useVoiceStore()
const channelsStore = useChannelsStore()
const serversStore  = useServersStore()

const chatOpen    = ref(false)
const hideNonVideo = ref(false)
const focusedId   = ref<string | null>(null)
const hiddenStreams = reactive(new Set<string>())

const channelId = computed(() => voiceStore.session?.channelId ?? null)
const serverId  = computed(() => voiceStore.session?.serverId  ?? '')

const channelName = computed(() => {
  const sid = serverId.value
  const cid = channelId.value
  if (!sid || !cid) return ''
  return channelsStore.channels[sid]?.find(c => c.id === cid)?.name ?? ''
})

// Remote shares visible (not hidden)
const remoteShares = computed<[string, MediaStream][]>(() =>
  Object.entries(voiceStore.screenStreams).filter(([userId]) => !hiddenStreams.has(userId))
)

// Non-video peers (in session, no screen share, not hidden)
const nonVideoPeers = computed(() =>
  Object.values(voiceStore.peers).filter(p => !voiceStore.screenStreams[p.userId])
)

// Total active tiles (for grid sizing)
const activeTiles = computed(() => {
  const tiles: string[] = []
  if (voiceStore.screenStream && !hiddenStreams.has('local')) tiles.push('local')
  for (const [userId] of remoteShares.value) tiles.push(userId)
  if (!hideNonVideo.value) nonVideoPeers.value.forEach(p => tiles.push(p.userId))
  return tiles
})

function toggleFocus(id: string) {
  focusedId.value = focusedId.value === id ? null : id
}

// Bind reactive MediaStream to <video> srcObject
const videoRefs = new Map<string, HTMLVideoElement>()

function bindVideo(el: HTMLVideoElement | null, userId: string) {
  if (el) {
    videoRefs.set(userId, el)
    const stream = voiceStore.screenStreams[userId]
    if (stream && el.srcObject !== stream) el.srcObject = stream
  } else {
    videoRefs.delete(userId)
  }
}

// Re-assign srcObject when screenStreams entries change
watchEffect(() => {
  for (const [userId, stream] of Object.entries(voiceStore.screenStreams)) {
    const el = videoRefs.get(userId)
    if (el && el.srcObject !== stream) el.srcObject = stream
  }
})

function peerName(userId: string): string {
  const sid = serverId.value
  return serversStore.members[sid]?.[userId]?.displayName ?? userId.slice(0, 8)
}

function peerInitials(userId: string): string {
  const name = peerName(userId)
  return name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase()
}
</script>

<style scoped>
.voice-pane {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--bg-primary);
  overflow: hidden;
}

.voice-pane-toolbar {
  display: flex;
  align-items: center;
  padding: 0 var(--spacing-md);
  height: 48px;
  border-bottom: 1px solid var(--border-color);
  flex-shrink: 0;
  gap: var(--spacing-md);
}

.voice-pane-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-weight: 600;
  font-size: 15px;
  color: var(--text-primary);
}

.toolbar-actions {
  margin-left: auto;
  display: flex;
  gap: var(--spacing-sm);
}

.tb-btn {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 4px var(--spacing-sm);
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-secondary);
  font-size: 13px;
  cursor: pointer;
  transition: background var(--transition-fast), color var(--transition-fast);
  transform: none;
}
.tb-btn:hover { background: var(--bg-secondary); color: var(--text-primary); }
.tb-btn.active { background: var(--bg-tertiary); color: var(--accent-color); }

.voice-pane-body {
  flex: 1;
  display: flex;
  overflow: hidden;
  position: relative;
}

/* Video grid */
.video-grid {
  flex: 1;
  display: grid;
  gap: 6px;
  padding: var(--spacing-md);
  overflow: auto;
  align-content: start;
}

.video-grid.grid-0  { grid-template-columns: 1fr; place-items: center; }
.video-grid.grid-1  { grid-template-columns: 1fr; }
.video-grid.grid-2  { grid-template-columns: repeat(2, 1fr); }
.video-grid.grid-3,
.video-grid.grid-4  { grid-template-columns: repeat(2, 1fr); }
.video-grid.grid-5,
.video-grid.grid-6  { grid-template-columns: repeat(3, 1fr); }

.video-tile {
  position: relative;
  background: var(--bg-secondary);
  border-radius: var(--radius-md);
  overflow: hidden;
  cursor: pointer;
  aspect-ratio: 16 / 9;
  border: 2px solid transparent;
  transition: border-color 0.15s;
}
.video-tile:hover { border-color: var(--accent-color); }
.video-tile.focused {
  grid-column: 1 / -1;
  aspect-ratio: 16 / 9;
  border-color: var(--accent-color);
}

.video-el {
  width: 100%;
  height: 100%;
  object-fit: contain;
  display: block;
}
.video-el.mirror { transform: scaleX(-1); }

/* Avatar tile (non-video peer) */
.avatar-tile {
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: default;
}

.av-ring {
  position: absolute;
  inset: -2px;
  border-radius: var(--radius-md);
  border: 3px solid transparent;
  pointer-events: none;
  transition: border-color 0.15s;
}

.avatar-tile.speaking .av-ring {
  border-color: #3ba55d;
  animation: pulse-border 1.2s ease-in-out infinite;
}

@keyframes pulse-border {
  0%, 100% { opacity: 1; }
  50%       { opacity: 0.5; }
}

.av-avatar {
  width: 64px;
  height: 64px;
  border-radius: 50%;
  background: var(--accent-color);
  color: white;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 24px;
  font-weight: 700;
}

/* Tile overlay (label + hide button) */
.tile-overlay {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  padding: 6px 8px;
  background: linear-gradient(transparent, rgba(0,0,0,0.65));
  display: flex;
  align-items: center;
  gap: 6px;
  opacity: 0;
  transition: opacity 0.15s;
}

.video-tile:hover .tile-overlay,
.avatar-tile .tile-overlay { opacity: 1; }

.tile-label {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  font-weight: 600;
  color: #ffffff;
  text-shadow: 0 1px 3px rgba(0,0,0,0.8);
}

.tile-hide-btn {
  background: rgba(255,255,255,0.15);
  border: none;
  border-radius: 4px;
  color: white;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 2px;
  transform: none;
}
.tile-hide-btn:hover { background: rgba(255,255,255,0.3); }

/* Hidden bar */
.hidden-bar {
  position: absolute;
  bottom: var(--spacing-sm);
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  padding: 4px var(--spacing-sm);
  font-size: 12px;
  color: var(--text-secondary);
  box-shadow: var(--shadow-md);
}

.hidden-label { color: var(--text-tertiary); }

/* Empty grid */
.empty-grid {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--spacing-md);
  color: var(--text-tertiary);
  padding: var(--spacing-xl);
}
.empty-grid p { font-size: 14px; }

/* Chat overlay */
.chat-overlay {
  width: 320px;
  flex-shrink: 0;
  border-left: 1px solid var(--border-color);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--bg-primary);
}
</style>
