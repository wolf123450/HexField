<template>
  <div class="message-bubble" :class="{ 'has-header': showHeader }">
    <template v-if="showHeader">
      <div class="message-avatar">{{ authorInitials }}</div>
      <div class="message-main">
        <div class="message-header">
          <span class="author-name">{{ authorName }}</span>
          <span class="message-time">{{ formattedTime }}</span>
          <span v-if="message.isEdited" class="edited-label">(edited)</span>
        </div>
        <MessageContent :message="message" />
      </div>
    </template>
    <template v-else>
      <div class="message-indent" />
      <div class="message-main">
        <MessageContent :message="message" />
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { formatDistanceToNow } from 'date-fns'
import type { Message } from '@/types/core'
import { useServersStore } from '@/stores/serversStore'
import { useIdentityStore } from '@/stores/identityStore'
import MessageContent from './MessageContent.vue'

const props = defineProps<{
  message: Message
  showHeader: boolean
}>()

const serversStore  = useServersStore()
const identityStore = useIdentityStore()

const author = computed(() => {
  const members = serversStore.members[props.message.serverId] ?? {}
  return members[props.message.authorId]
})

const authorName = computed(() => {
  if (props.message.authorId === identityStore.userId) return identityStore.displayName
  return author.value?.displayName ?? props.message.authorId.slice(0, 8)
})

const authorInitials = computed(() => {
  return authorName.value.split(' ').map((w: string) => w[0]).join('').slice(0, 2).toUpperCase()
})

const formattedTime = computed(() => {
  try {
    return formatDistanceToNow(new Date(props.message.createdAt), { addSuffix: true })
  } catch {
    return ''
  }
})
</script>

<style scoped>
.message-bubble {
  display: grid;
  grid-template-columns: 40px 1fr;
  gap: 0 var(--spacing-sm);
  padding: 2px var(--spacing-md);
  transition: background 0.1s ease;
}

.message-bubble:hover {
  background: var(--bg-secondary);
}

.message-bubble.has-header {
  padding-top: var(--spacing-sm);
}

.message-avatar {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  background: var(--accent-color);
  color: white;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  font-weight: 700;
  flex-shrink: 0;
  margin-top: 2px;
}

.message-indent {
  width: 36px;
  flex-shrink: 0;
}

.message-main {
  min-width: 0;
}

.message-header {
  display: flex;
  align-items: baseline;
  gap: var(--spacing-sm);
  margin-bottom: 2px;
}

.author-name {
  font-weight: 600;
  font-size: 14px;
  color: var(--text-primary);
}

.message-time {
  font-size: 11px;
  color: var(--text-tertiary);
}

.edited-label {
  font-size: 11px;
  color: var(--text-tertiary);
  font-style: italic;
}
</style>
