<template>
  <Teleport to="body">
    <div v-if="show" class="modal-backdrop" @click.self="$emit('close')">
      <div class="modal-box" role="dialog" aria-modal="true" aria-labelledby="governance-help-title">
        <div class="modal-header">
          <h2 id="governance-help-title">Governance Motions Guide</h2>
          <button class="close-btn" @click="$emit('close')">Close</button>
        </div>

        <section class="help-block">
          <h3>Motion Types</h3>
          <ul>
            <li><strong>Election:</strong> pick one or more seats by approvals.</li>
            <li><strong>Runoff:</strong> tie-breaker motion created when election approvals tie at the seat boundary.</li>
            <li><strong>Poll:</strong> non-binding pulse check for community preference.</li>
            <li><strong>Rule Change / Server Transfer:</strong> binding governance decisions for server policy/ownership transitions.</li>
          </ul>
        </section>

        <section class="help-block">
          <h3>Lifecycle</h3>
          <ul>
            <li><strong>Draft:</strong> motion created, still editable before discussion starts.</li>
            <li><strong>Discussion:</strong> binding motions wait for seconding and minimum discussion window.</li>
            <li><strong>Voting:</strong> voter eligibility snapshot is frozen when voting opens.</li>
            <li><strong>Closed:</strong> tally applies quorum, majority, and reject-veto rules.</li>
          </ul>
        </section>

        <section class="help-block">
          <h3>Binding Rules</h3>
          <ul>
            <li>Binding motions require seconding before voting can open.</li>
            <li>Binding motions require at least 24 hours of discussion before voting can open.</li>
            <li>Non-binding polls can open voting immediately.</li>
          </ul>
        </section>

        <section class="help-block">
          <h3>Where To Use Governance</h3>
          <ul>
            <li>Open a server in the sidebar and click the gavel icon in the server header.</li>
            <li>That opens the Governance modal where you can review motions or create a new draft.</li>
          </ul>
        </section>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
defineProps<{ show: boolean }>()
defineEmits<{ close: [] }>()
</script>

<style scoped>
.modal-backdrop {
  position: fixed;
  inset: 0;
  z-index: 1500;
  background: rgba(0, 0, 0, 0.7);
  display: flex;
  align-items: center;
  justify-content: center;
}

.modal-box {
  width: min(760px, calc(100vw - 32px));
  max-height: calc(100vh - 64px);
  overflow: auto;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-lg);
  padding: var(--spacing-lg);
  display: flex;
  flex-direction: column;
  gap: var(--spacing-lg);
}

.modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.modal-header h2 {
  margin: 0;
  font-size: 18px;
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

.help-block h3 {
  margin: 0 0 var(--spacing-xs) 0;
  font-size: 14px;
  color: var(--text-primary);
}

.help-block ul {
  margin: 0;
  padding-left: 18px;
  color: var(--text-secondary);
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 13px;
  line-height: 1.5;
}
</style>
