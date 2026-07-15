<template>
  <Teleport to="body">
    <div v-if="show" class="modal-backdrop" @click.self="$emit('cancel')">
      <div class="modal-box" role="dialog" aria-modal="true" aria-labelledby="channel-create-title">
        <h2 id="channel-create-title">Create {{ channelTypeLabel }} Channel</h2>

        <label class="field-label" for="channel-name-input">Name</label>
        <input
          id="channel-name-input"
          ref="inputEl"
          v-model="name"
          class="text-input"
          maxlength="80"
          :placeholder="channelType === 'voice' ? 'voice-room' : 'general-chat'"
          @keydown.enter="confirm"
          @keydown.esc="$emit('cancel')"
        />

        <div class="modal-actions">
          <button class="btn-secondary" @click="$emit('cancel')">Cancel</button>
          <button class="btn-primary" :disabled="!name.trim()" @click="confirm">Create</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import type { ChannelType } from '@/types/core'

const props = defineProps<{
  show: boolean
  channelType: ChannelType
}>()

const emit = defineEmits<{
  cancel: []
  confirm: [name: string]
}>()

const name = ref('')
const inputEl = ref<HTMLInputElement | null>(null)

const channelTypeLabel = computed(() => props.channelType === 'voice' ? 'Voice' : 'Text')

watch(() => props.show, async (open) => {
  if (!open) {
    name.value = ''
    return
  }
  await nextTick()
  inputEl.value?.focus()
})

function confirm() {
  const trimmed = name.value.trim()
  if (!trimmed) return
  emit('confirm', trimmed)
}
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
  width: min(440px, calc(100vw - 32px));
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-lg);
  padding: var(--spacing-lg);
  display: flex;
  flex-direction: column;
  gap: var(--spacing-md);
}

.modal-box h2 {
  margin: 0;
  font-size: 16px;
  font-weight: 700;
  color: var(--text-primary);
}

.field-label {
  font-size: 12px;
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.text-input {
  width: 100%;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  background: var(--bg-tertiary);
  color: var(--text-primary);
  padding: 8px 10px;
  font-size: 14px;
}

.text-input:focus {
  outline: none;
  border-color: var(--accent-color);
}

.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--spacing-sm);
}

.btn-secondary {
  border: 1px solid var(--border-color);
  background: var(--bg-tertiary);
  color: var(--text-primary);
  border-radius: var(--radius-sm);
  padding: 6px 14px;
  font-size: 12px;
  cursor: pointer;
}

.btn-primary {
  border: 1px solid var(--accent-color);
  background: var(--accent-color);
  color: #fff;
  border-radius: var(--radius-sm);
  padding: 6px 14px;
  font-size: 12px;
  cursor: pointer;
}

.btn-primary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
