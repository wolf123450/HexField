<template>
  <div class="message-input-wrap">
    <form class="message-form" @submit.prevent="submit">
      <div class="input-area">
        <textarea
          ref="inputRef"
          v-model="draft"
          class="message-textarea"
          :placeholder="`Message #${channelName}`"
          rows="1"
          @keydown.enter.exact.prevent="submit"
          @keydown.enter.shift.exact="draft += '\n'"
          @input="autoResize"
        />
        <button type="submit" class="send-btn" :disabled="!canSend" title="Send message">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
            <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/>
          </svg>
        </button>
      </div>
    </form>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import { useMessagesStore } from '@/stores/messagesStore'
import { useChannelsStore } from '@/stores/channelsStore'

const props = defineProps<{
  channelId: string
  serverId:  string
}>()

const messagesStore = useMessagesStore()
const channelsStore = useChannelsStore()
const inputRef      = ref<HTMLTextAreaElement | null>(null)
const draft         = ref('')

const canSend = computed(() => draft.value.trim().length > 0)

const channelName = computed(() => {
  for (const list of Object.values(channelsStore.channels)) {
    const ch = list.find(c => c.id === props.channelId)
    if (ch) return ch.name
  }
  return props.channelId
})

async function submit() {
  const content = draft.value.trim()
  if (!content) return
  draft.value = ''
  autoResize()
  await messagesStore.sendMessage(props.channelId, props.serverId, content)
}

function autoResize() {
  const el = inputRef.value
  if (!el) return
  el.style.height = 'auto'
  el.style.height = Math.min(el.scrollHeight, 200) + 'px'
}
</script>

<style scoped>
.message-input-wrap {
  flex-shrink: 0;
  padding: var(--spacing-sm) var(--spacing-md) var(--spacing-md);
  border-top: 1px solid var(--border-color);
}

.message-form {
  width: 100%;
}

.input-area {
  display: flex;
  align-items: flex-end;
  gap: var(--spacing-sm);
  background: var(--bg-tertiary);
  border-radius: 8px;
  padding: var(--spacing-sm) var(--spacing-sm);
  border: 1px solid var(--border-color);
  transition: border-color 0.15s ease;
}

.input-area:focus-within {
  border-color: var(--accent-color);
}

.message-textarea {
  flex: 1;
  background: none;
  border: none;
  outline: none;
  resize: none;
  font-family: inherit;
  font-size: 14px;
  line-height: 1.5;
  color: var(--text-primary);
  min-height: 22px;
  max-height: 200px;
  overflow-y: auto;
  padding: 0;
}

.message-textarea::placeholder {
  color: var(--text-tertiary);
}

.send-btn {
  background: var(--accent-color);
  border: none;
  border-radius: 4px;
  color: white;
  padding: 4px 8px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  transition: opacity 0.15s ease;
}

.send-btn:disabled {
  opacity: 0.4;
  cursor: default;
}

.send-btn:not(:disabled):hover {
  opacity: 0.85;
}
</style>
