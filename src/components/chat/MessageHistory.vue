<template>
  <div ref="scrollContainer" class="message-history" @scroll="onScroll">
    <!-- Load-more sentinel -->
    <div ref="topSentinel" class="top-sentinel" />

    <div
      class="virtual-list-inner"
      :style="{ height: `${virtualizer.getTotalSize()}px`, position: 'relative' }"
    >
      <div
        v-for="vRow in virtualizer.getVirtualItems()"
        :key="vRow.index"
        :ref="(el) => { if (el) virtualizer.measureElement(el as Element) }"
        class="virtual-row"
        :style="{ transform: `translateY(${vRow.start}px)` }"
      >
        <MessageBubble
          v-if="allMessages[vRow.index]"
          :message="allMessages[vRow.index]"
          :show-header="shouldShowHeader(vRow.index)"
        />
      </div>
    </div>

    <TypingIndicator :channel-id="channelId" />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, nextTick } from 'vue'
import { useVirtualizer } from '@tanstack/vue-virtual'
import { useMessagesStore } from '@/stores/messagesStore'
import MessageBubble from './MessageBubble.vue'
import TypingIndicator from './TypingIndicator.vue'

const props = defineProps<{ channelId: string }>()

const messagesStore   = useMessagesStore()
const scrollContainer = ref<HTMLElement | null>(null)
const topSentinel     = ref<HTMLElement | null>(null)
const atBottom        = ref(true)

const allMessages = computed(() => {
  const confirmed = messagesStore.getMessagesWithMutations(props.channelId)
  const pending   = messagesStore.pendingMessages[props.channelId] ?? []
  return [...confirmed, ...pending]
})

const virtualizer = useVirtualizer(computed(() => ({
  count:            allMessages.value.length,
  getScrollElement: () => scrollContainer.value,
  estimateSize:     () => 60,
  overscan:         5,
})))

// Scroll to bottom when new messages arrive (if user was at bottom)
watch(() => allMessages.value.length, async () => {
  if (atBottom.value) {
    await nextTick()
    scrollToBottom()
  }
})

function scrollToBottom() {
  const count = allMessages.value.length
  if (count > 0) virtualizer.value.scrollToIndex(count - 1, { align: 'end' })
}

function onScroll() {
  const el = scrollContainer.value
  if (!el) return
  atBottom.value = el.scrollHeight - el.scrollTop - el.clientHeight < 60
}

function shouldShowHeader(index: number): boolean {
  if (index === 0) return true
  const prev = allMessages.value[index - 1]
  const curr = allMessages.value[index]
  if (!prev || !curr) return true
  // Group same-author messages within 5 minutes
  const prevTs = new Date(prev.createdAt).getTime()
  const currTs = new Date(curr.createdAt).getTime()
  return prev.authorId !== curr.authorId || (currTs - prevTs) > 5 * 60 * 1000
}

onMounted(() => {
  // IntersectionObserver for load-more on scroll-up
  if (topSentinel.value) {
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) {
        const cursor = messagesStore.cursors[props.channelId]
        if (cursor) messagesStore.loadMessages(props.channelId, cursor)
      }
    }, { threshold: 0.1 })
    observer.observe(topSentinel.value)
  }

  nextTick(scrollToBottom)
})
</script>

<style scoped>
.message-history {
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
  position: relative;
}

.top-sentinel {
  height: 1px;
}

.virtual-list-inner {
  width: 100%;
}

.virtual-row {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  box-sizing: border-box;
}
</style>
