<template>
  <div class="tab-content help-tab">
    <div class="help-section">
      <h3 class="help-section-title">About</h3>
      <p class="setting-hint">Version {{ appVersion }}</p>
      <button class="btn-sm help-btn" :disabled="updateChecking" @click="manualCheckForUpdate">
        <AppIcon :path="mdiUpdate" :size="14" style="vertical-align:middle;margin-right:5px" />
        {{ updateChecking ? 'Checking…' : 'Check for updates' }}
      </button>
    </div>

    <div class="help-section">
      <h3 class="help-section-title">Support</h3>
      <p class="setting-hint">Report issues or request features on GitHub.</p>
      <button class="btn-sm help-btn" @click="openRepo">
        Open repository
      </button>
    </div>

    <div class="help-section">
      <h3 class="help-section-title">Logging</h3>
      <p class="setting-hint">Controls log verbosity in the browser console and log file.</p>
      <div class="setting-row">
        <label class="setting-label">Log level</label>
        <select class="setting-select" v-model="settingsStore.settings.logLevel">
          <option value="debug">Debug — ICE, signaling, sync detail</option>
          <option value="info">Info — connections, joins, errors (recommended)</option>
          <option value="warn">Warn — warnings and errors only</option>
          <option value="error">Error — errors only</option>
          <option value="silent">Silent — no logging</option>
        </select>
      </div>
    </div>

    <div class="help-section">
      <h3 class="help-section-title">Developer</h3>
      <p class="setting-hint">Open the browser developer tools for debugging.</p>
      <button class="btn-sm help-btn" @click="openDevTools">
        Open developer tools
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { mdiUpdate } from '@mdi/js'
import { useUIStore } from '@/stores/uiStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { version as appVersion } from '../../../package.json'
import { checkForUpdate, downloadAndInstallUpdate } from '@/utils/updateService'

const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
const uiStore = useUIStore()
const settingsStore = useSettingsStore()

const updateChecking = ref(false)

async function manualCheckForUpdate() {
  updateChecking.value = true
  try {
    const result = await checkForUpdate()
    if (result.available && result.version) {
      uiStore.showNotification(
        `v${result.version} is available`,
        'info',
        0,
        { label: 'Install update', callback: () => downloadAndInstallUpdate() }
      )
    } else {
      uiStore.showNotification("You're on the latest version.", 'success')
    }
  } finally {
    updateChecking.value = false
  }
}

function openRepo() {
  // TODO: replace with your repo URL
  const repoUrl = 'https://github.com/wolf123450/HexField'
  if (isTauri) {
    import('@tauri-apps/plugin-opener').then(m => m.openUrl(repoUrl)).catch(() => {})
  } else {
    window.open(repoUrl, '_blank', 'noopener')
  }
}

function openDevTools() {
  if (isTauri) {
    import('@tauri-apps/api/core')
      .then(m => m.invoke('open_devtools'))
      .catch(e => console.warn('[devtools] open_devtools failed:', e))
  }
}
</script>

<style scoped>
@import './settingsStyles.css';

.help-tab { display: flex; flex-direction: column; gap: var(--spacing-xl); }
.help-section { display: flex; flex-direction: column; gap: 8px; }
.help-section-title {
  font-size: 12px; font-weight: 600; color: var(--text-secondary);
  text-transform: uppercase; letter-spacing: 0.06em; margin: 0;
}
.help-btn {
  background: var(--bg-tertiary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  color: var(--text-primary);
  padding: 6px 14px;
  font-size: 12px;
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s;
  display: inline-flex;
  align-items: center;
  width: fit-content;
}
.help-btn:hover { background: var(--bg-hover); border-color: var(--accent-color); }
</style>
