<template>
  <div class="settings-section">
    <h3>Network</h3>

    <div class="form-row">
      <label class="form-label">NAT Type</label>
      <div class="nat-status">
        <span class="nat-badge" :class="`nat-${networkStore.natType}`">{{ natLabel }}</span>
        <span class="nat-hint">{{ natDescription }}</span>
      </div>
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
import { ref, computed } from 'vue'
import { useSettingsStore } from '@/stores/settingsStore'
import { useNetworkStore } from '@/stores/networkStore'

const settingsStore = useSettingsStore()
const networkStore  = useNetworkStore()

const rendezvousUrl = ref(settingsStore.settings.rendezvousServerUrl)
const turnServersText = ref(
  settingsStore.settings.customTURNServers.length
    ? JSON.stringify(settingsStore.settings.customTURNServers, null, 2)
    : ''
)

const natLabel = computed(() => ({
  open:       'Open',
  restricted: 'Restricted',
  symmetric:  'Symmetric (relay needed)',
  unknown:    'Unknown',
  pending:    'Detecting…',
}[networkStore.natType] ?? 'Unknown'))

const natDescription = computed(() => ({
  open:       'Direct peer connections work reliably.',
  restricted: 'Most peer connections succeed; relay used as fallback.',
  symmetric:  'Behind strict NAT — relay peers or TURN servers are required.',
  unknown:    'Could not determine NAT type — STUN probes failed or WebRTC is unavailable.',
  pending:    'NAT detection is still in progress.',
}[networkStore.natType] ?? ''))

function saveRendezvousUrl() { settingsStore.updateSetting('rendezvousServerUrl', rendezvousUrl.value.trim()) }
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
.form-input { width: 100%; padding: 8px var(--spacing-sm); background: var(--bg-primary); border: 1px solid var(--border-color); border-radius: var(--radius-sm); color: var(--text-primary); font-size: 14px; }
.form-input:focus { outline: none; border-color: var(--accent-color); }
.form-textarea { width: 100%; padding: 8px var(--spacing-sm); background: var(--bg-primary); border: 1px solid var(--border-color); border-radius: var(--radius-sm); color: var(--text-primary); font-size: 13px; font-family: monospace; resize: vertical; }
.form-textarea:focus { outline: none; border-color: var(--accent-color); }
.form-hint { font-size: 11px; color: var(--text-tertiary); margin-top: var(--spacing-xs); }
.nat-status { display: flex; align-items: center; gap: var(--spacing-sm); flex-wrap: wrap; }
.nat-badge { display: inline-block; padding: 2px 8px; border-radius: var(--radius-sm); font-size: 12px; font-weight: 600; }
.nat-open       { background: rgba(87, 242, 135, 0.15); color: var(--success-color); }
.nat-restricted { background: rgba(254, 231, 92,  0.15); color: var(--warning-color); }
.nat-symmetric  { background: rgba(237, 66,  69,  0.15); color: var(--error-color); }
.nat-unknown    { background: var(--bg-secondary); color: var(--text-secondary); }
.nat-hint { font-size: 12px; color: var(--text-secondary); }
</style>
