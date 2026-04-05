<template>
  <div class="settings-section">
    <h3>Profile</h3>

    <div class="form-row">
      <label class="form-label">Display Name</label>
      <input
        v-model="displayName"
        type="text"
        class="form-input"
        placeholder="Your display name"
        maxlength="32"
        @change="saveName"
      />
    </div>

    <div class="form-row">
      <label class="form-label">Bio <span class="form-label-hint">{{ bio.length }}/200</span></label>
      <textarea
        v-model="bio"
        class="form-input bio-input"
        placeholder="Tell others a bit about yourself…"
        maxlength="200"
        rows="3"
        @blur="saveBio"
      />
    </div>

    <div class="form-row">
      <label class="form-label">Avatar &amp; Banner</label>
      <button class="form-action-btn" @click="openProfile">
        Edit avatar and banner in your profile
      </button>
    </div>

    <div class="form-row">
      <label class="form-label">User ID</label>
      <div class="form-value-readonly">{{ identityStore.userId ?? '—' }}</div>
      <p class="form-hint">Your unique identifier. This never changes.</p>
    </div>

    <div class="form-row">
      <label class="form-label">Public Sign Key</label>
      <div class="form-value-readonly mono">{{ identityStore.publicSignKey ?? '—' }}</div>
      <p class="form-hint">Ed25519 public key — shared with peers to verify your messages.</p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'
import { useIdentityStore } from '@/stores/identityStore'
import { useUIStore } from '@/stores/uiStore'
import { useServersStore } from '@/stores/serversStore'

const identityStore = useIdentityStore()
const uiStore       = useUIStore()
const serversStore  = useServersStore()

const displayName = ref(identityStore.displayName)
const bio         = ref(identityStore.bio ?? '')

watch(() => identityStore.displayName, (v) => { displayName.value = v })
watch(() => identityStore.bio,         (v) => { bio.value = v ?? '' })

function saveName() {
  identityStore.updateDisplayName(displayName.value.trim() || 'Player')
}

async function saveBio() {
  const text = bio.value.slice(0, 200)
  await identityStore.updateBio(text)
  const uid = identityStore.userId
  if (uid) {
    for (const sid of serversStore.joinedServerIds) {
      serversStore.updateMemberProfile(sid, uid, { bio: text })
    }
  }
  // Broadcast to connected peers (lazy import to avoid circular dep)
  const { useNetworkStore } = await import('@/stores/networkStore')
  useNetworkStore().broadcastProfile({ bio: text }).catch(() => {})
}

function openProfile() {
  const uid = identityStore.userId
  if (!uid) return
  uiStore.showSettings = false
  uiStore.openUserProfile(uid, serversStore.activeServerId ?? null)
}
</script>

<style scoped>
@import './settingsStyles.css';
.settings-section h3 { margin-bottom: var(--spacing-lg); }
.form-row { margin-bottom: var(--spacing-lg); }
.form-label {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  font-size: 12px;
  font-weight: 600;
  color: var(--text-secondary);
  margin-bottom: var(--spacing-xs);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.form-label-hint { font-weight: 400; text-transform: none; letter-spacing: 0; color: var(--text-tertiary); }
.form-input {
  width: 100%;
  padding: 8px var(--spacing-sm);
  background: var(--bg-primary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  color: var(--text-primary);
  font-size: 14px;
}
.form-input:focus { outline: none; border-color: var(--accent-color); }
.bio-input { resize: vertical; font-family: inherit; }
.form-value-readonly {
  font-size: 12px;
  color: var(--text-tertiary);
  background: var(--bg-primary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  padding: 8px var(--spacing-sm);
  word-break: break-all;
}
.form-value-readonly.mono { font-family: monospace; }
.form-hint { font-size: 11px; color: var(--text-tertiary); margin-top: var(--spacing-xs); }
.form-action-btn {
  background: var(--bg-tertiary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  color: var(--text-secondary);
  padding: 7px 14px;
  font-size: 13px;
  cursor: pointer;
}
.form-action-btn:hover { background: var(--bg-hover); color: var(--text-primary); }
</style>
