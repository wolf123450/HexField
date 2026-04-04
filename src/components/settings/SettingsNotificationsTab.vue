<template>
  <div class="settings-section">
    <h3>Notifications</h3>

    <!-- ── Section 1: Global Toggles ── -->
    <div class="form-row">
      <label class="checkbox-row">
        <input v-model="notificationsEnabled" type="checkbox" @change="settingsStore.updateSetting('notificationsEnabled', notificationsEnabled)" />
        <span>Enable desktop notifications</span>
      </label>
      <p class="form-hint">Shows OS notifications for mentions and direct messages.</p>
    </div>
    <div class="form-row">
      <label class="checkbox-row">
        <input v-model="soundEnabled" type="checkbox" @change="settingsStore.updateSetting('soundEnabled', soundEnabled)" />
        <span>Play notification sounds</span>
      </label>
    </div>

    <hr class="section-divider" />

    <!-- ── Section 2: Sound Customization ── -->
    <h4>Notification Sounds</h4>
    <div v-for="event in SOUND_EVENTS" :key="event" class="sound-row">
      <span class="sound-label">{{ SOUND_LABELS[event] }}</span>
      <div class="sound-controls">
        <button class="btn-secondary-sm" @click="previewSound(event)">
          <AppIcon :path="mdiPlay" :size="14" /> Preview
        </button>
        <button class="btn-secondary-sm" @click="triggerUpload(event)">
          <AppIcon :path="mdiUpload" :size="14" /> Upload
        </button>
        <input
          type="file"
          accept=".mp3,.ogg,.wav,.flac"
          style="display:none"
          :ref="el => { if (el) fileInputRefs[event] = el as HTMLInputElement }"
          @change="onFileChange(event, $event)"
        />
        <span v-if="customSounds[event]" class="custom-badge">
          Custom
          <button class="icon-btn" @click="resetSound(event)" title="Reset to default">
            <AppIcon :path="mdiClose" :size="12" />
          </button>
        </span>
      </div>
      <p v-if="fileErrors[event]" class="form-hint error-hint">{{ fileErrors[event] }}</p>
    </div>

    <hr class="section-divider" />

    <!-- ── Section 3: Per-Server Notification Prefs ── -->
    <h4>Server Overrides</h4>
    <p v-if="serversStore.joinedServerIds.length === 0" class="form-hint">No servers joined.</p>
    <div v-for="sid in serversStore.joinedServerIds" :key="sid" class="server-pref-row">
      <span class="server-name">{{ serversStore.servers[sid]?.name ?? sid }}</span>
      <select class="pref-select" :value="serverPrefs[sid]?.level ?? 'mentions'" @change="onLevelChange(sid, ($event.target as HTMLSelectElement).value as NotificationLevel)">
        <option value="all">All Messages</option>
        <option value="mentions">Only Mentions</option>
        <option value="muted">Muted</option>
      </select>
      <select class="pref-select mute-select" @change="onMuteSelect(sid, ($event.target as HTMLSelectElement).value)">
        <option value="">Mute for…</option>
        <option value="3600000">1 hour</option>
        <option value="28800000">8 hours</option>
        <option value="86400000">24 hours</option>
        <option value="max">Until I unmute</option>
      </select>
      <span v-if="activeMuteLabel(sid)" class="mute-badge">
        <AppIcon :path="mdiBellOff" :size="12" />
        {{ activeMuteLabel(sid) }}
        <button class="icon-btn" @click="clearMute(sid)" title="Unmute">
          <AppIcon :path="mdiClose" :size="12" />
        </button>
      </span>
    </div>

    <hr class="section-divider" />

    <!-- ── Section 4: Keyword Filters ── -->
    <h4>Keyword Filters</h4>
    <div class="add-keyword-row">
      <input v-model="newKeyword" class="keyword-input" type="text" placeholder="Keyword…" @keydown.enter="addFilter" />
      <select v-model="newKeywordServerId" class="pref-select">
        <option value="">All Servers</option>
        <option v-for="sid in serversStore.joinedServerIds" :key="sid" :value="sid">
          {{ serversStore.servers[sid]?.name ?? sid }}
        </option>
      </select>
      <button class="btn-primary-sm" :disabled="!newKeyword.trim()" @click="addFilter">Add</button>
    </div>
    <p v-if="settingsStore.settings.keywordFilters.length === 0" class="form-hint">
      No keyword filters. Keywords will trigger notifications even in "Only Mentions" channels (but not in muted channels).
    </p>
    <div v-for="filter in settingsStore.settings.keywordFilters" :key="filter.id" class="keyword-row">
      <span class="keyword-text">{{ filter.keyword }}</span>
      <span class="scope-badge">{{ filter.serverId ? (serversStore.servers[filter.serverId]?.name ?? filter.serverId) : 'All servers' }}</span>
      <button class="icon-btn" @click="removeFilter(filter.id)" title="Remove filter">
        <AppIcon :path="mdiTrashCan" :size="14" />
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import { mdiPlay, mdiUpload, mdiClose, mdiTrashCan, mdiBellOff } from '@mdi/js'
import { useSettingsStore } from '@/stores/settingsStore'
import { useServersStore } from '@/stores/serversStore'
import { soundService } from '@/services/soundService'
import { v7 as uuidv7 } from 'uuid'
import type { SoundEvent, KeywordFilter, NotificationLevel } from '@/types/core'

const settingsStore = useSettingsStore()
const serversStore  = useServersStore()

// ── Section 1 ──────────────────────────────────────────────────────────────
const notificationsEnabled = ref(settingsStore.settings.notificationsEnabled)
const soundEnabled         = ref(settingsStore.settings.soundEnabled)

// ── Section 2 ──────────────────────────────────────────────────────────────
const SOUND_EVENTS: SoundEvent[] = ['message', 'mention', 'join_self', 'join_other', 'leave']

const SOUND_LABELS: Record<SoundEvent, string> = {
  message:    'New message',
  mention:    'Mention (@you)',
  join_self:  'You joined a voice channel',
  join_other: 'Someone joined your channel',
  leave:      'Someone left your channel',
}

const fileInputRefs = ref<Record<SoundEvent, HTMLInputElement | null>>({} as Record<SoundEvent, HTMLInputElement | null>)
const fileErrors    = ref<Partial<Record<SoundEvent, string>>>({})

const customSounds = computed(() => settingsStore.settings.customSounds)

function previewSound(event: SoundEvent): void {
  soundService.play(event)
}

function triggerUpload(event: SoundEvent): void {
  fileInputRefs.value[event]?.click()
}

function onFileChange(event: SoundEvent, e: Event): void {
  const file = (e.target as HTMLInputElement).files?.[0]
  if (!file) return
  if (file.size > 2 * 1024 * 1024) {
    fileErrors.value[event] = 'File exceeds 2 MB limit.'
    return
  }
  fileErrors.value[event] = undefined
  const reader = new FileReader()
  reader.onload = () => {
    const dataUrl = reader.result as string
    soundService.setCustomSound(event, dataUrl)
    settingsStore.updateSetting('customSounds', { ...settingsStore.settings.customSounds, [event]: dataUrl })
  }
  reader.readAsDataURL(file)
}

function resetSound(event: SoundEvent): void {
  soundService.clearCustomSound(event)
  const updated = { ...settingsStore.settings.customSounds }
  delete updated[event]
  settingsStore.updateSetting('customSounds', updated)
}

// ── Section 3 ──────────────────────────────────────────────────────────────
const serverPrefs = computed(() => settingsStore.settings.serverNotificationPrefs)

function onLevelChange(sid: string, level: NotificationLevel): void {
  const prefs  = settingsStore.settings.serverNotificationPrefs
  const existing = prefs[sid] ?? {}
  settingsStore.updateSetting('serverNotificationPrefs', { ...prefs, [sid]: { ...existing, level } })
}

function onMuteSelect(sid: string, value: string): void {
  if (!value) return
  const prefs    = settingsStore.settings.serverNotificationPrefs
  const existing = prefs[sid] ?? {}
  const muteUntil = value === 'max' ? Number.MAX_SAFE_INTEGER : Date.now() + Number(value)
  settingsStore.updateSetting('serverNotificationPrefs', { ...prefs, [sid]: { ...existing, muteUntil } })
}

function activeMuteLabel(sid: string): string | null {
  const pref = serverPrefs.value[sid]
  if (!pref?.muteUntil || pref.muteUntil <= Date.now()) return null
  if (pref.muteUntil === Number.MAX_SAFE_INTEGER) return 'Muted indefinitely'
  return 'Muted until ' + new Date(pref.muteUntil).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function clearMute(sid: string): void {
  const prefs    = settingsStore.settings.serverNotificationPrefs
  const existing = prefs[sid] ?? {}
  const updated  = { ...existing }
  delete updated.muteUntil
  settingsStore.updateSetting('serverNotificationPrefs', { ...prefs, [sid]: updated })
}

// ── Section 4 ──────────────────────────────────────────────────────────────
const newKeyword        = ref('')
const newKeywordServerId = ref('')

function addFilter(): void {
  const kw = newKeyword.value.trim()
  if (!kw) return
  const filter: KeywordFilter = {
    id:       uuidv7(),
    keyword:  kw,
    serverId: newKeywordServerId.value || undefined,
  }
  settingsStore.updateSetting('keywordFilters', [...settingsStore.settings.keywordFilters, filter])
  newKeyword.value = ''
}

function removeFilter(id: string): void {
  settingsStore.updateSetting('keywordFilters', settingsStore.settings.keywordFilters.filter(f => f.id !== id))
}
</script>

<style scoped>
.settings-section h3  { margin-bottom: var(--spacing-lg); }
.settings-section h4  { margin-bottom: var(--spacing-md); font-size: 13px; font-weight: 600; color: var(--text-secondary); text-transform: uppercase; letter-spacing: 0.05em; }
.form-row             { margin-bottom: var(--spacing-lg); }
.form-hint            { font-size: 11px; color: var(--text-tertiary); margin-top: var(--spacing-xs); }
.error-hint           { color: var(--error-color); }
.checkbox-row         { display: flex; align-items: center; gap: var(--spacing-sm); font-size: 14px; color: var(--text-primary); cursor: pointer; }
.section-divider      { border: none; border-top: 1px solid var(--border-color); margin: var(--spacing-lg) 0; }

/* Sound rows */
.sound-row            { display: flex; flex-direction: column; gap: var(--spacing-xs); margin-bottom: var(--spacing-md); }
.sound-label          { font-size: 13px; color: var(--text-primary); }
.sound-controls       { display: flex; align-items: center; gap: var(--spacing-sm); flex-wrap: wrap; }
.custom-badge         { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; color: var(--accent-color); background: color-mix(in srgb, var(--accent-color) 15%, transparent); border-radius: 4px; padding: 2px 6px; }

/* Server pref rows */
.server-pref-row      { display: flex; align-items: center; gap: var(--spacing-sm); flex-wrap: wrap; margin-bottom: var(--spacing-md); }
.server-name          { font-size: 13px; color: var(--text-primary); min-width: 120px; flex: 1; }
.pref-select          { background: var(--bg-tertiary); color: var(--text-primary); border: 1px solid var(--border-color); border-radius: 4px; padding: 4px 6px; font-size: 12px; cursor: pointer; }
.mute-select          { max-width: 120px; }
.mute-badge           { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; color: var(--text-secondary); background: var(--bg-tertiary); border-radius: 4px; padding: 2px 6px; border: 1px solid var(--border-color); }

/* Keyword rows */
.add-keyword-row      { display: flex; align-items: center; gap: var(--spacing-sm); margin-bottom: var(--spacing-md); flex-wrap: wrap; }
.keyword-input        { flex: 1; min-width: 140px; background: var(--bg-tertiary); color: var(--text-primary); border: 1px solid var(--border-color); border-radius: 4px; padding: 4px 8px; font-size: 13px; }
.keyword-input:focus  { outline: none; border-color: var(--accent-color); }
.keyword-row          { display: flex; align-items: center; gap: var(--spacing-sm); padding: var(--spacing-xs) 0; border-bottom: 1px solid var(--border-color); }
.keyword-text         { flex: 1; font-size: 13px; color: var(--text-primary); }
.scope-badge          { font-size: 11px; color: var(--text-tertiary); background: var(--bg-tertiary); border-radius: 4px; padding: 2px 6px; }

/* Icon button (no global button padding override) */
.icon-btn             { background: none; border: none; cursor: pointer; padding: 0; transform: none; display: inline-flex; align-items: center; color: var(--text-secondary); }
.icon-btn:hover       { color: var(--text-primary); }
</style>
