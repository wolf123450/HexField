<template>
  <Teleport to="body">
    <div v-if="uiStore.showJoinModal" class="modal-backdrop" @click.self="close">
      <div class="modal-box" @keydown.esc="close">
        <div class="modal-header">
          <h2>Join a Server</h2>
          <button class="close-btn" @click="close">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
            </svg>
          </button>
        </div>

        <p class="modal-hint">
          Paste an invite link or enter an invite code to join a server.
        </p>

        <label class="field-label">INVITE LINK OR CODE</label>
        <input
          ref="inputRef"
          v-model="code"
          class="text-input"
          placeholder="gamechat://join/... or 12-digit code"
          :disabled="joining"
          @keydown.enter="join"
        />

        <div class="phase-notice">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/>
          </svg>
          P2P joining is implemented in Phase 3. For now, share the invite code out-of-band and have your peer paste it manually.
        </div>

        <div class="modal-actions">
          <button class="btn-secondary" :disabled="joining" @click="close">Cancel</button>
          <button class="btn-primary" :disabled="!code.trim() || joining" @click="join">
            {{ joining ? 'Joining…' : 'Join Server' }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, watch, nextTick } from 'vue'
import { useUIStore } from '@/stores/uiStore'

const uiStore  = useUIStore()
const code     = ref('')
const joining  = ref(false)
const inputRef = ref<HTMLInputElement | null>(null)

watch(() => uiStore.showJoinModal, async (open) => {
  if (open) {
    code.value = ''
    joining.value = false
    await nextTick()
    inputRef.value?.focus()
  }
})

async function join() {
  if (!code.value.trim() || joining.value) return
  joining.value = true
  // Phase 3: real P2P join will resolve peer, exchange keys, and upsert server
  uiStore.showNotification('P2P join coming in Phase 3. Share the invite code out-of-band for now.', 'info', 5000)
  joining.value = false
  uiStore.showJoinModal = false
}

function close() {
  if (!joining.value) uiStore.showJoinModal = false
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
.modal-header h2 { margin: 0; font-size: 20px; color: var(--text-primary); }

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

.phase-notice {
  display: flex;
  align-items: flex-start;
  gap: var(--spacing-sm);
  background: var(--bg-tertiary);
  border-radius: 4px;
  padding: var(--spacing-sm) var(--spacing-md);
  font-size: 12px;
  color: var(--text-secondary);
  line-height: 1.5;
}
.phase-notice svg { flex-shrink: 0; margin-top: 1px; color: var(--accent-color); }

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
