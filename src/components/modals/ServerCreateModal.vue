<template>
  <Teleport to="body">
    <div v-if="uiStore.showServerCreateModal" class="modal-backdrop" @click.self="close">
      <div class="modal-box" @keydown.esc="close">
        <div class="modal-header">
          <h2>Create a Server</h2>
          <button class="close-btn" @click="close">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
            </svg>
          </button>
        </div>

        <p class="modal-hint">Give your server a name. You can always change it later.</p>

        <label class="field-label">SERVER NAME</label>
        <input
          ref="nameInput"
          v-model="name"
          class="text-input"
          placeholder="My Server"
          maxlength="100"
          :disabled="creating"
          @keydown.enter="create"
        />

        <div class="modal-actions">
          <button class="btn-secondary" :disabled="creating" @click="close">Cancel</button>
          <button class="btn-primary" :disabled="!name.trim() || creating" @click="create">
            {{ creating ? 'Creating…' : 'Create Server' }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, watch, nextTick } from 'vue'
import { useUIStore } from '@/stores/uiStore'
import { useServersStore } from '@/stores/serversStore'
import { useChannelsStore } from '@/stores/channelsStore'
import { useIdentityStore } from '@/stores/identityStore'
import { invoke } from '@tauri-apps/api/core'

const uiStore       = useUIStore()
const serversStore  = useServersStore()
const channelsStore = useChannelsStore()
const identityStore = useIdentityStore()

const name      = ref('')
const creating  = ref(false)
const nameInput = ref<HTMLInputElement | null>(null)

watch(() => uiStore.showServerCreateModal, async (open) => {
  if (open) {
    name.value = ''
    creating.value = false
    await nextTick()
    nameInput.value?.focus()
  }
})

async function create() {
  const trimmed = name.value.trim()
  if (!trimmed || creating.value) return
  creating.value = true
  try {
    const server = await serversStore.createServer(trimmed)

    // Add self as owner/member
    await invoke('db_upsert_member', {
      member: {
        user_id:         identityStore.userId,
        server_id:       server.id,
        display_name:    identityStore.displayName,
        roles:           JSON.stringify(['owner']),
        joined_at:       new Date().toISOString(),
        public_sign_key: identityStore.publicSignKey ?? '',
        public_dh_key:   identityStore.publicDHKey ?? '',
        online_status:   'online',
      },
    })

    // Create default general channel and select it
    const channel = await channelsStore.createChannel(server.id, 'general', 'text')
    serversStore.setActiveServer(server.id)
    channelsStore.setActiveChannel(channel.id)

    uiStore.showServerCreateModal = false
    // Show invite modal so user can share immediately
    uiStore.openInviteModal(server.id)
  } catch (err) {
    uiStore.showNotification(`Failed to create server: ${err}`, 'error')
  } finally {
    creating.value = false
  }
}

function close() {
  if (!creating.value) uiStore.showServerCreateModal = false
}
</script>

<style scoped>
.modal-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.7);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.modal-box {
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  padding: var(--spacing-xl);
  width: 440px;
  max-width: 90vw;
  display: flex;
  flex-direction: column;
  gap: var(--spacing-md);
}

.modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.modal-header h2 {
  margin: 0;
  font-size: 20px;
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
}
.close-btn:hover { color: var(--text-primary); background: var(--bg-tertiary); }

.modal-hint {
  margin: 0;
  font-size: 14px;
  color: var(--text-secondary);
}

.field-label {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.04em;
  color: var(--text-secondary);
}

.text-input {
  background: var(--bg-primary);
  border: 1px solid var(--border-color);
  border-radius: 4px;
  padding: 10px var(--spacing-md);
  color: var(--text-primary);
  font-size: 14px;
  outline: none;
  width: 100%;
  box-sizing: border-box;
}
.text-input:focus { border-color: var(--accent-color); }

.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--spacing-sm);
  margin-top: var(--spacing-sm);
}

.btn-secondary {
  background: none;
  border: 1px solid var(--border-color);
  border-radius: 4px;
  padding: 8px 16px;
  color: var(--text-primary);
  font-size: 14px;
  cursor: pointer;
}
.btn-secondary:hover { background: var(--bg-tertiary); }

.btn-primary {
  background: var(--accent-color);
  border: none;
  border-radius: 4px;
  padding: 8px 16px;
  color: white;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
}
.btn-primary:hover:not(:disabled) { filter: brightness(1.1); }
.btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
</style>
