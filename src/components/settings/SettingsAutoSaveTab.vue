<template>
  <div class="tab-content">
    <div class="setting-row">
      <label class="setting-label">Auto-save interval</label>
      <div class="setting-control">
        <select
          :value="settings.autoSaveInterval"
          @change="update('autoSaveInterval', Number(($event.target as HTMLSelectElement).value))"
          class="setting-select"
        >
          <option :value="0">Off</option>
          <option :value="5000">5 seconds</option>
          <option :value="10000">10 seconds</option>
          <option :value="30000">30 seconds</option>
          <option :value="60000">1 minute</option>
          <option :value="300000">5 minutes</option>
        </select>
      </div>
    </div>
    <p class="setting-hint">
      Use <kbd>Ctrl+S</kbd> to save manually at any time.
    </p>
  </div>
</template>

<script setup lang="ts">
import { useSettingsStore } from '@/stores/settingsStore'

const settingsStore = useSettingsStore()
const settings = settingsStore.settings

function update<K extends keyof typeof settings>(key: K, value: (typeof settings)[K]) {
  settingsStore.updateSetting(key, value)
}
</script>

<style scoped>
@import './settingsStyles.css';
</style>
