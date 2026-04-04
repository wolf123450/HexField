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
import { mdiClose, mdiCamera, mdiAccountPlus } from '@mdi/js'
import { useUIStore } from '@/stores/uiStore'
import { useServersStore } from '@/stores/serversStore'
import { useIdentityStore } from '@/stores/identityStore'
import { useNetworkStore } from '@/stores/networkStore'

const uiStore       = useUIStore()
const serversStore  = useServersStore()
const identityStore = useIdentityStore()
const networkStore  = useNetworkStore()

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

// ── Icon upload ──────────────────────────────────────────────────────────────

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
</style>
