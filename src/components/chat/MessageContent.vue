<template>
  <div class="message-content">
    <template v-if="message.content !== null">
      <p class="message-text">{{ message.content }}</p>
    </template>
    <template v-else>
      <p v-if="settingsStore.settings.showDeletedMessagePlaceholder" class="message-deleted">
        message deleted
      </p>
    </template>
  </div>
</template>

<script setup lang="ts">
import type { Message } from '@/types/core'
import { useSettingsStore } from '@/stores/settingsStore'

defineProps<{ message: Message }>()

const settingsStore = useSettingsStore()
</script>

<style scoped>
.message-content {
  min-width: 0;
}

.message-text {
  font-size: 14px;
  line-height: 1.5;
  color: var(--text-primary);
  margin: 0;
  word-break: break-word;
  white-space: pre-wrap;
}

.message-deleted {
  font-size: 13px;
  color: var(--text-tertiary);
  font-style: italic;
  margin: 0;
}
</style>
