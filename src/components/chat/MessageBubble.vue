<template>
  <div
    class="message-bubble"
    :class="{ 'has-header': showHeader, 'message-highlight': highlighted }"
    @mouseenter="onBubbleEnter"
    @mouseleave="isHovered = false"
  >
    <!-- Hover action bar: quick-react + full picker button + edit/delete -->
    <div v-if="isHovered && message.content !== null && !isEditing" class="message-actions" :class="{ 'actions-below': actionsBelow }">
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
      <template v-if="canEdit || canDelete">
        <div class="actions-divider" />
        <button v-if="canEdit" class="action-btn" title="Edit message" @click.stop="startEdit">
          <AppIcon :path="mdiPencil" :size="18" />
        </button>
        <button v-if="canDelete" class="action-btn action-btn--danger" title="Delete message" @click.stop="handleDelete">
          <AppIcon :path="mdiDelete" :size="18" />
        </button>
      </template>
    </div>

    <template v-if="showHeader">
      <AvatarImage
        :src="authorAvatarSrc"
        :name="authorName"
        :size="36"
        class="message-avatar"
        title="View profile"
        @click="uiStore.openUserProfile(message.authorId, message.serverId)"
      />
      <div class="message-main">
        <div class="message-header">
          <span class="author-name">{{ authorName }}</span>
          <span class="message-time">{{ formattedTime }}</span>
          <span v-if="message.isEdited" class="edited-label">(edited)</span>
        </div>
        <template v-if="isEditing">
          <textarea
            ref="editTextarea"
            v-model="editContent"
            class="edit-textarea"
            @keydown.enter.exact.prevent="confirmEdit"
            @keydown.escape="cancelEdit"
            @input="autoResizeTextarea"
          />
          <div class="edit-actions">
            <span class="edit-hint">Enter to save · Esc to cancel</span>
          </div>
        </template>
        <MessageContent v-else :message="message" />
        <ReactionBar
          v-if="!isEditing && message.reactions.length > 0"
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
        <template v-if="isEditing">
          <textarea
            ref="editTextarea"
            v-model="editContent"
            class="edit-textarea"
            @keydown.enter.exact.prevent="confirmEdit"
            @keydown.escape="cancelEdit"
            @input="autoResizeTextarea"
          />
          <div class="edit-actions">
            <span class="edit-hint">Enter to save · Esc to cancel</span>
          </div>
        </template>
        <MessageContent v-else :message="message" />
        <ReactionBar
          v-if="!isEditing && message.reactions.length > 0"
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
import { computed, ref, nextTick } from 'vue'
import { formatDistanceToNow } from 'date-fns'
import type { Message } from '@/types/core'
import { mdiEmoticonPlus, mdiPencil, mdiDelete } from '@mdi/js'
import { useUIStore } from '@/stores/uiStore'
import { useServersStore } from '@/stores/serversStore'
import { useIdentityStore } from '@/stores/identityStore'
import { useMessagesStore } from '@/stores/messagesStore'
import { useEmojiStore } from '@/stores/emojiStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { codepointToChar } from '@/utils/twemoji'
import MessageContent from './MessageContent.vue'
import ReactionBar from './ReactionBar.vue'
import EmojiPicker from './EmojiPicker.vue'

const props = defineProps<{
  message: Message
  showHeader: boolean
  highlighted?: boolean
}>()

const serversStore  = useServersStore()
const identityStore = useIdentityStore()
const uiStore       = useUIStore()
const messagesStore = useMessagesStore()
const emojiStore    = useEmojiStore()

const isHovered   = ref(false)
const actionsBelow = ref(false)

function onBubbleEnter(e: MouseEvent) {
  isHovered.value = true
  // If the message is within 60px of the top of the viewport the actions bar
  // would be clipped by the scroll container — flip it below the bubble instead.
  actionsBelow.value = (e.currentTarget as HTMLElement).getBoundingClientRect().top < 60
}
const picker    = ref<InstanceType<typeof EmojiPicker> | null>(null)
const pickerX   = ref(0)
const pickerY   = ref(0)

const author = computed(() => {
  const members = serversStore.members[props.message.serverId] ?? {}
  return members[props.message.authorId]
})

const authorAvatarSrc = computed(() => {
  if (props.message.authorId === identityStore.userId) return identityStore.avatarDataUrl ?? null
  return author.value?.avatarDataUrl ?? null
})

const authorName = computed(() => {
  if (props.message.authorId === identityStore.userId) return identityStore.displayName
  return author.value?.displayName ?? props.message.authorId.slice(0, 8)
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

const settingsStore = useSettingsStore()

const isEditing    = ref(false)
const editContent  = ref('')
const editTextarea = ref<HTMLTextAreaElement | null>(null)

const isAdmin = computed(() => {
  const uid = identityStore.userId
  if (!uid) return false
  return serversStore.members[props.message.serverId]?.[uid]?.roles.some(r => r === 'admin' || r === 'owner') ?? false
})

const canEdit   = computed(() => props.message.authorId === identityStore.userId)
const canDelete = computed(() => props.message.authorId === identityStore.userId || isAdmin.value)

async function startEdit() {
  editContent.value = props.message.content ?? ''
  isEditing.value = true
  await nextTick()
  editTextarea.value?.focus()
  autoResizeTextarea()
}

async function confirmEdit() {
  const trimmed = editContent.value.trim()
  if (!trimmed || trimmed === props.message.content) {
    cancelEdit()
    return
  }
  await messagesStore.sendEditMutation(
    props.message.id,
    props.message.channelId,
    props.message.serverId,
    trimmed,
  )
  isEditing.value = false
}

function cancelEdit() {
  isEditing.value = false
  editContent.value = ''
}

async function handleDelete() {
  if (settingsStore.settings.confirmBeforeDelete) {
    if (!window.confirm('Delete this message?')) return
  }
  await messagesStore.sendDeleteMutation(
    props.message.id,
    props.message.channelId,
    props.message.serverId,
  )
}

function autoResizeTextarea() {
  const el = editTextarea.value
  if (!el) return
  el.style.height = 'auto'
  el.style.height = `${el.scrollHeight}px`
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

.message-highlight {
  animation: msg-highlight-fade 2s ease-out forwards;
}

@keyframes msg-highlight-fade {
  0%   { background: rgba(var(--accent-rgb, 88, 101, 242), 0.35); }
  100% { background: transparent; }
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

/* Flip bar below the bubble when hovering near the top of the screen */
.message-actions.actions-below {
  top: auto;
  bottom: -16px;
}

/* Flip bar below the bubble when near the top of the screen */
.message-actions.actions-below {
  top: auto;
  bottom: -16px;
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
  cursor: pointer;
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

.actions-divider {
  width: 1px;
  margin: 4px 2px;
  background: rgba(255, 255, 255, 0.12);
  align-self: stretch;
}

.action-btn--danger:hover {
  color: var(--danger-color, #f04747);
}

.edit-textarea {
  width: 100%;
  min-height: 36px;
  background: var(--bg-tertiary, var(--bg-secondary));
  border: 1px solid var(--accent-color);
  border-radius: 4px;
  color: var(--text-primary);
  font-size: 14px;
  font-family: inherit;
  line-height: 1.5;
  padding: 6px 8px;
  resize: none;
  outline: none;
  box-sizing: border-box;
  overflow: hidden;
}

.edit-actions {
  display: flex;
  justify-content: flex-end;
  margin-top: 2px;
}

.edit-hint {
  font-size: 11px;
  color: var(--text-tertiary);
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
  cursor: pointer;
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
