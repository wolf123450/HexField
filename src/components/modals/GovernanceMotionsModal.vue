<template>
  <Teleport to="body">
    <div v-if="show" class="modal-backdrop" @click.self="$emit('close')">
      <div class="modal-box" role="dialog" aria-modal="true" aria-labelledby="governance-motions-title">
        <div class="modal-header">
          <h2 id="governance-motions-title">Governance</h2>
          <button class="close-btn" @click="$emit('close')">Close</button>
        </div>

        <div v-if="!serverId" class="empty-state">Select a server to manage motions.</div>
        <GovernancePanel v-else :server-id="serverId" />
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { watch } from 'vue'
import { useGovernanceStore } from '@/stores/governanceStore'
import GovernancePanel from '@/components/governance/GovernancePanel.vue'

const props = defineProps<{ show: boolean; serverId: string | null }>()
defineEmits<{ close: [] }>()

const governanceStore = useGovernanceStore()

watch(
  () => [props.show, props.serverId] as const,
  async ([open, serverId]) => {
    if (open && serverId) await governanceStore.loadMotions(serverId)
  },
  { immediate: true },
)
</script>

<style scoped>
.modal-backdrop {
  position: fixed;
  inset: 0;
  z-index: 1300;
  background: rgba(0, 0, 0, 0.66);
  display: flex;
  align-items: center;
  justify-content: center;
}

.modal-box {
  width: min(780px, calc(100vw - 32px));
  max-height: calc(100vh - 64px);
  overflow: auto;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-lg);
  padding: var(--spacing-lg);
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
  font-size: 16px;
  font-weight: 700;
  color: var(--text-primary);
}

.close-btn {
  border: 1px solid var(--border-color);
  background: var(--bg-tertiary);
  color: var(--text-primary);
  border-radius: var(--radius-sm);
  padding: 6px 10px;
  font-size: 12px;
  cursor: pointer;
}

.close-btn:hover {
  border-color: var(--accent-color);
}

.empty-state {
  color: var(--text-secondary);
  font-size: 13px;
}
</style>
