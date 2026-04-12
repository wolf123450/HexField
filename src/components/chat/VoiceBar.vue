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
          :class="{ active: voiceStore.isMuted, 'admin-muted': voiceStore.adminMuted }"
          :title="voiceStore.adminMuted ? 'Muted by admin' : voiceStore.isMuted ? 'Unmute (Ctrl+Shift+M)' : 'Mute (Ctrl+Shift+M)'"
          @click="voiceStore.toggleMute()"
        >
          <AppIcon :path="voiceStore.isMuted ? mdiMicrophoneOff : mdiMicrophone" :size="18" />
        </button>

        <!-- Device quick-switch -->
        <div class="device-menu-wrap">
          <button class="ctrl-btn" title="Switch audio device" @click.stop="toggleDeviceMenu">
            <AppIcon :path="mdiSwapHorizontal" :size="18" />
          </button>
          <div v-if="showDeviceMenu" class="device-menu">
            <div class="device-section-label">Input</div>
            <button
              v-for="d in audioInputs" :key="d.id"
              class="device-option"
              :class="{ active: d.id === currentInputId }"
              @click="switchInput(d.id)"
            >{{ d.name }}</button>
            <button class="device-option" :class="{ active: !currentInputId }" @click="switchInput('')">Default</button>
            <div class="device-section-label">Output</div>
            <button
              v-for="d in audioOutputs" :key="d.id"
              class="device-option"
              :class="{ active: d.id === currentOutputId }"
              @click="switchOutput(d.id)"
            >{{ d.name }}</button>
            <button class="device-option" :class="{ active: !currentOutputId }" @click="switchOutput('')">Default</button>
          </div>
        </div>

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

        <!-- Screen share (desktop only — no getDisplayMedia on mobile) -->
        <button
          v-if="!isMobile"
          class="ctrl-btn"
          :class="{ active: voiceStore.screenShareActive }"
          :title="voiceStore.screenShareActive ? 'Stop share' : 'Share screen'"
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
import { computed, ref, onMounted, onUnmounted } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
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
  mdiSwapHorizontal,
} from '@mdi/js'
import VoicePeerTile from '@/components/chat/VoicePeerTile.vue'
import { useVoiceStore }    from '@/stores/voiceStore'
import { useChannelsStore } from '@/stores/channelsStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { useBreakpoint } from '@/utils/useBreakpoint'

interface AudioDeviceInfo { id: string; name: string }
interface AudioDeviceList { inputs: AudioDeviceInfo[]; outputs: AudioDeviceInfo[] }

const voiceStore    = useVoiceStore()
const channelsStore = useChannelsStore()
const settingsStore = useSettingsStore()
const { isMobile } = useBreakpoint()

const showDeviceMenu = ref(false)
const audioInputs    = ref<AudioDeviceInfo[]>([])
const audioOutputs   = ref<AudioDeviceInfo[]>([])
const currentInputId  = computed(() => settingsStore.settings.inputDeviceId)
const currentOutputId = computed(() => settingsStore.settings.outputDeviceId)

const peerList = computed(() => Object.values(voiceStore.peers))

const channelName = computed(() => {
  const session = voiceStore.session
  if (!session) return ''
  const ch = channelsStore.channels[session.serverId]?.find(c => c.id === session.channelId)
  return ch?.name ?? session.channelId
})

async function toggleScreenShare() {
  if (voiceStore.screenShareActive) {
    await voiceStore.stopScreenShare()
  } else {
    try {
      await voiceStore.startScreenShare()
    } catch (e) {
      console.error('[VoiceBar] screen share failed:', e)
    }
  }
}

function toggleDeviceMenu() { showDeviceMenu.value = !showDeviceMenu.value }
function closeDeviceMenu()  { showDeviceMenu.value = false }

async function switchInput(deviceId: string) {
  settingsStore.updateSetting('inputDeviceId', deviceId)
  await invoke('media_set_input_device', { deviceName: deviceId || null }).catch(() => {})
  closeDeviceMenu()
}

async function switchOutput(deviceId: string) {
  settingsStore.updateSetting('outputDeviceId', deviceId)
  await invoke('media_set_output_device', { deviceName: deviceId || null }).catch(() => {})
  closeDeviceMenu()
}

let unlistenDevices: UnlistenFn | null = null

onMounted(async () => {
  try {
    const list = await invoke<AudioDeviceList>('media_enumerate_devices')
    audioInputs.value  = list.inputs
    audioOutputs.value = list.outputs
  } catch {}
  unlistenDevices = await listen<AudioDeviceList>('media_devices_changed', ({ payload }) => {
    audioInputs.value  = payload.inputs
    audioOutputs.value = payload.outputs
  })
  document.addEventListener('click', closeDeviceMenu)
})

onUnmounted(() => {
  unlistenDevices?.()
  unlistenDevices = null
  document.removeEventListener('click', closeDeviceMenu)
})
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

.ctrl-btn.admin-muted {
  color: #f0b232;
  background: rgba(240, 178, 50, 0.15);
  cursor: not-allowed;
}

.ctrl-btn.disconnect {
  color: #ed4245;
}

.ctrl-btn.disconnect:hover {
  background: rgba(237, 66, 69, 0.15);
  color: #ed4245;
}

.device-menu-wrap {
  position: relative;
}

.device-menu {
  position: absolute;
  bottom: 100%;
  left: 0;
  margin-bottom: 4px;
  background: var(--bg-tertiary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  padding: var(--spacing-xs);
  min-width: 200px;
  max-height: 300px;
  overflow-y: auto;
  z-index: 10;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
}

.device-section-label {
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-tertiary);
  padding: var(--spacing-xs) var(--spacing-sm);
}

.device-option {
  display: block;
  width: 100%;
  text-align: left;
  padding: 6px var(--spacing-sm);
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-secondary);
  font-size: 13px;
  cursor: pointer;
  transform: none;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.device-option:hover {
  background: var(--bg-secondary);
  color: var(--text-primary);
  transform: none;
}

.device-option.active {
  color: var(--accent-color);
}
</style>
