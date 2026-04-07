<template>
  <Teleport to="body">
    <div v-if="show" class="mod-backdrop" @click.self="$emit('cancel')">
      <div class="mod-box" @keydown.esc="$emit('cancel')">
        <div class="mod-header">
          <h2 class="mod-title">{{ title }}</h2>
          <button class="close-btn" @click="$emit('cancel')">
            <AppIcon :path="mdiClose" :size="16" />
          </button>
        </div>

        <p class="mod-body">{{ body }}</p>

        <div class="mod-reason">
          <label class="mod-label">Reason <span class="mod-optional">(optional)</span></label>
          <textarea
            v-model="reason"
            class="mod-textarea"
            rows="3"
            :placeholder="reasonPlaceholder"
            maxlength="400"
          />
          <div class="mod-char-count">{{ reason.length }} / 400</div>
        </div>

        <div class="mod-actions">
          <button class="btn-secondary" @click="$emit('cancel')">Cancel</button>
          <button class="btn-danger" @click="onConfirm">{{ confirmLabel }}</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'
import { mdiClose } from '@mdi/js'

const props = withDefaults(defineProps<{
  show: boolean
  title: string
  body: string
  confirmLabel?: string
  reasonPlaceholder?: string
}>(), {
  confirmLabel: 'Confirm',
  reasonPlaceholder: 'Add a reason…',
})

const emit = defineEmits<{
  confirm: [reason: string]
  cancel: []
}>()

const reason = ref('')

// Reset reason text each time the modal opens
watch(() => props.show, (open) => {
  if (open) reason.value = ''
})

function onConfirm() {
  emit('confirm', reason.value.trim())
}
</script>

<style scoped>
.mod-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.65);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1100;
}

.mod-box {
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  width: 420px;
  max-width: calc(100vw - 32px);
  padding: var(--spacing-xl);
  display: flex;
  flex-direction: column;
  gap: var(--spacing-md);
}

.mod-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.mod-title {
  margin: 0;
  font-size: 16px;
  font-weight: 700;
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
  align-items: center;
}
.close-btn:hover { color: var(--text-primary); background: var(--bg-tertiary); }

.mod-body {
  margin: 0;
  font-size: 14px;
  color: var(--text-secondary);
  line-height: 1.5;
}

.mod-reason {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.mod-label {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-secondary);
  letter-spacing: 0.04em;
}

.mod-optional {
  font-weight: 400;
  color: var(--text-tertiary);
}

.mod-textarea {
  resize: vertical;
  min-height: 68px;
  background: var(--bg-tertiary);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  color: var(--text-primary);
  font-size: 14px;
  padding: var(--spacing-sm) var(--spacing-md);
  font-family: inherit;
  line-height: 1.5;
}
.mod-textarea:focus {
  outline: none;
  border-color: var(--accent-color);
}

.mod-char-count {
  font-size: 11px;
  color: var(--text-tertiary);
  text-align: right;
}

.mod-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--spacing-sm);
  margin-top: var(--spacing-xs);
}

.btn-secondary {
  background: var(--bg-tertiary);
  border: 1px solid var(--border-color);
  color: var(--text-primary);
  border-radius: 6px;
  padding: var(--spacing-xs) var(--spacing-lg);
  font-size: 14px;
  cursor: pointer;
  font-weight: 500;
}
.btn-secondary:hover { background: var(--bg-primary); }

.btn-danger {
  background: var(--error-color, #ed4245);
  border: none;
  color: #fff;
  border-radius: 6px;
  padding: var(--spacing-xs) var(--spacing-lg);
  font-size: 14px;
  cursor: pointer;
  font-weight: 600;
}
.btn-danger:hover { filter: brightness(1.1); }
</style>
