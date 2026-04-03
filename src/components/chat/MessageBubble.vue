<template>
  <div
    class="message-bubble"
    :class="{ 'has-header': showHeader }"
    @mouseenter="isHovered = true"
    @mouseleave="isHovered = false"
  >
    <!-- Hover action bar: quick-react + full picker button -->
    <div v-if="isHovered && message.content !== null" class="message-actions">
      <button
        v-for="emojiId in emojiStore.topEmoji"
        :key="emojiId"
        class="action-btn quick-react-btn"
        :title="emojiId"
        @click.stop="quickReact(emojiId)"
      >
        <img
          v-if="isCustomEmoji(emojiId) && emojiStore.imageCache[emojiId]"
          :src="emojiStore.imageCache[emojiId]"
          class="quick-emoji-img"
          :alt="emojiId"
        />
        <span
          v-else-if="!isCustomEmoji(emojiId)"
          class="native-emoji quick-emoji-char"
        >{{ codepointToChar(emojiId) }}</span>
      </button>
      <button class="action-btn" title="Add reaction" @click.stop="openPickerFromBar">
        <AppIcon :path="mdiEmoticonPlus" :size="20" />
      </button>
    </div>

    <template v-if="showHeader">
      <div class="message-avatar" style="cursor:pointer" title="View profile" @click="uiStore.openUserProfile(message.authorId, message.serverId)">{{ authorInitials }}</div>
      <div class="message-main">
        <div class="message-header">
          <span class="author-name">{{ authorName }}</span>
          <span class="message-time">{{ formattedTime }}</span>
          <span v-if="message.isEdited" class="edited-label">(edited)</span>
        </div>
        <MessageContent :message="message" />
        <ReactionBar
          v-if="message.reactions.length > 0"
          :message-id="message.id"
          :channel-id="message.channelId"
          :server-id="message.serverId"
          :reactions="message.reactions"
          :show-add-button="true"
          @open-picker="openPicker"
        />
      </div>
    </template>
    <template v-else>
      <div class="message-indent" />
      <div class="message-main">
        <MessageContent :message="message" />
        <ReactionBar
          v-if="message.reactions.length > 0"
          :message-id="message.id"
          :channel-id="message.channelId"
          :server-id="message.serverId"
          :reactions="message.reactions"
          :show-add-button="true"
          @open-picker="openPicker"
        />
      </div>
    </template>
  </div>
  <EmojiPicker
    ref="picker"
    :message-id="message.id"
    :channel-id="message.channelId"
    :server-id="message.serverId"
    :anchor-x="pickerX"
    :anchor-y="pickerY"
    @select="onEmojiSelected"
  />
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { formatDistanceToNow } from 'date-fns'
import type { Message } from '@/types/core'
import { mdiEmoticonPlus } from '@mdi/js'
import { useUIStore } from '@/stores/uiStore'
import { useServersStore } from '@/stores/serversStore'
import { useIdentityStore } from '@/stores/identityStore'
import { useMessagesStore } from '@/stores/messagesStore'
import { useEmojiStore } from '@/stores/emojiStore'
import { codepointToChar } from '@/utils/twemoji'
import MessageContent from './MessageContent.vue'
import ReactionBar from './ReactionBar.vue'
import EmojiPicker from './EmojiPicker.vue'

const props = defineProps<{
  message: Message
  showHeader: boolean
}>()

const serversStore  = useServersStore()
const identityStore = useIdentityStore()
const uiStore       = useUIStore()
const messagesStore = useMessagesStore()
const emojiStore    = useEmojiStore()

const isHovered = ref(false)
const picker    = ref<InstanceType<typeof EmojiPicker> | null>(null)
const pickerX   = ref(0)
const pickerY   = ref(0)

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

function isCustomEmoji(emojiId: string): boolean {
  return emojiId.length > 20
}

function openPickerFromBar(event: MouseEvent) {
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
  pickerX.value = rect.left
  pickerY.value = rect.bottom + 4
  picker.value?.open()
}

function openPicker(event: MouseEvent) {
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
  pickerX.value = rect.left
  pickerY.value = rect.bottom + 4
  picker.value?.open()
}

async function onEmojiSelected(emojiId: string) {
  await messagesStore.addReaction(
    props.message.id,
    props.message.channelId,
    props.message.serverId,
    emojiId,
  )
}

async function quickReact(emojiId: string) {
  await messagesStore.addReaction(
    props.message.id,
    props.message.channelId,
    props.message.serverId,
    emojiId,
  )
}
</script>

<style scoped>
.message-bubble {
  position: relative;
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

/* Hover action bar — floats over the top-right corner */
.message-actions {
  position: absolute;
  top: -14px;
  right: var(--spacing-md);
  display: flex;
  gap: 2px;
  background: var(--bg-primary);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 6px;
  padding: 2px;
  z-index: 10;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.35);
}

.action-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  padding: 0;
  background: none;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  color: var(--text-tertiary);
  transition: color 0.1s, background 0.1s;
  transform: none;
}

.action-btn:hover {
  background: var(--bg-secondary);
  color: var(--accent-color);
  transform: none;
}

.quick-react-btn {
  background-color: var(--bg-primary);
}

.quick-emoji-img {
  width: 20px;
  height: 20px;
  pointer-events: none;
}

.native-emoji {
  font-size: 18px;
  line-height: 1;
  pointer-events: none;
}

.quick-emoji-char {
  font-size: 20px;
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
  padding-bottom: 4px;
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
