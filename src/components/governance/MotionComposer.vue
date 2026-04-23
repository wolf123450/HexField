<template>
  <div class="composer-overlay" @click.self="$emit('close')">
    <div class="composer-card">
      <h3>New Motion</h3>

      <div class="form-row">
        <label class="form-label">Motion Type</label>
        <select v-model="motionType" class="form-select">
          <option value="election">Election</option>
          <option value="non_binding_poll">Poll (non-binding)</option>
          <option value="rule_change">Rule Change</option>
          <option value="server_transfer">Server Transfer</option>
        </select>
      </div>

      <div class="form-row">
        <label class="toggle-row">
          <input type="checkbox" v-model="isBinding" />
          <span>Binding motion (requires seconding + discussion window)</span>
        </label>
      </div>

      <div v-if="motionType === 'election'" class="form-row">
        <label class="form-label">Seat Count</label>
        <input v-model.number="seatCount" type="number" min="1" class="form-input" />
      </div>

      <div class="composer-actions">
        <button class="btn-sm" @click="$emit('close')">Cancel</button>
        <button class="btn-sm btn-primary" :disabled="submitting" @click="submit">Create Draft</button>
      </div>

      <p v-if="errorMsg" class="error-msg">{{ errorMsg }}</p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { useGovernanceStore } from '@/stores/governanceStore'
import type { GovernanceMotionType } from '@/types/core'

const props = defineProps<{ serverId: string }>()
const emit = defineEmits<{ close: [] }>()

const governanceStore = useGovernanceStore()
const motionType = ref<GovernanceMotionType>('non_binding_poll')
const isBinding  = ref(false)
const seatCount  = ref(1)
const submitting = ref(false)
const errorMsg   = ref('')

async function submit() {
  submitting.value = true
  errorMsg.value = ''
  try {
    await governanceStore.createDraft({
      serverId:   props.serverId,
      motionType: motionType.value,
      isBinding:  isBinding.value,
      seatCount:  motionType.value === 'election' ? seatCount.value : undefined,
    })
    emit('close')
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : String(e)
  } finally {
    submitting.value = false
  }
}
</script>

<style scoped>
.composer-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.6); display: flex; align-items: center; justify-content: center; z-index: 200; }
.composer-card { background: var(--bg-secondary); border-radius: var(--radius-md); padding: var(--spacing-lg); width: 360px; display: flex; flex-direction: column; gap: var(--spacing-md); }
.composer-card h3 { margin: 0; font-size: 15px; font-weight: 600; }
.form-row { display: flex; flex-direction: column; gap: 4px; }
.form-label { font-size: 11px; font-weight: 600; text-transform: uppercase; color: var(--text-secondary); }
.form-select, .form-input { padding: 6px 8px; background: var(--bg-primary); border: 1px solid var(--border-color); border-radius: var(--radius-sm); color: var(--text-primary); font-size: 13px; }
.toggle-row { display: flex; align-items: center; gap: var(--spacing-sm); cursor: pointer; font-size: 13px; }
.composer-actions { display: flex; justify-content: flex-end; gap: var(--spacing-sm); }
.btn-sm { padding: 5px 12px; font-size: 12px; border-radius: var(--radius-sm); border: 1px solid var(--border-color); cursor: pointer; background: var(--bg-primary); color: var(--text-primary); }
.btn-primary { background: var(--accent-color); color: #fff; border-color: transparent; }
.btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
.error-msg { color: var(--error-color); font-size: 12px; }
</style>
