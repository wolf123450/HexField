<template>
  <div v-if="voiceStore.session" class="voice-bar">
      <!-- Left: connection info -->
      <div class="voice-status">
        <span class="voice-channel-name">
          <AppIcon :path="mdiVolumeHigh" :size="14" />
          {{ channelName }}
        </span>
        <span class="voice-connected-label">Voice Connected</span>
      </div>

      <div class="voice-divider" />

      <!-- Centre: peer tiles -->
      <div class="voice-peers">
        <VoicePeerTile
          v-for="peer in peerList"
          :key="peer.userId"
          :peer="peer"
          :server-id="voiceStore.session!.serverId"
        />
        <span v-if="voiceStore.meshWarning" class="mesh-warning" title="Large voice channels degrade quality. An SFU server is recommended for >8 participants.">
          <AppIcon :path="mdiAlertCircle" :size="14" />
          {{ voiceStore.peerCount }}+ users
        </span>
      </div>

      <div class="voice-divider" />

      <!-- Right: controls -->
      <div class="voice-controls">
        <!-- Mute -->
        <button
          class="ctrl-btn"
          :class="{ active: voiceStore.isMuted }"
          :title="voiceStore.isMuted ? 'Unmute (Ctrl+Shift+M)' : 'Mute (Ctrl+Shift+M)'"
          @click="voiceStore.toggleMute()"
        >
          <AppIcon :path="voiceStore.isMuted ? mdiMicrophoneOff : mdiMicrophone" :size="18" />
        </button>

        <!-- Deafen -->
        <button
          class="ctrl-btn"
          :class="{ active: voiceStore.isDeafened }"
          :title="voiceStore.isDeafened ? 'Undeafen (Ctrl+Shift+D)' : 'Deafen (Ctrl+Shift+D)'"
          @click="voiceStore.toggleDeafen()"
        >
          <AppIcon :path="voiceStore.isDeafened ? mdiHeadphonesOff : mdiHeadphones" :size="18" />
        </button>

        <!-- Loopback -->
        <button
          class="ctrl-btn"
          :class="{ active: voiceStore.loopbackEnabled }"
          title="Hear your own voice (loopback)"
          @click="voiceStore.toggleLoopback()"
        >
          <AppIcon :path="mdiHeadset" :size="18" />
        </button>

        <!-- Screen share -->
        <button
          class="ctrl-btn"
          :class="{ active: !!voiceStore.screenStream }"
          :title="voiceStore.screenStream ? 'Stop share' : 'Share screen'"
          @click="toggleScreenShare"
        >
          <AppIcon :path="mdiMonitorShare" :size="18" />
        </button>

        <!-- Disconnect -->
        <button class="ctrl-btn disconnect" title="Leave voice channel" @click="voiceStore.leaveVoiceChannel()">
          <AppIcon :path="mdiPhoneHangup" :size="18" />
        </button>
      </div>
    </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import {
  mdiVolumeHigh,
  mdiMicrophone,
  mdiMicrophoneOff,
  mdiHeadphones,
  mdiHeadphonesOff,
  mdiHeadset,
  mdiMonitorShare,
  mdiPhoneHangup,
  mdiAlertCircle,
} from '@mdi/js'
import VoicePeerTile from '@/components/chat/VoicePeerTile.vue'
import { useVoiceStore }    from '@/stores/voiceStore'
import { useChannelsStore } from '@/stores/channelsStore'

const voiceStore    = useVoiceStore()
const channelsStore = useChannelsStore()

const peerList = computed(() => Object.values(voiceStore.peers))

const channelName = computed(() => {
  const session = voiceStore.session
  if (!session) return ''
  const ch = channelsStore.channels[session.serverId]?.find(c => c.id === session.channelId)
  return ch?.name ?? session.channelId
})

async function toggleScreenShare() {
  if (voiceStore.screenStream) {
    voiceStore.stopScreenShare()
  } else {
    try {
      await voiceStore.startScreenShare()
    } catch (e) {
      console.error('[VoiceBar] screen share failed:', e)
    }
  }
}
</script>

<style scoped>
.voice-bar {
  background: var(--bg-tertiary);
  border-top: 1px solid var(--border-color);
  display: flex;
  flex-direction: column;
  gap: var(--spacing-xs);
  padding: var(--spacing-sm) var(--spacing-md);
  flex-shrink: 0;
}

.voice-status {
  display: flex;
  flex-direction: column;
}

.voice-channel-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
  display: flex;
  align-items: center;
  gap: 4px;
}

.voice-connected-label {
  font-size: 10px;
  color: #3ba55d;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.voice-divider {
  display: none;
}

.voice-peers {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 2px;
  overflow: hidden;
}

.mesh-warning {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  color: var(--warning-color);
  padding: 2px 8px;
  border-radius: var(--radius-sm);
  background: rgba(255, 184, 77, 0.1);
}

.voice-controls {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-top: var(--spacing-xs);
}

.ctrl-btn {
  width: 34px;
  height: 34px;
  border-radius: var(--radius-md);
  background: transparent;
  border: none;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-secondary);
  padding: 0;
  transform: none;
  transition: background var(--transition-fast), color var(--transition-fast);
}

.ctrl-btn:hover {
  background: rgba(255, 255, 255, 0.08);
  color: var(--text-primary);
  transform: none;
}

.ctrl-btn.active {
  color: var(--accent-color);
  background: rgba(88, 101, 242, 0.15);
}

.ctrl-btn.disconnect {
  color: #ed4245;
}

.ctrl-btn.disconnect:hover {
  background: rgba(237, 66, 69, 0.15);
  color: #ed4245;
}
</style>
