<template>
  <div
    class="peer-tile"
    :class="{
      speaking: isSpeaking,
      muted: !peer.audioEnabled,
      'screen-sharing': peer.screenSharing,
    }"
    :title="displayName"
  >
    <div class="avatar-wrap">
      <div class="speaking-ring" />
      <AvatarImage :src="member?.avatarDataUrl ?? null" :name="displayName" :size="36" class="avatar" />
      <div v-if="!peer.audioEnabled && !peer.adminMuted" class="mute-indicator">
        <AppIcon :path="mdiMicrophoneOff" :size="10" />
      </div>
      <div v-if="peer.adminMuted" class="admin-mute-indicator" title="Admin muted">
        <AppIcon :path="mdiMicrophoneOff" :size="10" />
      </div>
      <div v-if="isPersonalMuted" class="personal-mute-indicator" title="Personally muted">
        <AppIcon :path="mdiVolumeMute" :size="10" />
      </div>
      <div v-if="peer.screenSharing" class="screen-indicator">
        <AppIcon :path="mdiMonitorShare" :size="10" />
      </div>
    </div>
    <div class="peer-name">{{ displayName }}</div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { mdiMicrophoneOff, mdiMonitorShare, mdiVolumeMute } from '@mdi/js'
import type { Peer } from '@/types/core'
import { useServersStore } from '@/stores/serversStore'
import { useVoiceStore } from '@/stores/voiceStore'
import { usePersonalBlocksStore } from '@/stores/personalBlocksStore'

const props = defineProps<{
  peer:     Peer
  serverId: string
}>()

const serversStore          = useServersStore()
const voiceStore            = useVoiceStore()
const personalBlocksStore   = usePersonalBlocksStore()

const isSpeaking     = computed(() => voiceStore.speakingPeers.has(props.peer.userId))
const isPersonalMuted = computed(() => personalBlocksStore.isMuted(props.peer.userId))

const member = computed(() => serversStore.members[props.serverId]?.[props.peer.userId])

const displayName = computed(() => member.value?.displayName ?? props.peer.userId.slice(0, 8))
</script>

<style scoped>
.peer-tile {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 4px 8px;
  border-radius: var(--radius-md);
  cursor: default;
  transition: background var(--transition-fast);
}

.peer-tile:hover {
  background: rgba(255, 255, 255, 0.06);
}

.avatar-wrap {
  position: relative;
  width: 36px;
  height: 36px;
}

.speaking-ring {
  position: absolute;
  inset: -3px;
  border-radius: 50%;
  border: 2px solid transparent;
  transition: border-color 0.15s;
  pointer-events: none;
}

.peer-tile.speaking .speaking-ring {
  border-color: #3ba55d;
  box-shadow: 0 0 0 2px rgba(59, 165, 93, 0.4);
  animation: pulse-ring 1.2s ease-in-out infinite;
}

@keyframes pulse-ring {
  0%, 100% { box-shadow: 0 0 0 2px rgba(59, 165, 93, 0.4); }
  50%       { box-shadow: 0 0 0 5px rgba(59, 165, 93, 0.15); }
}

.avatar {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  background: var(--accent-color);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  font-weight: 700;
  color: white;
  user-select: none;
}

.peer-tile.muted .avatar {
  opacity: 0.65;
}

.mute-indicator,
.admin-mute-indicator,
.personal-mute-indicator,
.screen-indicator {
  position: absolute;
  bottom: -2px;
  right: -2px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1.5px solid var(--bg-secondary);
}

.mute-indicator {
  background: #ed4245;
  color: white;
}

.admin-mute-indicator {
  background: #f0b232;
  color: #111;
}

.personal-mute-indicator {
  background: #5865f2;
  color: white;
}

.screen-indicator {
  background: var(--accent-color);
  color: white;
}

.peer-name {
  font-size: 11px;
  color: var(--text-secondary);
  max-width: 60px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: center;
}
</style>
