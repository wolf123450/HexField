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

    <!-- Attachments -->
    <div v-if="message.attachments.length > 0" class="attachments">
      <div v-for="att in message.attachments" :key="att.id" class="attachment">
        <!-- Inline image -->
        <img
          v-if="att.mimeType.startsWith('image/') && att.inlineData"
          :src="`data:${att.mimeType};base64,${att.inlineData}`"
          class="attachment-image"
          :alt="att.name"
          loading="lazy"
        />
        <!-- External URL -->
        <a
          v-else-if="att.url"
          :href="att.url"
          target="_blank"
          rel="noopener noreferrer"
          class="attachment-link"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
            <path d="M16.5 6v11.5c0 2.21-1.79 4-4 4s-4-1.79-4-4V5c0-1.38 1.12-2.5 2.5-2.5s2.5 1.12 2.5 2.5v10.5c0 .55-.45 1-1 1s-1-.45-1-1V6H10v9.5c0 1.38 1.12 2.5 2.5 2.5s2.5-1.12 2.5-2.5V5c0-2.21-1.79-4-4-4S7 2.79 7 5v12.5c0 3.04 2.46 5.5 5.5 5.5s5.5-2.46 5.5-5.5V6h-1.5z"/>
          </svg>
          {{ att.name }}
        </a>
        <!-- Non-inline file (pending P2P transfer) -->
        <div v-else class="attachment-pending">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
            <path d="M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z"/>
          </svg>
          <span class="attachment-name">{{ att.name }}</span>
          <span class="attachment-size">{{ formatSize(att.size) }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { Message } from '@/types/core'
import { useSettingsStore } from '@/stores/settingsStore'

defineProps<{ message: Message }>()

const settingsStore = useSettingsStore()

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
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

.attachments {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-sm);
  margin-top: var(--spacing-xs);
}

.attachment-image {
  max-width: 400px;
  max-height: 300px;
  border-radius: 6px;
  display: block;
  object-fit: contain;
  background: var(--bg-tertiary);
}

.attachment-link {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--accent-color);
  font-size: 13px;
  text-decoration: none;
}

.attachment-link:hover {
  text-decoration: underline;
}

.attachment-pending {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  padding: 6px 10px;
  font-size: 13px;
  color: var(--text-secondary);
}

.attachment-name {
  font-weight: 500;
  color: var(--text-primary);
}

.attachment-size {
  color: var(--text-tertiary);
  font-size: 11px;
}
</style>
