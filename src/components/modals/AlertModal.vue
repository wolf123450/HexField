<template>
  <Teleport to="body">
    <div v-if="uiStore.alertVisible" class="modal-backdrop">
      <div class="modal-box" role="alertdialog" :aria-labelledby="titleId" :aria-describedby="bodyId">
        <div class="modal-header">
          <h2 :id="titleId">{{ uiStore.alertTitle }}</h2>
        </div>
        <p :id="bodyId" class="modal-body">{{ uiStore.alertMessage }}</p>
        <div class="modal-actions">
          <button class="btn-primary" autofocus @click="uiStore.dismissAlert()">OK</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { useUIStore } from '@/stores/uiStore'

const uiStore  = useUIStore()
const titleId  = 'alert-modal-title'
const bodyId   = 'alert-modal-body'
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

.modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.modal-header h2 { margin: 0; font-size: 18px; color: var(--text-primary); }

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
  margin-top: var(--spacing-sm);
}

.btn-primary {
  background: var(--accent-color);
  border: none;
  border-radius: 4px;
  padding: 8px 24px;
  color: white;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
}
.btn-primary:hover { filter: brightness(1.1); }
</style>
