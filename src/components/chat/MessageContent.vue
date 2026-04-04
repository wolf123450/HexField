<template>
  <div class="message-content">
    <template v-if="message.content !== null">
      <p class="message-text">
        <template v-for="(part, i) in parsedContent" :key="i">
          <span v-if="part.type === 'mention'" class="mention" :class="{ 'mention--self': part.isSelf }">{{ part.text }}</span>
          <template v-else>{{ part.text }}</template>
        </template>
      </p>
    </template>
    <template v-else>
      <p v-if="settingsStore.settings.showDeletedMessagePlaceholder" class="message-deleted">
        message deleted
      </p>
    </template>

    <!-- Attachments -->
    <div v-if="message.attachments.length > 0" class="attachments">
      <AttachmentPreview
        v-for="att in message.attachments"
        :key="att.id"
        :attachment="att"
        :message-id="message.id"
        :server-id="message.serverId"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { Message } from '@/types/core'
import { useSettingsStore } from '@/stores/settingsStore'
import { useServersStore } from '@/stores/serversStore'
import { useIdentityStore } from '@/stores/identityStore'
import AttachmentPreview from './AttachmentPreview.vue'

const props = defineProps<{ message: Message }>()

const settingsStore  = useSettingsStore()
const serversStore   = useServersStore()
const identityStore  = useIdentityStore()

interface ContentPart {
  type: 'text' | 'mention'
  text: string
  isSelf?: boolean
}

const parsedContent = computed((): ContentPart[] => {
  const content = props.message.content
  if (!content) return []

  const members = serversStore.members[props.message.serverId] ?? {}
  // Build a set of all known display names (lower-case for matching)
  const memberNames = Object.values(members).map(m => m.displayName)
  const myName = identityStore.displayName

  // Split on @word-boundary tokens
  const parts: ContentPart[] = []
  // Regex: @<word chars + spaces, non-greedy> — match longest name first
  // We do a simple linear scan instead to avoid catastrophic backtracking
  let remaining = content
  while (remaining.length > 0) {
    const atIdx = remaining.indexOf('@')
    if (atIdx === -1) {
      parts.push({ type: 'text', text: remaining })
      break
    }
    if (atIdx > 0) {
      parts.push({ type: 'text', text: remaining.slice(0, atIdx) })
    }
    // Try to match the longest known name starting at @
    const afterAt = remaining.slice(atIdx + 1)
    // Sort by length descending so longest match wins
    const sorted = [...memberNames, myName].sort((a, b) => b.length - a.length)
    const matched = sorted.find(n =>
      afterAt.toLowerCase().startsWith(n.toLowerCase()) &&
      (afterAt.length === n.length || /\W/.test(afterAt[n.length]))
    )
    if (matched) {
      parts.push({ type: 'mention', text: `@${matched}`, isSelf: matched.toLowerCase() === myName.toLowerCase() })
      remaining = remaining.slice(atIdx + 1 + matched.length)
    } else {
      // No known name matched — treat '@' as literal text
      parts.push({ type: 'text', text: '@' })
      remaining = afterAt
    }
  }
  return parts
})
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

.mention {
  color: var(--accent-color);
  background: color-mix(in srgb, var(--accent-color) 15%, transparent);
  border-radius: 3px;
  padding: 0 2px;
  font-weight: 500;
}

.mention--self {
  color: #fff;
  background: color-mix(in srgb, var(--accent-color) 60%, transparent);
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
</style>
