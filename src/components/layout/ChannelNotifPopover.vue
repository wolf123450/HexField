<template>
  <Teleport to="body">
    <div class="notif-popover-backdrop" @click.self="emit('close')" />
    <div class="notif-popover-card" :style="{ left: x + 'px', top: y + 'px' }">
      <div class="notif-popover-header">
        <span>Channel Notifications</span>
        <button class="notif-close-btn" @click="emit('close')">
          <AppIcon :path="mdiClose" :size="14" />
        </button>
      </div>

      <div class="notif-level-row">
        <label>Level</label>
        <select :value="currentLevel" @change="setLevel(($event.target as HTMLSelectElement).value as ChannelNotificationPrefs['level'])">
          <option value="inherit">Inherit from server</option>
          <option value="all">All Messages</option>
          <option value="mentions">Only Mentions</option>
          <option value="muted">Muted</option>
        </select>
      </div>

      <div v-if="isMutedTemporarily" class="notif-mute-badge">
        <span v-if="prefs?.muteUntil === Number.MAX_SAFE_INTEGER">Muted indefinitely</span>
        <span v-else>Muted until {{ new Date(prefs!.muteUntil!).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }}</span>
        <button class="notif-close-btn" @click="clearMute">
          <AppIcon :path="mdiClose" :size="12" />
        </button>
      </div>

      <div class="notif-mute-row">
        <label>Temporary mute</label>
        <div class="notif-mute-btns">
          <button class="btn-secondary-sm" @click="setMuteFor(3_600_000)">1h</button>
          <button class="btn-secondary-sm" @click="setMuteFor(8 * 3_600_000)">8h</button>
          <button class="btn-secondary-sm" @click="setMuteFor(24 * 3_600_000)">24h</button>
          <button class="btn-secondary-sm" @click="setMuteFor(-1)">Forever</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { mdiClose } from '@mdi/js'
import { useSettingsStore } from '@/stores/settingsStore'
import type { ChannelNotificationPrefs } from '@/types/core'

interface Props {
  channelId: string
  serverId:  string
  x:         number
  y:         number
}

const props = defineProps<Props>()
const emit  = defineEmits<{ close: [] }>()

const settingsStore = useSettingsStore()

const prefs = computed(() => settingsStore.settings.channelNotificationPrefs[props.channelId])
const currentLevel = computed(() => prefs.value?.level ?? 'inherit')
const isMutedTemporarily = computed(() => prefs.value?.muteUntil !== undefined && prefs.value.muteUntil > Date.now())

function setLevel(level: ChannelNotificationPrefs['level']) {
  const existing = settingsStore.settings.channelNotificationPrefs
  settingsStore.updateSetting('channelNotificationPrefs', {
    ...existing,
    [props.channelId]: { ...(prefs.value ?? {}), level },
  })
}

function setMuteFor(ms: number) {
  const existing = settingsStore.settings.channelNotificationPrefs
  settingsStore.updateSetting('channelNotificationPrefs', {
    ...existing,
    [props.channelId]: { ...(prefs.value ?? { level: 'inherit' }), muteUntil: ms === -1 ? Number.MAX_SAFE_INTEGER : Date.now() + ms },
  })
}

function clearMute() {
  const existing = settingsStore.settings.channelNotificationPrefs
  const updated = { ...(prefs.value ?? { level: 'inherit' }), muteUntil: undefined }
  settingsStore.updateSetting('channelNotificationPrefs', { ...existing, [props.channelId]: updated })
}
</script>

<style scoped>
.notif-popover-backdrop {
  position: fixed; inset: 0; z-index: 900;
}
.notif-popover-card {
  position: fixed; z-index: 901;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  padding: var(--spacing-md);
  min-width: 220px;
  box-shadow: 0 4px 20px rgba(0,0,0,0.4);
}
.notif-popover-header {
  display: flex; align-items: center; justify-content: space-between;
  margin-bottom: var(--spacing-sm);
  font-size: 12px; font-weight: 600; color: var(--text-secondary); text-transform: uppercase; letter-spacing: 0.04em;
}
.notif-level-row {
  display: flex; align-items: center; justify-content: space-between;
  gap: var(--spacing-sm); margin-bottom: var(--spacing-sm);
  font-size: 13px; color: var(--text-primary);
}
.notif-level-row select {
  background: var(--bg-tertiary); color: var(--text-primary);
  border: 1px solid var(--border-color); border-radius: 4px;
  padding: 2px 6px; font-size: 12px;
}
.notif-mute-badge {
  display: flex; align-items: center; gap: var(--spacing-xs);
  font-size: 11px; color: var(--text-secondary);
  background: var(--bg-tertiary); border-radius: 4px;
  padding: 3px 6px; margin-bottom: var(--spacing-xs);
}
.notif-mute-row { margin-top: var(--spacing-xs); }
.notif-mute-row label { font-size: 11px; color: var(--text-secondary); margin-bottom: 4px; display: block; }
.notif-mute-btns { display: flex; gap: var(--spacing-xs); flex-wrap: wrap; }
.notif-close-btn { background: none; border: none; cursor: pointer; color: var(--text-secondary); padding: 0; display: flex; align-items: center; }
.notif-close-btn:hover { color: var(--text-primary); }
</style>
