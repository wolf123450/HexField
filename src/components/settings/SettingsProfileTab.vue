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

const identityStore = useIdentityStore()
const displayName   = ref(identityStore.displayName)

watch(() => identityStore.displayName, (v) => { displayName.value = v })

function saveName() {
  identityStore.updateDisplayName(displayName.value.trim() || 'Player')
}
</script>

<style scoped>
.settings-section h3 { margin-bottom: var(--spacing-lg); }
.form-row { margin-bottom: var(--spacing-lg); }
.form-label { display: block; font-size: 12px; font-weight: 600; color: var(--text-secondary); margin-bottom: var(--spacing-xs); text-transform: uppercase; letter-spacing: 0.04em; }
.form-input { width: 100%; padding: 8px var(--spacing-sm); background: var(--bg-primary); border: 1px solid var(--border-color); border-radius: var(--radius-sm); color: var(--text-primary); font-size: 14px; }
.form-input:focus { outline: none; border-color: var(--accent-color); }
.form-value-readonly { font-size: 12px; color: var(--text-tertiary); background: var(--bg-primary); border: 1px solid var(--border-color); border-radius: var(--radius-sm); padding: 8px var(--spacing-sm); word-break: break-all; }
.form-value-readonly.mono { font-family: monospace; }
.form-hint { font-size: 11px; color: var(--text-tertiary); margin-top: var(--spacing-xs); }
</style>
