<template>
  <div v-if="reactions.length > 0 || showAddButton" class="reaction-bar">
    <button
      v-for="reaction in reactions"
      :key="reaction.emojiId"
      class="reaction-pill"
      :class="{ 'self-reacted': reaction.selfReacted }"
      :title="emojiLabel(reaction.emojiId)"
      @click="toggleReaction(reaction)"
    >
      <template v-if="isCustomEmoji(reaction.emojiId)">
        <img
          v-if="emojiStore.imageCache[reaction.emojiId]"
          :src="emojiStore.imageCache[reaction.emojiId]"
          class="custom-emoji-img"
          :alt="emojiLabel(reaction.emojiId)"
        />
        <span v-else class="emoji-placeholder">?</span>
      </template>
      <span v-else class="native-emoji">{{ unicodeChar(reaction.emojiId) }}</span>
      <span class="reaction-count">{{ reaction.count }}</span>
    </button>
    <button
      v-if="showAddButton"
      class="reaction-add-btn"
      title="Add reaction"
      @click.stop="$emit('open-picker', $event)"
    >
      <AppIcon :path="mdiEmoticonPlus" :size="16" />
    </button>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { ReactionSummary } from '@/types/core'
import { mdiEmoticonPlus } from '@mdi/js'
import { useEmojiStore } from '@/stores/emojiStore'
import { useMessagesStore } from '@/stores/messagesStore'
import emojiData from '@/assets/emoji-data.json'

const props = defineProps<{
  messageId: string
  channelId: string
  serverId:  string
  reactions: ReactionSummary[]
  showAddButton?: boolean
}>()

defineEmits<{
  'open-picker': [event: MouseEvent]
}>()

const emojiStore    = useEmojiStore()
const messagesStore = useMessagesStore()

// Build a fast lookup map from the bundled unicode data
const unicodeMap = computed<Record<string, string>>(() => {
  const m: Record<string, string> = {}
  for (const e of emojiData) m[e.id] = e.char
  return m
})

const reactions = computed(() =>
  [...props.reactions]
    .filter(r => r.count > 0)
    .sort((a, b) => b.count - a.count)
)

function isCustomEmoji(emojiId: string): boolean {
  // Custom emoji IDs are UUID v7 (36-char hyphenated); unicode IDs are short hex codes
  return emojiId.length > 20
}

function unicodeChar(emojiId: string): string {
  return unicodeMap.value[emojiId] ?? emojiId
}

function emojiLabel(emojiId: string): string {
  if (isCustomEmoji(emojiId)) {
    // Look up custom emoji name across all servers
    for (const serverEmoji of Object.values(emojiStore.custom)) {
      if (serverEmoji[emojiId]) return `:${serverEmoji[emojiId].name}:`
    }
    return emojiId
  }
  const entry = emojiData.find(e => e.id === emojiId)
  return entry ? `:${entry.name}:` : emojiId
}

async function toggleReaction(reaction: ReactionSummary) {
  if (reaction.selfReacted) {
    await messagesStore.removeReaction(props.messageId, props.channelId, props.serverId, reaction.emojiId)
  } else {
    await messagesStore.addReaction(props.messageId, props.channelId, props.serverId, reaction.emojiId)
  }
  emojiStore.useEmoji(reaction.emojiId)
}
</script>

<style scoped>
.reaction-bar {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 4px;
  padding: 0 2px;
}

.reaction-pill {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  border-radius: 12px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color, rgba(255,255,255,0.08));
  cursor: pointer;
  font-size: 14px;
  line-height: 1.4;
  color: var(--text-secondary);
  transition: background 0.1s, border-color 0.1s;
}

.reaction-pill:hover {
  background: var(--bg-tertiary);
  border-color: var(--accent-color);
}

.reaction-pill.self-reacted {
  background: color-mix(in srgb, var(--accent-color) 20%, transparent);
  border-color: var(--accent-color);
  color: var(--text-primary);
}

.reaction-count {
  font-size: 12px;
  font-weight: 600;
}

.custom-emoji-img {
  width: 16px;
  height: 16px;
  object-fit: contain;
}

.emoji-placeholder {
  font-size: 12px;
  color: var(--text-tertiary);
}

.native-emoji {
  font-size: 18px;
  line-height: 1;
  vertical-align: -0.1em;
}

.reaction-add-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 24px;
  padding: 0;
  border-radius: 12px;
  background: var(--bg-secondary);
  border: 1px dashed var(--border-color, rgba(255,255,255,0.12));
  cursor: pointer;
  color: var(--text-tertiary);
  transition: color 0.1s, border-color 0.1s, background 0.1s;
  transform: none;
}

.reaction-add-btn:hover {
  color: var(--text-secondary);
  border-color: var(--accent-color);
  background: var(--bg-tertiary);
  transform: none;
}
</style>
