<template>
  <Teleport to="body">
    <div v-if="uiStore.confirmVisible" class="modal-backdrop" @click.self="uiStore.resolveConfirm(false)">
      <div class="modal-box" role="alertdialog" :aria-labelledby="titleId" :aria-describedby="bodyId">
        <div class="modal-header">
          <h2 :id="titleId">{{ uiStore.confirmTitle }}</h2>
        </div>
        <p :id="bodyId" class="modal-body">{{ uiStore.confirmMessage }}</p>
        <div class="modal-actions">
          <button class="btn-secondary" @click="uiStore.resolveConfirm(false)">{{ uiStore.confirmCancelText }}</button>
          <button
            class="btn-primary"
            :class="{ danger: uiStore.confirmDanger }"
            autofocus
            @click="uiStore.resolveConfirm(true)"
          >
            {{ uiStore.confirmConfirmText }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { useUIStore } from '@/stores/uiStore'

const uiStore = useUIStore()
const titleId = 'confirm-modal-title'
const bodyId = 'confirm-modal-body'
</script>

<style scoped>
.modal-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.7);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 2000;
}

.modal-box {
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  padding: var(--spacing-xl);
  width: 460px;
  max-width: 90vw;
  display: flex;
  flex-direction: column;
  gap: var(--spacing-md);
}

.modal-header h2 {
  margin: 0;
  font-size: 18px;
  color: var(--text-primary);
}

.modal-body {
  margin: 0;
  font-size: 14px;
  color: var(--text-secondary);
  line-height: 1.6;
  white-space: pre-wrap;
}

.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--spacing-sm);
}

.btn-secondary {
  background: var(--bg-tertiary);
  border: 1px solid var(--border-color);
  border-radius: 4px;
  padding: 8px 20px;
  color: var(--text-primary);
  font-size: 14px;
  cursor: pointer;
}

.btn-secondary:hover {
  border-color: var(--accent-color);
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

.btn-primary:hover {
  filter: brightness(1.1);
}

.btn-primary.danger {
  background: var(--error-color);
}
</style>
