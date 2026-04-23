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
        <option v-for="d in audioInputs" :key="d.id" :value="d.id">{{ d.name }}</option>
      </select>
      <div v-if="inputDeviceMissing" class="device-warning">⚠ Selected input device not found — Default will be used</div>
    </div>

    <div class="form-row">
      <label class="form-label">Output Device (Speaker/Headphones)</label>
      <select v-model="outputDevice" class="form-select" @change="saveOutputDevice">
        <option value="">Default</option>
        <option v-for="d in audioOutputs" :key="d.id" :value="d.id">{{ d.name }}</option>
      </select>
      <div v-if="outputDeviceMissing" class="device-warning">⚠ Selected output device not found — Default will be used</div>
    </div>

    <div class="form-row">
      <label class="form-label">Screen Share Resolution</label>
      <select v-model="videoQuality" class="form-select" @change="saveVideoQuality">
        <option value="auto">Auto (match source)</option>
        <option value="360p">360p — Low bandwidth</option>
        <option value="720p">720p — Balanced</option>
        <option value="1080p">1080p — High quality</option>
      </select>
      <p class="form-hint">Maximum resolution when sharing your screen. Takes effect on next screen share.</p>
    </div>

    <div class="form-row">
      <label class="form-label">Screen Share Frame Rate</label>
      <select v-model="videoFrameRate" class="form-select" @change="saveVideoFrameRate">
        <option :value="10">10 fps — Minimal bandwidth</option>
        <option :value="15">15 fps — Balanced</option>
        <option :value="30">30 fps — Smooth</option>
        <option :value="60">60 fps — Ultra smooth</option>
      </select>
    </div>

    <div class="form-row">
      <label class="form-label">Screen Share Bitrate Cap</label>
      <select v-model="videoBitrate" class="form-select" @change="saveVideoBitrate">
        <option value="auto">Auto</option>
        <option value="500kbps">500 kbps — Low</option>
        <option value="1mbps">1 Mbps — Balanced</option>
        <option value="2.5mbps">2.5 Mbps — High</option>
        <option value="5mbps">5 Mbps — Very High</option>
        <option value="10mbps">10 Mbps — Maximum</option>
      </select>
      <p class="form-hint">Limits the maximum outgoing bitrate for screen sharing. Lower values reduce CPU and bandwidth usage.</p>
    </div>

    <div v-if="settingsStore.settings.experimentalNewPipeline" class="form-row">
      <label class="form-label">Screen Share Downscale Method</label>
      <select v-model="videoDownscaleMethod" class="form-select" @change="saveDownscaleMethod">
        <option value="nearest">Nearest Neighbor — Fastest, pixelated</option>
        <option value="bilinear">Bilinear — Smooth, balanced</option>
        <option value="bicubic">Bicubic — Sharp, detailed</option>
        <option value="lanczos3">Lanczos-3 — Sharpest, most CPU</option>
      </select>
      <p class="form-hint">Algorithm used when downscaling to the target resolution. Takes effect on next screen share.</p>
    </div>

  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { useSettingsStore } from '@/stores/settingsStore'

interface AudioDeviceInfo { id: string; name: string }
interface AudioDeviceList { inputs: AudioDeviceInfo[]; outputs: AudioDeviceInfo[] }

const settingsStore = useSettingsStore()
const inputDevice   = ref(settingsStore.settings.inputDeviceId)
const outputDevice  = ref(settingsStore.settings.outputDeviceId)
const noiseSuppression = ref(settingsStore.settings.noiseSuppression)
const videoQuality  = ref(settingsStore.settings.videoQuality)
const videoBitrate  = ref(settingsStore.settings.videoBitrate)
const videoFrameRate = ref<10 | 15 | 30 | 60>(settingsStore.settings.videoFrameRate)
const videoDownscaleMethod = ref(settingsStore.settings.videoDownscaleMethod)
const audioInputs   = ref<AudioDeviceInfo[]>([])
const audioOutputs  = ref<AudioDeviceInfo[]>([])
const inputDeviceMissing  = computed(() => inputDevice.value !== '' && audioInputs.value.length > 0 && !audioInputs.value.some(d => d.id === inputDevice.value))
const outputDeviceMissing = computed(() => outputDevice.value !== '' && audioOutputs.value.length > 0 && !audioOutputs.value.some(d => d.id === outputDevice.value))

let unlistenDevices: UnlistenFn | null = null

async function refreshDevices() {
  try {
    const list = await invoke<AudioDeviceList>('media_enumerate_devices')
    audioInputs.value  = list.inputs
    audioOutputs.value = list.outputs
  } catch {}
}

onMounted(async () => {
  await refreshDevices()
  unlistenDevices = await listen<AudioDeviceList>('media_devices_changed', ({ payload }) => {
    audioInputs.value  = payload.inputs
    audioOutputs.value = payload.outputs
  })
})

onUnmounted(() => {
  unlistenDevices?.()
  unlistenDevices = null
})

function saveInputDevice() {
  settingsStore.updateSetting('inputDeviceId', inputDevice.value)
  invoke('media_set_input_device', { deviceName: inputDevice.value || null }).catch(() => {})
}
function saveOutputDevice() {
  settingsStore.updateSetting('outputDeviceId', outputDevice.value)
  invoke('media_set_output_device', { deviceName: outputDevice.value || null }).catch(() => {})
}
function saveNoiseSuppression() { settingsStore.updateSetting('noiseSuppression', noiseSuppression.value) }
function saveVideoQuality()  { settingsStore.updateSetting('videoQuality', videoQuality.value) }
function saveVideoBitrate()  { settingsStore.updateSetting('videoBitrate', videoBitrate.value) }
function saveVideoFrameRate() { settingsStore.updateSetting('videoFrameRate', videoFrameRate.value) }
function saveDownscaleMethod() { settingsStore.updateSetting('videoDownscaleMethod', videoDownscaleMethod.value as 'nearest' | 'bilinear' | 'bicubic' | 'lanczos3') }
</script>

<style scoped>
.settings-section h3 { margin-bottom: var(--spacing-lg); }
.form-row { margin-bottom: var(--spacing-lg); }
.form-label { display: block; font-size: 12px; font-weight: 600; color: var(--text-secondary); margin-bottom: var(--spacing-xs); text-transform: uppercase; letter-spacing: 0.04em; }
.form-select, .form-input { width: 100%; padding: 8px var(--spacing-sm); background: var(--bg-primary); border: 1px solid var(--border-color); border-radius: var(--radius-sm); color: var(--text-primary); font-size: 14px; }
.form-select:focus, .form-input:focus { outline: none; border-color: var(--accent-color); }
.form-hint { font-size: 11px; color: var(--text-tertiary); margin-top: var(--spacing-xs); }
.toggle-row { display: flex; align-items: center; gap: var(--spacing-sm); cursor: pointer; font-size: 14px; color: var(--text-primary); }
.toggle-row input[type=checkbox] { width: 16px; height: 16px; accent-color: var(--accent-color); }

.device-warning { font-size: 11px; color: var(--warning-color); margin-top: var(--spacing-xs); }
</style>
