<template>
  <Teleport to="body">
    <div v-if="uiStore.showUserProfile" class="profile-backdrop" @click.self="uiStore.closeUserProfile()">
      <div class="profile-modal">
        <!-- Header / avatar banner -->
        <div class="profile-banner" :style="bannerStyle">
          <div class="profile-avatar-wrap">
            <AvatarImage
              :src="avatarSrc"
              :name="displayName"
              :size="72"
              :animate="true"
              class="profile-avatar"
            />
            <!-- Upload button — own profile only -->
            <button
              v-if="isEditable"
              class="avatar-upload-btn"
              title="Change avatar"
              @click="triggerAvatarUpload"
            >
              <AppIcon :path="mdiCamera" :size="16" />
            </button>
            <input
              ref="avatarInput"
              type="file"
              accept="image/*,.gif"
              style="display:none"
              @change="onAvatarFileSelected"
            />
          </div>
        </div>

        <!-- Body -->
        <div class="profile-body">
          <!-- Avatar upload error -->
          <div v-if="uploadError" class="upload-error">{{ uploadError }}</div>

          <!-- Name -->
          <div v-if="isEditable" class="profile-name-row">
            <input
              v-model="editName"
              class="name-input"
              maxlength="60"
              placeholder="Display name"
              @keydown.enter="saveName"
              @keydown.esc="uiStore.closeUserProfile()"
            />
            <button class="save-btn" :disabled="!editName.trim() || editName === identityStore.displayName" @click="saveName">Save</button>
          </div>
          <div v-else class="profile-display-name">{{ displayName }}</div>

          <div class="profile-userid">
            <span class="uid-label">User ID</span>
            <span class="uid-value">{{ userId }}</span>
            <button class="copy-btn" title="Copy User ID" @click="copyUserId">
              <AppIcon :path="copied ? mdiCheck : mdiContentCopy" :size="14" />
            </button>
          </div>

          <!-- Roles -->
          <div v-if="member?.roles.length" class="profile-roles">
            <span v-for="role in member.roles" :key="role" class="role-badge">{{ role }}</span>
          </div>

          <!-- Bio -->
          <div v-if="isEditable || member?.bio" class="profile-section">
            <label class="section-label">Bio</label>
            <textarea
              v-if="isEditable"
              v-model="editBio"
              class="bio-textarea"
              maxlength="200"
              rows="3"
              placeholder="Tell others a bit about yourself…"
              @blur="saveBio"
            />
            <p v-else class="bio-text">{{ member?.bio }}</p>
          </div>

          <!-- Per-peer volume (only for remote users while in voice) -->
          <div v-if="!isSelf && voiceStore.session" class="profile-section">
            <label class="section-label">Volume</label>
            <div class="volume-row">
              <AppIcon :path="mdiVolumeHigh" :size="16" />
              <input
                type="range"
                min="0"
                max="200"
                step="5"
                :value="peerVolume"
                class="volume-slider"
                @input="setVolume"
              />
              <span class="volume-val">{{ peerVolume }}%</span>
            </div>
          </div>
        </div>

        <button class="close-btn" @click="uiStore.closeUserProfile()">
          <AppIcon :path="mdiClose" :size="18" />
        </button>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { mdiContentCopy, mdiCheck, mdiVolumeHigh, mdiClose, mdiCamera } from '@mdi/js'
import { useUIStore }       from '@/stores/uiStore'
import { useIdentityStore } from '@/stores/identityStore'
import { useServersStore }  from '@/stores/serversStore'
import { useVoiceStore }    from '@/stores/voiceStore'
import { useNetworkStore }  from '@/stores/networkStore'
import { audioService }     from '@/services/audioService'

const uiStore       = useUIStore()
const identityStore = useIdentityStore()
const serversStore  = useServersStore()
const voiceStore    = useVoiceStore()
const networkStore  = useNetworkStore()

const copied      = ref(false)
const editName    = ref('')
const editBio     = ref('')
const peerVolume  = ref(100)
const avatarInput = ref<HTMLInputElement | null>(null)
const uploadError = ref('')

const userId = computed(() => uiStore.userProfileUserId ?? '')
const isSelf = computed(() => userId.value === identityStore.userId)
const isEditable = computed(() => isSelf.value && !uiStore.userProfileReadOnly)

// Avatar: own profile uses identityStore, peer uses member record
const avatarSrc = computed(() =>
  isSelf.value
    ? identityStore.avatarDataUrl
    : (member.value?.avatarDataUrl ?? null)
)

const member = computed(() => {
  const sid = uiStore.userProfileServerId
  if (!sid) return null
  return serversStore.members[sid]?.[userId.value] ?? null
})

const displayName = computed(() => {
  if (isSelf.value) return identityStore.displayName
  return member.value?.displayName ?? userId.value.slice(0, 8)
})

const BANNER_PRESETS = ['#5865F2', '#3BA55D', '#ED4245', '#FAA61A', '#EB459E', '#9B59B6']

function deriveUserGradient(uid: string): string {
  const byte = uid.charCodeAt(0) % BANNER_PRESETS.length
  const a = BANNER_PRESETS[byte]
  const b = BANNER_PRESETS[(byte + 2) % BANNER_PRESETS.length]
  return `linear-gradient(135deg, ${a}, ${b})`
}

const bannerStyle = computed(() => {
  const src = isSelf.value ? identityStore.bannerDataUrl : (member.value?.bannerDataUrl ?? null)
  if (src) return { backgroundImage: `url(${src})`, backgroundSize: 'cover', backgroundPosition: 'center' }
  const color = isSelf.value ? identityStore.bannerColor : (member.value?.bannerColor ?? null)
  if (color) return { background: color }
  return { background: deriveUserGradient(userId.value || 'a') }
})

// Sync editName + editBio when modal opens
watch(() => uiStore.showUserProfile, open => {
  if (open && isEditable.value) {
    editName.value = identityStore.displayName
    editBio.value  = identityStore.bio ?? ''
  }
  if (open && !isSelf.value) peerVolume.value = 100
})

async function saveName() {
  const name = editName.value.trim()
  if (!name) return
  await identityStore.updateDisplayName(name)
  const uid = identityStore.userId
  if (uid) {
    for (const sid of serversStore.joinedServerIds) {
      serversStore.updateMemberDisplayName(sid, uid, name)
    }
  }
  networkStore.broadcastProfile({ displayName: name }).catch(() => {})
  uiStore.closeUserProfile()
}

async function copyUserId() {
  await navigator.clipboard.writeText(userId.value)
  copied.value = true
  setTimeout(() => { copied.value = false }, 1500)
}

function setVolume(e: Event) {
  const vol = parseInt((e.target as HTMLInputElement).value, 10)
  peerVolume.value = vol
  audioService.setPeerVolume(userId.value, vol / 100)
}

// ── Avatar upload ─────────────────────────────────────────────────────────────

const MAX_GIF_BYTES    = 512 * 1024         // 512 KB — per spec §16a
const MAX_STATIC_BYTES = 25 * 1024 * 1024  // 25 MB
const AVATAR_DIM       = 128

function triggerAvatarUpload() {
  uploadError.value = ''
  avatarInput.value?.click()
}

async function onAvatarFileSelected(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0]
  if (!file) return
  ;(e.target as HTMLInputElement).value = ''

  if (file.type === 'image/gif') {
    if (file.size > MAX_GIF_BYTES) {
      uploadError.value = `GIF too large (max ${MAX_GIF_BYTES / 1024} KB)`
      return
    }
    const dataUrl = await readFileAsDataUrl(file)
    await saveAvatar(dataUrl)
    return
  }

  // For static images: downsample to 128×128 via canvas
  if (file.size > MAX_STATIC_BYTES) {
    uploadError.value = `Image too large (max ${MAX_STATIC_BYTES / 1024 / 1024} MB)`
    return
  }
  const imgEl = new Image()
  const objectUrl = URL.createObjectURL(file)
  imgEl.onload = async () => {
    URL.revokeObjectURL(objectUrl)
    const canvas = document.createElement('canvas')
    canvas.width  = AVATAR_DIM
    canvas.height = AVATAR_DIM
    const ctx = canvas.getContext('2d')!
    // Cover crop: center the image
    const scale = Math.max(AVATAR_DIM / imgEl.width, AVATAR_DIM / imgEl.height)
    const w = imgEl.width  * scale
    const h = imgEl.height * scale
    ctx.drawImage(imgEl, (AVATAR_DIM - w) / 2, (AVATAR_DIM - h) / 2, w, h)
    const dataUrl = canvas.toDataURL('image/png', 0.92)
    await saveAvatar(dataUrl)
  }
  imgEl.onerror = () => {
    URL.revokeObjectURL(objectUrl)
    uploadError.value = 'Failed to load image'
  }
  imgEl.src = objectUrl
}

async function saveAvatar(dataUrl: string) {
  await identityStore.updateAvatar(dataUrl)
  const { invoke } = await import('@tauri-apps/api/core')
  await invoke('db_save_key', { keyId: 'local_avatar_data', keyType: 'avatar', keyData: dataUrl })
    .catch(() => {})
  const uid = identityStore.userId
  if (uid) {
    for (const sid of serversStore.joinedServerIds) {
      const m = serversStore.members[sid]?.[uid]
      if (m) m.avatarDataUrl = dataUrl
    }
  }
  networkStore.broadcastProfile({ avatarDataUrl: dataUrl }).catch(() => {})
}

async function saveBio() {
  const text = editBio.value.slice(0, 200)
  await identityStore.updateBio(text)
  const uid = identityStore.userId
  if (uid) {
    for (const sid of serversStore.joinedServerIds) {
      serversStore.updateMemberProfile(sid, uid, { bio: text })
    }
  }
  networkStore.broadcastProfile({ bio: text }).catch(() => {})
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload  = () => resolve(reader.result as string)
    reader.onerror = () => reject(new Error('FileReader error'))
    reader.readAsDataURL(file)
  })
}
</script>

<style scoped>
.profile-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1100;
}

.profile-modal {
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-lg);
  width: 340px;
  overflow: hidden;
  position: relative;
  box-shadow: var(--shadow-lg);
}

.close-btn {
  position: absolute;
  top: 10px;
  right: 10px;
  background: rgba(255,255,255,0.1);
  border: none;
  border-radius: 50%;
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  color: white;
  padding: 0;
  transform: none;
}
.close-btn:hover { background: rgba(255,255,255,0.2); }

.profile-banner {
  height: 80px;
  background: linear-gradient(135deg, var(--accent-color), var(--accent-hover));
  display: flex;
  align-items: flex-end;
  padding: 0 var(--spacing-lg);
  padding-bottom: 0;
}

.profile-avatar-wrap {
  position: relative;
  flex-shrink: 0;
}

.profile-avatar {
  border: 4px solid var(--bg-secondary) !important;
  transform: translateY(50%);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
}

.avatar-upload-btn {
  position: absolute;
  bottom: calc(-50% + 4px);
  right: -4px;
  width: 26px;
  height: 26px;
  border-radius: 50%;
  background: var(--accent-color);
  border: 2px solid var(--bg-secondary);
  color: white;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  padding: 0;
  transform: none;
}
.avatar-upload-btn:hover { background: var(--accent-hover); }

.upload-error {
  font-size: 12px;
  color: var(--error-color);
  background: color-mix(in srgb, var(--error-color) 12%, transparent);
  border-radius: var(--radius-sm);
  padding: 6px var(--spacing-sm);
}

.profile-body {
  padding: calc(36px + var(--spacing-md)) var(--spacing-lg) var(--spacing-lg);
  display: flex;
  flex-direction: column;
  gap: var(--spacing-md);
}

.profile-display-name {
  font-size: 20px;
  font-weight: 700;
  color: var(--text-primary);
}

.profile-name-row {
  display: flex;
  gap: var(--spacing-sm);
  align-items: center;
}

.name-input {
  flex: 1;
  background: var(--bg-primary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  color: var(--text-primary);
  font-size: 16px;
  font-weight: 600;
  padding: 6px var(--spacing-sm);
}
.name-input:focus { outline: none; border-color: var(--accent-color); }

.save-btn {
  padding: 6px var(--spacing-md);
  background: var(--accent-color);
  color: white;
  border: none;
  border-radius: var(--radius-sm);
  cursor: pointer;
  font-size: 13px;
  font-weight: 600;
  transform: none;
}
.save-btn:disabled { opacity: 0.4; cursor: default; }
.save-btn:not(:disabled):hover { background: var(--accent-hover); }

.profile-userid {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  background: var(--bg-tertiary);
  border-radius: var(--radius-sm);
  padding: 6px var(--spacing-sm);
}

.uid-label {
  font-size: 10px;
  font-weight: 700;
  color: var(--text-tertiary);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  flex-shrink: 0;
}

.uid-value {
  flex: 1;
  font-size: 11px;
  font-family: monospace;
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.copy-btn {
  background: none;
  border: none;
  cursor: pointer;
  color: var(--text-tertiary);
  display: flex;
  align-items: center;
  padding: 2px;
  transform: none;
}
.copy-btn:hover { color: var(--text-primary); }

.profile-roles {
  display: flex;
  flex-wrap: wrap;
  gap: var(--spacing-xs);
}

.role-badge {
  font-size: 11px;
  font-weight: 600;
  padding: 2px 8px;
  border-radius: 10px;
  background: rgba(88, 101, 242, 0.2);
  color: var(--accent-color);
}

.profile-section { display: flex; flex-direction: column; gap: var(--spacing-xs); }
.section-label {
  font-size: 11px;
  font-weight: 700;
  color: var(--text-tertiary);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.volume-row {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  color: var(--text-secondary);
}

.volume-slider {
  flex: 1;
  accent-color: var(--accent-color);
}

.volume-val {
  font-size: 12px;
  color: var(--text-secondary);
  min-width: 36px;
  text-align: right;
}

.bio-textarea {
  width: 100%;
  background: var(--bg-primary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  color: var(--text-primary);
  font-size: 13px;
  padding: 6px var(--spacing-sm);
  resize: vertical;
  min-height: 56px;
  box-sizing: border-box;
  font-family: inherit;
}
.bio-textarea:focus { outline: none; border-color: var(--accent-color); }

.bio-text {
  font-size: 13px;
  color: var(--text-secondary);
  margin: 0;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
}
</style>
