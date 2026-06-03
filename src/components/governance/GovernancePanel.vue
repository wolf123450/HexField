<template>
  <div class="governance-panel">
    <!-- Detail view -->
    <MotionDetail
      v-if="selectedMotion"
      :motion="selectedMotion"
      :server-id="serverId"
      @close="selectedMotionId = null"
    />

    <!-- List view -->
    <template v-else>
      <div class="governance-header">
        <h3>Governance Motions</h3>
        <button class="btn-sm btn-primary" @click="showComposer = true">+ New Motion</button>
      </div>

      <div v-if="motions.length === 0" class="governance-empty">
        <p>No motions yet. Create one to propose a change, election, or poll.</p>
      </div>

      <div v-else class="motion-list">
        <div
          v-for="motion in motions"
          :key="motion.id"
          class="motion-card"
          :class="`state-${motion.state}`"
          @click="selectedMotionId = motion.id"
        >
          <div class="motion-card-header">
            <span class="motion-type-badge">{{ motionTypeLabel(motion.motion_type) }}</span>
            <span class="motion-state-badge">{{ motion.state.replace('_', ' ') }}</span>
          </div>
          <div class="motion-card-id">{{ motion.id.slice(0, 8) }}…</div>
        </div>
      </div>

      <MotionComposer
        v-if="showComposer"
        :server-id="serverId"
        @close="showComposer = false"
      />
    </template>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import { useGovernanceStore } from '@/stores/governanceStore'
import type { GovernanceMotionType } from '@/types/core'
import MotionComposer from './MotionComposer.vue'
import MotionDetail from './MotionDetail.vue'

const props = defineProps<{ serverId: string }>()
const governanceStore = useGovernanceStore()
const showComposer = ref(false)
const selectedMotionId = ref<string | null>(null)

const motions = computed(() => governanceStore.motionsByServer[props.serverId] ?? [])
const selectedMotion = computed(() =>
  selectedMotionId.value ? governanceStore.getMotionById(selectedMotionId.value) : null
)

function motionTypeLabel(type: GovernanceMotionType): string {
  return {
    election:        'Election',
    runoff:          'Runoff',
    non_binding_poll:'Poll',
    rule_change:     'Rule Change',
    server_transfer: 'Server Transfer',
  }[type] ?? type
}
</script>

<style scoped>
.governance-panel { display: flex; flex-direction: column; gap: var(--spacing-md); }
.governance-header { display: flex; justify-content: space-between; align-items: center; }
.governance-header h3 { margin: 0; font-size: 14px; font-weight: 600; }
.governance-empty p { color: var(--text-secondary); font-size: 13px; }
.motion-list { display: flex; flex-direction: column; gap: var(--spacing-sm); }
.motion-card { padding: var(--spacing-sm); background: var(--bg-secondary); border-radius: var(--radius-sm); cursor: pointer; border: 1px solid var(--border-color); }
.motion-card:hover { border-color: var(--accent-color); }
.motion-card-header { display: flex; gap: var(--spacing-xs); align-items: center; margin-bottom: 4px; }
.motion-type-badge { font-size: 11px; font-weight: 600; padding: 2px 6px; background: var(--accent-color); color: #fff; border-radius: var(--radius-sm); }
.motion-state-badge { font-size: 11px; color: var(--text-secondary); }
.motion-card-id { font-size: 11px; color: var(--text-tertiary); font-family: monospace; }
.btn-sm { padding: 4px 10px; font-size: 12px; border-radius: var(--radius-sm); border: none; cursor: pointer; }
.btn-primary { background: var(--accent-color); color: #fff; }
.btn-primary:hover { opacity: 0.85; }
</style>
