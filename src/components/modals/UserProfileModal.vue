<template>
  <Teleport to="body">
    <div v-if="uiStore.showUserProfile" class="profile-backdrop" @click.self="uiStore.closeUserProfile()">
      <div class="profile-modal">
        <!-- Header / avatar banner -->
        <div class="profile-banner">
          <div class="profile-avatar" :class="{ self: isSelf }">{{ initials }}</div>
        </div>

        <!-- Body -->
        <div class="profile-body">
          <!-- Name -->
          <div v-if="isSelf" class="profile-name-row">
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
import { mdiContentCopy, mdiCheck, mdiVolumeHigh, mdiClose } from '@mdi/js'
import { useUIStore }       from '@/stores/uiStore'
import { useIdentityStore } from '@/stores/identityStore'
import { useServersStore }  from '@/stores/serversStore'
import { useVoiceStore }    from '@/stores/voiceStore'
import { audioService }     from '@/services/audioService'

const uiStore       = useUIStore()
const identityStore = useIdentityStore()
const serversStore  = useServersStore()
const voiceStore    = useVoiceStore()

const copied     = ref(false)
const editName   = ref('')
const peerVolume = ref(100)

const userId = computed(() => uiStore.userProfileUserId ?? '')
const isSelf = computed(() => userId.value === identityStore.userId)

const member = computed(() => {
  const sid = uiStore.userProfileServerId
  if (!sid) return null
  return serversStore.members[sid]?.[userId.value] ?? null
})

const displayName = computed(() => {
  if (isSelf.value) return identityStore.displayName
  return member.value?.displayName ?? userId.value.slice(0, 8)
})

const initials = computed(() => {
  const name = displayName.value || '?'
  return name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase()
})

// Sync editName when modal opens
watch(() => uiStore.showUserProfile, open => {
  if (open && isSelf.value) editName.value = identityStore.displayName
  if (open && !isSelf.value) peerVolume.value = 100
})

async function saveName() {
  const name = editName.value.trim()
  if (!name) return
  await identityStore.updateDisplayName(name)
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

.profile-avatar {
  width: 72px;
  height: 72px;
  border-radius: 50%;
  background: var(--bg-secondary);
  border: 4px solid var(--bg-secondary);
  color: var(--accent-color);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 24px;
  font-weight: 700;
  transform: translateY(50%);
  user-select: none;
}

.profile-avatar.self {
  cursor: pointer;
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
</style>
