<template>
  <Teleport to="body">
    <Transition name="modal-fade">
    <div v-if="uiStore.showSettings" class="settings-overlay" @click.self="close" @keydown.esc="close">
      <div class="settings-modal modal-card" ref="modalEl" role="dialog" aria-modal="true" aria-labelledby="settings-dialog-title">

        <div class="settings-header">
          <h2 id="settings-dialog-title">Settings</h2>
          <button class="close-btn" @click="close" title="Close (Esc)"><AppIcon :path="mdiClose" :size="16" /></button>
        </div>

        <div class="settings-tabs">
          <button
            v-for="tab in tabs"
            :key="tab.key"
            class="tab-btn"
            :class="{ active: activeTab === tab.key }"
            @click="activeTab = tab.key"
          >{{ tab.label }}</button>
        </div>

        <div class="settings-body">
          <SettingsProfileTab       v-if="activeTab === 'profile'" />
          <SettingsVoiceTab         v-else-if="activeTab === 'voice'" />
          <SettingsPrivacyTab       v-else-if="activeTab === 'privacy'" />
          <SettingsNotificationsTab v-else-if="activeTab === 'notifications'" />
          <SettingsAppearanceTab    v-else-if="activeTab === 'appearance'" />
          <SettingsShortcutsTab     v-else-if="activeTab === 'shortcuts'" />
          <SettingsHelpTab          v-else-if="activeTab === 'help'" />
        </div>

        <div class="settings-footer">
          <button class="footer-btn danger" @click="resetDefaults">Reset to defaults</button>
          <button class="footer-btn primary" @click="close">Done</button>
        </div>

      </div>
    </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { mdiClose } from '@mdi/js'
import { useUIStore } from '@/stores/uiStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { useFocusTrap } from '@/utils/useFocusTrap'
import SettingsProfileTab from './settings/SettingsProfileTab.vue'
import SettingsVoiceTab from './settings/SettingsVoiceTab.vue'
import SettingsPrivacyTab from './settings/SettingsPrivacyTab.vue'
import SettingsNotificationsTab from './settings/SettingsNotificationsTab.vue'
import SettingsAppearanceTab from './settings/SettingsAppearanceTab.vue'
import SettingsShortcutsTab from './settings/SettingsShortcutsTab.vue'
import SettingsHelpTab from './settings/SettingsHelpTab.vue'

const uiStore = useUIStore()
const settingsStore = useSettingsStore()

const modalEl = ref<HTMLElement | null>(null)
useFocusTrap(modalEl, computed(() => uiStore.showSettings))

const activeTab = ref<'profile' | 'voice' | 'privacy' | 'notifications' | 'appearance' | 'shortcuts' | 'help'>('profile')

const tabs = [
  { key: 'profile',       label: 'Profile' },
  { key: 'voice',         label: 'Voice & Video' },
  { key: 'privacy',       label: 'Privacy' },
  { key: 'notifications', label: 'Notifications' },
  { key: 'appearance',    label: 'Appearance' },
  { key: 'shortcuts',     label: 'Shortcuts' },
  { key: 'help',          label: 'Help' },
] as const

function resetDefaults() {
  settingsStore.resetToDefaults()
  uiStore.setTheme(settingsStore.settings.theme)
}

function close() { uiStore.showSettings = false }

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape' && uiStore.showSettings) close()
}

onMounted(() => window.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))
</script>

<style scoped>
.settings-overlay {
  position: fixed; inset: 0; z-index: 1000;
  background: rgba(0, 0, 0, 0.55);
  display: flex; align-items: center; justify-content: center;
}

.settings-modal {
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-lg);
  width: 560px;
  max-width: calc(100vw - 32px);
  height: 480px;
  max-height: calc(100vh - 64px);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.settings-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: var(--spacing-lg) var(--spacing-xl); flex-shrink: 0;
}
.settings-header h2 { font-size: 1em; font-weight: 600; color: var(--text-primary); }
.close-btn { color: var(--text-secondary); font-size: 14px; padding: 4px 6px; }

.settings-tabs {
  display: flex; gap: 2px;
  padding: var(--spacing-sm) var(--spacing-xl) 0;
  flex-shrink: 0; overflow-x: auto;
}
.tab-btn {
  background: none; border: none;
  padding: 6px var(--spacing-md);
  font-size: 12px; color: var(--text-secondary); cursor: pointer;
  border-radius: var(--radius-sm) var(--radius-sm) 0 0;
  border-bottom: 2px solid transparent; white-space: nowrap;
  transition: color var(--transition-fast), border-color var(--transition-fast);
}
.tab-btn:hover { color: var(--text-primary); }
.tab-btn.active { color: var(--accent-color); border-bottom-color: var(--accent-color); }

.settings-body { flex: 1; overflow-y: auto; padding: var(--spacing-xl); }

.settings-footer {
  display: flex; justify-content: space-between; align-items: center;
  padding: var(--spacing-md) var(--spacing-xl); flex-shrink: 0;
}
.footer-btn {
  border: 1px solid var(--border-color); border-radius: var(--radius-sm);
  padding: 6px 16px; font-size: 12px; cursor: pointer; transition: all var(--transition-fast);
}
.footer-btn.danger { background: transparent; color: var(--error-color); border-color: var(--error-color); }
.footer-btn.danger:hover { background: var(--error-color); color: #fff; }
.footer-btn.primary { background: var(--accent-color); border-color: var(--accent-color); color: #fff; }
.footer-btn.primary:hover { background: var(--accent-hover); border-color: var(--accent-hover); }
</style>
