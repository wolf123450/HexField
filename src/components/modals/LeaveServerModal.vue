<template>
  <Teleport to="body">
    <div v-if="visible" class="modal-backdrop" @mousedown.self="cancel">
      <div class="modal-box" role="dialog" aria-labelledby="leave-modal-title">
        <div class="modal-header">
          <h2 id="leave-modal-title">Leave Server</h2>
        </div>
        <p class="modal-body">
          Are you sure you want to leave <strong>{{ serverName }}</strong>?
          You will lose access to all channels and messages.
        </p>
        <div class="modal-actions">
          <button class="btn-secondary" @click="cancel">Cancel</button>
          <button class="btn-danger" autofocus @click="confirm">Leave</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useServersStore } from '@/stores/serversStore'
import { useUIStore } from '@/stores/uiStore'

const serversStore = useServersStore()
const uiStore      = useUIStore()

const visible    = computed(() => uiStore.leaveServerModalVisible)
const serverId   = computed(() => uiStore.leaveServerModalServerId)
const serverName = computed(() => serverId.value ? (serversStore.servers[serverId.value]?.name ?? '') : '')

function cancel() {
  uiStore.hideLeaveServerModal()
}

async function confirm() {
  if (!serverId.value) return
  await serversStore.leaveServer(serverId.value)
  uiStore.hideLeaveServerModal()
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
  z-index: 2000;
}

.modal-box {
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  padding: var(--spacing-xl);
  width: 420px;
  max-width: 90vw;
  display: flex;
  flex-direction: column;
  gap: var(--spacing-md);
}

.modal-header h2 {
  margin: 0;
  font-size: 1.1rem;
  color: var(--text-primary);
}

.modal-body {
  margin: 0;
  color: var(--text-secondary);
  line-height: 1.5;
}

.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--spacing-sm);
}
</style>
