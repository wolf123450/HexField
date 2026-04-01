<template>
  <div class="tab-content">
    <div class="shortcuts-table">
      <div class="shortcut-row header-row">
        <span>Action</span><span>Shortcut</span>
      </div>
      <div class="shortcut-row" v-for="(shortcut, action) in settings.keyboardShortcuts" :key="action">
        <span class="action-label">{{ shortcutLabel(action) }}</span>
        <kbd>{{ shortcut }}</kbd>
      </div>
    </div>
    <p class="setting-hint">Keyboard shortcut customisation coming soon.</p>
  </div>
</template>

<script setup lang="ts">
import { useSettingsStore } from '@/stores/settingsStore'

const settingsStore = useSettingsStore()
const settings = settingsStore.settings

function shortcutLabel(action: string): string {
  const map: Record<string, string> = {
    'save':     'Save',
    'settings': 'Open settings',
  }
  return map[action] ?? action
}
</script>

<style scoped>
@import './settingsStyles.css';

.shortcuts-table { display: flex; flex-direction: column; gap: 2px; }
.shortcut-row {
  display: grid;
  grid-template-columns: 1fr auto;
  align-items: center;
  gap: var(--spacing-lg);
  padding: 7px 10px;
  border-radius: var(--radius-sm);
  font-size: 13px;
}
.shortcut-row.header-row {
  font-size: 11px; font-weight: 600; color: var(--text-tertiary);
  text-transform: uppercase; letter-spacing: 0.04em;
}
.shortcut-row:not(.header-row) { background: var(--bg-tertiary); }
.action-label { color: var(--text-primary); }
.shortcut-row kbd {
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 4px;
  padding: 2px 6px;
  font-size: 11px;
  color: var(--text-secondary);
  white-space: nowrap;
}
</style>
