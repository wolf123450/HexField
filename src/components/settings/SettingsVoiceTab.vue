<template>
  <div class="settings-section">
    <h3>Voice & Video</h3>

    <div class="form-row">
      <label class="form-label">Noise Suppression</label>
      <label class="toggle-row">
        <input type="checkbox" v-model="noiseSuppression" @change="saveNoiseSuppression" />
        <span>Reduce background noise and echo</span>
      </label>
      <p class="form-hint">Applies noiseSuppression, echoCancellation, and autoGainControl on the microphone input. Takes effect on next voice channel join.</p>
    </div>

    <div class="form-row">
      <label class="form-label">Voice Loopback Test</label>
      <p class="form-hint">While in a voice session, click the headset icon in the voice bar to hear your own microphone output. Use this to verify that your mic and audio settings are correct before calling others.</p>
    </div>

    <div class="form-row">
      <label class="form-label">Input Device (Microphone)</label>
      <select v-model="inputDevice" class="form-select" @change="saveInputDevice">
        <option value="">Default</option>
        <option v-for="d in audioInputs" :key="d.deviceId" :value="d.deviceId">{{ d.label || d.deviceId }}</option>
      </select>
    </div>

    <div class="form-row">
      <label class="form-label">Output Device (Speaker/Headphones)</label>
      <select v-model="outputDevice" class="form-select" @change="saveOutputDevice">
        <option value="">Default</option>
        <option v-for="d in audioOutputs" :key="d.deviceId" :value="d.deviceId">{{ d.label || d.deviceId }}</option>
      </select>
    </div>

    <div class="form-row">
      <label class="form-label">Custom TURN Servers</label>
      <textarea
        v-model="turnServersText"
        class="form-textarea"
        placeholder='[{"urls": "turn:yourserver.com:3478", "username": "user", "credential": "pass"}]'
        rows="4"
        @change="saveTURNServers"
      />
      <p class="form-hint">JSON array of RTCIceServer objects. Leave blank to use peer-relay only.</p>
    </div>

    <div class="form-row">
      <label class="form-label">Rendezvous Server URL</label>
      <input
        v-model="rendezvousUrl"
        type="text"
        class="form-input"
        placeholder="wss://your-server.example.com"
        @change="saveRendezvousUrl"
      />
      <p class="form-hint">Optional. App works without a rendezvous server via QR code and LAN discovery.</p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useSettingsStore } from '@/stores/settingsStore'

const settingsStore = useSettingsStore()
const inputDevice   = ref(settingsStore.settings.inputDeviceId)
const outputDevice  = ref(settingsStore.settings.outputDeviceId)
const rendezvousUrl = ref(settingsStore.settings.rendezvousServerUrl)
const noiseSuppression = ref(settingsStore.settings.noiseSuppression)
const audioInputs   = ref<MediaDeviceInfo[]>([])
const audioOutputs  = ref<MediaDeviceInfo[]>([])
const turnServersText = ref(
  settingsStore.settings.customTURNServers.length
    ? JSON.stringify(settingsStore.settings.customTURNServers, null, 2)
    : ''
)

onMounted(async () => {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices()
    audioInputs.value  = devices.filter(d => d.kind === 'audioinput')
    audioOutputs.value = devices.filter(d => d.kind === 'audiooutput')
  } catch {}
})

function saveInputDevice()   { settingsStore.updateSetting('inputDeviceId', inputDevice.value) }
function saveOutputDevice()  { settingsStore.updateSetting('outputDeviceId', outputDevice.value) }
function saveRendezvousUrl() { settingsStore.updateSetting('rendezvousServerUrl', rendezvousUrl.value.trim()) }
function saveNoiseSuppression() { settingsStore.updateSetting('noiseSuppression', noiseSuppression.value) }
function saveTURNServers() {
  try {
    const servers = turnServersText.value.trim() ? JSON.parse(turnServersText.value) : []
    settingsStore.updateSetting('customTURNServers', servers)
  } catch {}
}
</script>

<style scoped>
.settings-section h3 { margin-bottom: var(--spacing-lg); }
.form-row { margin-bottom: var(--spacing-lg); }
.form-label { display: block; font-size: 12px; font-weight: 600; color: var(--text-secondary); margin-bottom: var(--spacing-xs); text-transform: uppercase; letter-spacing: 0.04em; }
.form-select, .form-input { width: 100%; padding: 8px var(--spacing-sm); background: var(--bg-primary); border: 1px solid var(--border-color); border-radius: var(--radius-sm); color: var(--text-primary); font-size: 14px; }
.form-select:focus, .form-input:focus { outline: none; border-color: var(--accent-color); }
.form-textarea { width: 100%; padding: 8px var(--spacing-sm); background: var(--bg-primary); border: 1px solid var(--border-color); border-radius: var(--radius-sm); color: var(--text-primary); font-size: 13px; font-family: monospace; resize: vertical; }
.form-textarea:focus { outline: none; border-color: var(--accent-color); }
.form-hint { font-size: 11px; color: var(--text-tertiary); margin-top: var(--spacing-xs); }
.toggle-row { display: flex; align-items: center; gap: var(--spacing-sm); cursor: pointer; font-size: 14px; color: var(--text-primary); }
.toggle-row input[type=checkbox] { width: 16px; height: 16px; accent-color: var(--accent-color); }
</style>
