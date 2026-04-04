<template>
  <Teleport to="body">
    <div v-if="uiStore.showServerSettingsModal" class="modal-backdrop" @click.self="close">
      <div class="modal-box">
        <div class="modal-header">
          <h2>Server Settings</h2>
          <button class="close-btn" @click="close">
            <AppIcon :path="mdiClose" :size="16" />
          </button>
        </div>

        <!-- Server identity -->
        <section class="settings-section">
          <h3 class="section-title">OVERVIEW</h3>

          <div class="avatar-row">
            <div class="avatar-wrap" :title="isAdmin ? 'Click to change server icon' : undefined" :class="{ clickable: isAdmin }" @click="isAdmin ? iconInput?.click() : undefined">
              <AvatarImage :src="server?.avatarDataUrl ?? null" :name="server?.name ?? ''" :size="80" />
              <div v-if="isAdmin" class="avatar-overlay">
                <AppIcon :path="mdiCamera" :size="20" />
              </div>
            </div>
            <div class="server-meta">
              <div class="server-name">{{ server?.name }}</div>
              <div class="server-id">ID: {{ server?.id }}</div>
              <div class="server-invite" v-if="server?.inviteCode">
                Invite code: <span class="invite-code">{{ server.inviteCode }}</span>
              </div>
            </div>
          </div>

          <!-- Hidden file input for icon upload -->
          <input
            ref="iconInput"
            type="file"
            accept="image/*,.gif"
            style="display:none"
            @change="onIconSelected"
          />
        </section>

        <!-- Invite section -->
        <section class="settings-section">
          <h3 class="section-title">MEMBERS</h3>
          <button class="settings-btn" @click="openInvite">
            <AppIcon :path="mdiAccountPlus" :size="18" />
            <span>Invite People</span>
          </button>
        </section>

        <!-- Roles & Permissions (placeholder) -->
        <section class="settings-section settings-section--disabled">
          <h3 class="section-title">ROLES &amp; PERMISSIONS <span class="coming-soon">Coming Soon</span></h3>
          <p class="section-hint">
            Role management and per-channel permissions will be available in a future update.
          </p>
        </section>

        <!-- Notification preferences for this server -->
        <section v-if="server" class="settings-section">
          <h3 class="section-title">NOTIFICATIONS</h3>

          <div class="notif-row">
            <label class="notif-label">Notification level</label>
            <select class="notif-select" :value="serverNotifLevel" @change="setServerLevel(($event.target as HTMLSelectElement).value as NotificationLevel)">
              <option value="all">All Messages</option>
              <option value="mentions">Only Mentions</option>
              <option value="muted">Muted</option>
            </select>
          </div>

          <div v-if="serverMuteActive" class="notif-mute-badge">
            <span v-if="serverMuteUntil === Number.MAX_SAFE_INTEGER">Muted indefinitely</span>
            <span v-else>Muted until {{ new Date(serverMuteUntil!).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }}</span>
            <button class="notif-clear-btn" @click="clearServerMute">&#x2715;</button>
          </div>

          <div class="notif-mute-row">
            <label class="notif-label">Temporary mute</label>
            <div class="notif-mute-btns">
              <button class="btn-secondary-sm" @click="setServerMute(3_600_000)">1 hour</button>
              <button class="btn-secondary-sm" @click="setServerMute(8 * 3_600_000)">8 hours</button>
              <button class="btn-secondary-sm" @click="setServerMute(24 * 3_600_000)">24 hours</button>
              <button class="btn-secondary-sm" @click="setServerMute(-1)">Until I unmute</button>
            </div>
          </div>

          <!-- Keyword filters scoped to this server -->
          <div class="notif-keywords">
            <div class="notif-label" style="margin-bottom:6px">Keyword filters for this server</div>
            <div class="notif-keyword-add">
              <input
                v-model="newKeyword"
                class="notif-keyword-input"
                placeholder="Add keyword…"
                maxlength="80"
                @keydown.enter="addKeyword"
              />
              <button class="btn-primary-sm" :disabled="!newKeyword.trim()" @click="addKeyword">Add</button>
            </div>
            <div v-if="serverKeywords.length === 0" class="section-hint">
              No keywords for this server.
            </div>
            <div v-for="kf in serverKeywords" :key="kf.id" class="notif-keyword-row">
              <span class="notif-keyword-text">{{ kf.keyword }}</span>
              <button class="notif-clear-btn" title="Remove" @click="removeKeyword(kf.id)">
                <AppIcon :path="mdiTrashCan" :size="13" />
              </button>
            </div>
          </div>
        </section>

        <!-- Moderation audit log (admin only) -->
        <section v-if="isAdmin" class="settings-section">
          <div class="section-header-row">
            <h3 class="section-title">AUDIT LOG</h3>
            <button class="mod-log-toggle btn-secondary-sm" @click="toggleModLog">
              {{ modLogOpen ? 'Hide' : 'Show' }}
            </button>
          </div>

          <template v-if="modLogOpen">
            <div v-if="modLogLoading" class="mod-log-hint">Loading…</div>
            <div v-else-if="modLogEntries.length === 0" class="mod-log-hint">No moderation actions recorded.</div>
            <div v-else class="mod-log-table-wrap">
              <table class="mod-log-table">
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Action</th>
                    <th>By</th>
                    <th>Target</th>
                    <th>Reason</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="entry in modLogEntries" :key="entry.id">
                    <td class="mod-log-time" :title="entry.created_at">{{ formatLogTime(entry.created_at) }}</td>
                    <td><span class="mod-log-badge" :class="`mod-log-badge--${entry.action}`">{{ entry.action }}</span></td>
                    <td class="mod-log-id" :title="entry.issued_by">{{ memberDisplayName(entry.issued_by) }}</td>
                    <td class="mod-log-id" :title="entry.target_id">{{ memberDisplayName(entry.target_id) }}</td>
                    <td class="mod-log-reason">{{ entry.reason ?? '—' }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </template>
        </section>

        <!-- Bans list (admin only) -->
        <section v-if="isAdmin" class="settings-section">
          <div class="section-header-row">
            <h3 class="section-title">BANS</h3>
            <button class="mod-log-toggle btn-secondary-sm" @click="toggleBans">
              {{ bansOpen ? 'Hide' : 'Show' }}
            </button>
          </div>

          <template v-if="bansOpen">
            <div v-if="bansLoading" class="mod-log-hint">Loading…</div>
            <div v-else-if="banList.length === 0" class="mod-log-hint">No active bans.</div>
            <div v-else class="mod-log-table-wrap">
              <table class="mod-log-table">
                <thead>
                  <tr>
                    <th>User</th>
                    <th>Reason</th>
                    <th>Expires</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="ban in banList" :key="ban.userId">
                    <td class="mod-log-id" :title="ban.userId">{{ memberDisplayName(ban.userId) }}</td>
                    <td class="mod-log-reason">{{ ban.reason ?? '—' }}</td>
                    <td class="mod-log-time">{{ ban.expiresAt ? new Date(ban.expiresAt).toLocaleDateString() : 'Permanent' }}</td>
                    <td>
                      <button class="ban-unban-btn" @click="doUnban(ban.userId)">Unban</button>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </template>
        </section>

        <!-- Danger zone (placeholder) -->
        <section v-if="isAdmin" class="settings-section settings-section--danger">
          <h3 class="section-title">DANGER ZONE</h3>
          <p class="section-hint">
            Server deletion and other destructive actions will be available in a future update.
          </p>
        </section>

        <div class="modal-actions">
          <button class="btn-primary" @click="close">Done</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import { mdiClose, mdiCamera, mdiAccountPlus, mdiTrashCan } from '@mdi/js'
import { v7 as uuidv7 } from 'uuid'
import { useUIStore } from '@/stores/uiStore'
import { useServersStore } from '@/stores/serversStore'
import { useIdentityStore } from '@/stores/identityStore'
import { useNetworkStore } from '@/stores/networkStore'
import { useSettingsStore } from '@/stores/settingsStore'
import type { NotificationLevel } from '@/types/core'

const uiStore       = useUIStore()
const serversStore  = useServersStore()
const identityStore = useIdentityStore()
const networkStore  = useNetworkStore()
const settingsStore = useSettingsStore()

const iconInput = ref<HTMLInputElement | null>(null)

const server = computed(() =>
  uiStore.settingsServerId ? serversStore.servers[uiStore.settingsServerId] : null
)

const isAdmin = computed(() => {
  const sid = uiStore.settingsServerId
  const uid = identityStore.userId
  if (!sid || !uid) return false
  return serversStore.members[sid]?.[uid]?.roles.some(r => r === 'admin' || r === 'owner') ?? false
})

function close() {
  uiStore.showServerSettingsModal = false
}

function openInvite() {
  const sid = uiStore.settingsServerId
  if (!sid) return
  close()
  uiStore.openInviteModal(sid)
}

// ── Per-server notification prefs ────────────────────────────────────────────

const serverNotifPrefs = computed(() => {
  const sid = uiStore.settingsServerId
  if (!sid) return undefined
  return settingsStore.settings.serverNotificationPrefs[sid]
})

const serverNotifLevel = computed<NotificationLevel>(() => serverNotifPrefs.value?.level ?? 'mentions')
const serverMuteUntil  = computed(() => serverNotifPrefs.value?.muteUntil)
const serverMuteActive = computed(() => {
  const mu = serverMuteUntil.value
  return mu !== undefined && mu > Date.now()
})

function setServerLevel(level: NotificationLevel) {
  const sid = uiStore.settingsServerId
  if (!sid) return
  const existing = settingsStore.settings.serverNotificationPrefs
  settingsStore.updateSetting('serverNotificationPrefs', {
    ...existing,
    [sid]: { ...(serverNotifPrefs.value ?? {}), level },
  })
}

function setServerMute(ms: number) {
  const sid = uiStore.settingsServerId
  if (!sid) return
  const existing = settingsStore.settings.serverNotificationPrefs
  settingsStore.updateSetting('serverNotificationPrefs', {
    ...existing,
    [sid]: { ...(serverNotifPrefs.value ?? { level: 'mentions' }), muteUntil: ms === -1 ? Number.MAX_SAFE_INTEGER : Date.now() + ms },
  })
}

function clearServerMute() {
  const sid = uiStore.settingsServerId
  if (!sid) return
  const existing = settingsStore.settings.serverNotificationPrefs
  const updated = { ...(serverNotifPrefs.value ?? { level: 'mentions' as NotificationLevel }), muteUntil: undefined }
  settingsStore.updateSetting('serverNotificationPrefs', { ...existing, [sid]: updated })
}

// ── Keyword filters for this server ──────────────────────────────────────────

const newKeyword = ref('')

const serverKeywords = computed(() => {
  const sid = uiStore.settingsServerId
  if (!sid) return []
  return settingsStore.settings.keywordFilters.filter(kf => kf.serverId === sid)
})

function addKeyword() {
  const sid = uiStore.settingsServerId
  const kw = newKeyword.value.trim()
  if (!sid || !kw) return
  settingsStore.updateSetting('keywordFilters', [
    ...settingsStore.settings.keywordFilters,
    { id: uuidv7(), keyword: kw, serverId: sid },
  ])
  newKeyword.value = ''
}

function removeKeyword(id: string) {
  settingsStore.updateSetting('keywordFilters', settingsStore.settings.keywordFilters.filter(kf => kf.id !== id))
}

// ── Moderation audit log ──────────────────────────────────────────────────────

interface ModLogEntry {
  id: string
  server_id: string
  action: string
  target_id: string
  issued_by: string
  reason: string | null
  detail: string | null
  created_at: string
}

const modLogOpen    = ref(false)
const modLogLoading = ref(false)
const modLogEntries = ref<ModLogEntry[]>([])

async function toggleModLog() {
  modLogOpen.value = !modLogOpen.value
  if (modLogOpen.value && modLogEntries.value.length === 0) {
    await loadModLog()
  }
}

async function loadModLog() {
  const sid = uiStore.settingsServerId
  if (!sid) return
  modLogLoading.value = true
  try {
    modLogEntries.value = await invoke<ModLogEntry[]>('db_load_mod_log', { serverId: sid, limit: 100 })
  } finally {
    modLogLoading.value = false
  }
}

function memberDisplayName(userId: string): string {
  const sid = uiStore.settingsServerId
  if (!sid) return userId.slice(0, 8)
  const member = serversStore.members[sid]?.[userId]
  return member?.displayName ?? userId.slice(0, 8)
}

function formatLogTime(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    + ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

// ── Bans section ──────────────────────────────────────────────────────────────

const bansOpen    = ref(false)
const bansLoading = ref(false)
const banList     = ref<import('@/stores/serversStore').BanRecord[]>([])

async function toggleBans() {
  bansOpen.value = !bansOpen.value
  if (bansOpen.value && banList.value.length === 0) {
    await loadBanList()
  }
}

async function loadBanList() {
  const sid = uiStore.settingsServerId
  if (!sid) return
  bansLoading.value = true
  try {
    banList.value = await serversStore.loadBans(sid)
  } finally {
    bansLoading.value = false
  }
}

async function doUnban(userId: string) {
  const sid = uiStore.settingsServerId
  if (!sid) return
  await serversStore.unbanMember(sid, userId)
  banList.value = banList.value.filter(b => b.userId !== userId)
}


const SERVER_ICON_DIM        = 64
const SERVER_ICON_MAX_GIF    = 512 * 1024
const SERVER_ICON_MAX_STATIC = 4 * 1024 * 1024

async function onIconSelected(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0]
  if (!file) return
  ;(e.target as HTMLInputElement).value = ''
  const sid = uiStore.settingsServerId
  if (!sid) return

  if (file.type === 'image/gif') {
    if (file.size > SERVER_ICON_MAX_GIF) return
    const dataUrl = await readAsDataUrl(file)
    await serversStore.updateServerAvatar(sid, dataUrl)
    networkStore.broadcastServerAvatar(sid, dataUrl).catch(() => {})
    return
  }

  if (file.size > SERVER_ICON_MAX_STATIC) return
  const objectUrl = URL.createObjectURL(file)
  const imgEl = new Image()
  imgEl.onload = async () => {
    URL.revokeObjectURL(objectUrl)
    const canvas = document.createElement('canvas')
    canvas.width  = SERVER_ICON_DIM
    canvas.height = SERVER_ICON_DIM
    const ctx = canvas.getContext('2d')!
    const scale = Math.max(SERVER_ICON_DIM / imgEl.width, SERVER_ICON_DIM / imgEl.height)
    const w = imgEl.width  * scale
    const h = imgEl.height * scale
    ctx.drawImage(imgEl, (SERVER_ICON_DIM - w) / 2, (SERVER_ICON_DIM - h) / 2, w, h)
    const dataUrl = canvas.toDataURL('image/png', 0.9)
    await serversStore.updateServerAvatar(sid, dataUrl)
    networkStore.broadcastServerAvatar(sid, dataUrl).catch(() => {})
  }
  imgEl.onerror = () => URL.revokeObjectURL(objectUrl)
  imgEl.src = objectUrl
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload  = () => resolve(reader.result as string)
    reader.onerror = () => reject(new Error('FileReader error'))
    reader.readAsDataURL(file)
  })
}
</script>

<style scoped>
.modal-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.65);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.modal-box {
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  width: 480px;
  max-width: calc(100vw - 32px);
  max-height: calc(100vh - 64px);
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: var(--spacing-lg);
  padding: var(--spacing-xl);
}

.modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.modal-header h2 {
  margin: 0;
  font-size: 18px;
  font-weight: 700;
  color: var(--text-primary);
}

.close-btn {
  background: none;
  border: none;
  cursor: pointer;
  color: var(--text-secondary);
  padding: 4px;
  border-radius: 4px;
  display: flex;
  align-items: center;
}
.close-btn:hover { color: var(--text-primary); background: var(--bg-tertiary); }

.settings-section {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-sm);
}

.section-title {
  margin: 0;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.06em;
  color: var(--text-tertiary);
}

.coming-soon {
  display: inline-block;
  margin-left: var(--spacing-sm);
  font-size: 10px;
  background: var(--bg-tertiary);
  color: var(--text-tertiary);
  padding: 1px 6px;
  border-radius: 10px;
  font-weight: 600;
  letter-spacing: 0;
  vertical-align: middle;
}

.section-hint {
  margin: 0;
  font-size: 13px;
  color: var(--text-tertiary);
  line-height: 1.5;
}

.settings-section--disabled {
  opacity: 0.6;
}

.settings-section--danger .section-title {
  color: var(--error-color);
}

.avatar-row {
  display: flex;
  align-items: center;
  gap: var(--spacing-lg);
}

.avatar-wrap {
  position: relative;
  flex-shrink: 0;
  border-radius: 50%;
  overflow: hidden;
}

.avatar-wrap.clickable {
  cursor: pointer;
}

.avatar-overlay {
  position: absolute;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
  display: flex;
  align-items: center;
  justify-content: center;
  opacity: 0;
  transition: opacity 0.15s;
  color: white;
}

.avatar-wrap.clickable:hover .avatar-overlay {
  opacity: 1;
}

.server-meta {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.server-name {
  font-size: 18px;
  font-weight: 700;
  color: var(--text-primary);
}

.server-id {
  font-size: 11px;
  color: var(--text-tertiary);
  font-family: monospace;
}

.server-invite {
  font-size: 12px;
  color: var(--text-secondary);
}

.invite-code {
  font-family: monospace;
  font-weight: 600;
  color: var(--text-primary);
}

.settings-btn {
  display: inline-flex;
  align-items: center;
  gap: var(--spacing-sm);
  background: var(--bg-tertiary);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  padding: 8px var(--spacing-md);
  color: var(--text-primary);
  font-size: 14px;
  cursor: pointer;
  align-self: flex-start;
}
.settings-btn:hover { background: var(--bg-primary); }

.modal-actions {
  display: flex;
  justify-content: flex-end;
}

.btn-primary {
  background: var(--accent-color);
  border: none;
  border-radius: 4px;
  padding: 8px 20px;
  color: white;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
}
.btn-primary:hover { filter: brightness(1.1); }

/* ── Notification prefs section ─────────────────────────────────────────── */
.notif-row { display: flex; align-items: center; justify-content: space-between; margin-bottom: var(--spacing-sm); }
.notif-label { font-size: 13px; color: var(--text-secondary); }
.notif-select { background: var(--bg-tertiary); color: var(--text-primary); border: 1px solid var(--border-color); border-radius: 4px; padding: 4px 8px; font-size: 13px; }
.notif-mute-badge { display: inline-flex; align-items: center; gap: var(--spacing-xs); font-size: 12px; color: var(--text-secondary); background: var(--bg-tertiary); border-radius: 4px; padding: 3px 8px; margin-bottom: var(--spacing-sm); }
.notif-clear-btn { background: none; border: none; color: var(--text-secondary); cursor: pointer; padding: 0; display: inline-flex; align-items: center; }
.notif-clear-btn:hover { color: var(--text-primary); }
.notif-mute-row { margin-bottom: var(--spacing-md); }
.notif-mute-btns { display: flex; flex-wrap: wrap; gap: var(--spacing-xs); margin-top: 4px; }
.notif-keywords { margin-top: var(--spacing-sm); }
.notif-keyword-add { display: flex; gap: var(--spacing-sm); margin-bottom: var(--spacing-sm); }
.notif-keyword-input { flex: 1; background: var(--bg-tertiary); color: var(--text-primary); border: 1px solid var(--border-color); border-radius: 4px; padding: 5px 8px; font-size: 13px; }
.notif-keyword-row { display: flex; align-items: center; justify-content: space-between; padding: 4px 0; border-bottom: 1px solid var(--border-color); font-size: 13px; color: var(--text-primary); }
.notif-keyword-text { font-family: monospace; }

/* ── Audit log section ─────────────────────────────────────────────────── */
.section-header-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.mod-log-hint {
  font-size: 13px;
  color: var(--text-tertiary);
  padding: var(--spacing-sm) 0;
}

.mod-log-table-wrap {
  overflow-x: auto;
  border-radius: 6px;
  border: 1px solid var(--border-color);
}

.mod-log-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}

.mod-log-table th {
  text-align: left;
  padding: 6px 10px;
  font-weight: 600;
  color: var(--text-tertiary);
  background: var(--bg-tertiary);
  border-bottom: 1px solid var(--border-color);
  white-space: nowrap;
}

.mod-log-table td {
  padding: 6px 10px;
  color: var(--text-secondary);
  border-bottom: 1px solid var(--border-color);
  vertical-align: top;
}

.mod-log-table tbody tr:last-child td { border-bottom: none; }
.mod-log-table tbody tr:hover td { background: var(--bg-tertiary); }

.mod-log-time { white-space: nowrap; color: var(--text-tertiary); font-size: 11px; }
.mod-log-id { font-family: monospace; font-size: 11px; max-width: 90px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mod-log-reason { max-width: 140px; white-space: pre-wrap; word-break: break-word; }

.mod-log-badge {
  display: inline-block;
  padding: 1px 7px;
  border-radius: 10px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.03em;
  white-space: nowrap;
  background: var(--bg-tertiary);
  color: var(--text-secondary);
}
.mod-log-badge--kick        { background: rgba(250, 166, 26, 0.2);  color: #faa61a; }
.mod-log-badge--ban         { background: rgba(237, 66, 69, 0.2);   color: #ed4245; }
.mod-log-badge--unban       { background: rgba(87, 242, 135, 0.2);  color: #57f287; }
.mod-log-badge--voice_kick  { background: rgba(250, 166, 26, 0.15); color: #faa61a; }
.mod-log-badge--voice_mute  { background: rgba(250, 166, 26, 0.15); color: #faa61a; }
.mod-log-badge--voice_unmute { background: rgba(87, 242, 135, 0.15); color: #57f287; }

/* Unban button */
.ban-unban-btn {
  background: none;
  border: 1px solid var(--border-color);
  color: var(--text-secondary);
  border-radius: 4px;
  padding: 2px 8px;
  font-size: 11px;
  cursor: pointer;
  white-space: nowrap;
}
.ban-unban-btn:hover {
  background: var(--bg-tertiary);
  color: var(--text-primary);
}
</style>
