<template>
  <div class="settings-section">
    <h3>Notifications</h3>

    <div class="form-row">
      <label class="checkbox-row">
        <input v-model="notificationsEnabled" type="checkbox" @change="save('notificationsEnabled', notificationsEnabled)" />
        <span>Enable desktop notifications</span>
      </label>
      <p class="form-hint">Shows OS notifications for mentions and direct messages.</p>
    </div>

    <div class="form-row">
      <label class="checkbox-row">
        <input v-model="soundEnabled" type="checkbox" @change="save('soundEnabled', soundEnabled)" />
        <span>Play notification sounds</span>
      </label>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { useSettingsStore } from '@/stores/settingsStore'

const settingsStore        = useSettingsStore()
const notificationsEnabled = ref(settingsStore.settings.notificationsEnabled)
const soundEnabled         = ref(settingsStore.settings.soundEnabled)

function save(key: 'notificationsEnabled' | 'soundEnabled', value: boolean) {
  settingsStore.updateSetting(key, value)
}
</script>

<style scoped>
.settings-section h3 { margin-bottom: var(--spacing-lg); }
.form-row { margin-bottom: var(--spacing-lg); }
.form-hint { font-size: 11px; color: var(--text-tertiary); margin-top: var(--spacing-xs); }
.checkbox-row { display: flex; align-items: center; gap: var(--spacing-sm); font-size: 14px; color: var(--text-primary); cursor: pointer; }
</style>
