<template>
  <div
    ref="scrollContainer"
    class="message-history"
    @scroll="onScroll"
    @touchstart.passive="onTouchStart"
    @touchmove="onTouchMove"
    @touchend.passive="onTouchEnd"
  >
    <!-- Pull-to-refresh indicator (mobile) -->
    <div
      v-if="hasCursor"
      class="ptr-wrap"
      :style="{ height: `${pullY}px` }"
      aria-hidden="true"
    >
      <div class="ptr-inner" :class="{ triggered: pullTriggered }">
        <AppIcon :path="pullTriggered ? mdiRefresh : mdiArrowDown" :size="20" />
      </div>
    </div>

    <!-- Top sentinel: triggers loading older messages -->
    <div ref="topSentinel" class="top-sentinel" />

    <div
      class="virtual-list-inner"
      :style="{ height: `${virtualizer.getTotalSize()}px`, position: 'relative' }"
    >
      <div
        v-for="vRow in virtualizer.getVirtualItems()"
        :key="vRow.index"
        :ref="(el) => { if (el) virtualizer.measureElement(el as Element) }"
        :data-index="vRow.index"
        class="virtual-row"
        :style="{ transform: `translateY(${vRow.start}px)` }"
      >
        <MessageBubble
          v-if="allMessages[vRow.index]"
          :message="allMessages[vRow.index]"
          :show-header="shouldShowHeader(vRow.index)"
          :highlighted="highlightedId === allMessages[vRow.index]?.id"
        />
      </div>
    </div>

    <TypingIndicator :channel-id="channelId" />

    <!-- Bottom sentinel: triggers loading newer messages when in historical view -->
    <div ref="bottomSentinel" class="bottom-sentinel" />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, nextTick } from 'vue'
import { mdiArrowDown, mdiRefresh } from '@mdi/js'
import { useVirtualizer } from '@tanstack/vue-virtual'
import { useMessagesStore } from '@/stores/messagesStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { usePersonalBlocksStore } from '@/stores/personalBlocksStore'
import MessageBubble from './MessageBubble.vue'
import TypingIndicator from './TypingIndicator.vue'

const props = defineProps<{ channelId: string; scrollToId?: string | null }>()

const messagesStore      = useMessagesStore()
const settingsStore      = useSettingsStore()
const personalBlocksStore = usePersonalBlocksStore()
const scrollContainer = ref<HTMLElement | null>(null)
const topSentinel     = ref<HTMLElement | null>(null)
const bottomSentinel  = ref<HTMLElement | null>(null)
const atBottom        = ref(true)
const highlightedId   = ref<string | null>(null)
let highlightTimer: ReturnType<typeof setTimeout> | null = null

// ── Pull-to-refresh (mobile) ──────────────────────────────────────────────────

const PULL_THRESHOLD = 70  // px needed to trigger a load
const pullY         = ref(0)
const pulling       = ref(false)
const pullTriggered = ref(false)
let touchStartY = 0

const hasCursor = computed(() => !!messagesStore.cursors[props.channelId])

function onTouchStart(e: TouchEvent) {
  const el = scrollContainer.value
  if (!el || el.scrollTop > 2 || !hasCursor.value) return
  touchStartY = e.touches[0].clientY
  pulling.value = true
  pullTriggered.value = false
}

function onTouchMove(e: TouchEvent) {
  if (!pulling.value) return
  const el = scrollContainer.value
  if (!el || el.scrollTop > 2) { pulling.value = false; pullY.value = 0; return }
  const delta = e.touches[0].clientY - touchStartY
  if (delta <= 0) { pulling.value = false; pullY.value = 0; return }
  // Rubber-band: slow down with sqrt damping
  pullY.value = Math.min(Math.sqrt(delta) * 7, PULL_THRESHOLD + 20)
  pullTriggered.value = pullY.value >= PULL_THRESHOLD
  // Prevent default to avoid browser-native overscroll competing with our indicator
  if (delta > 8) e.preventDefault()
}

function onTouchEnd() {
  if (pulling.value && pullTriggered.value) {
    const cursor = messagesStore.cursors[props.channelId]
    if (cursor) messagesStore.loadMessages(props.channelId, cursor)
  }
  pulling.value = false
  pullY.value = 0
  pullTriggered.value = false
}

const allMessages = computed(() => {
  const confirmed = messagesStore.getMessagesWithMutations(props.channelId)
  const pending   = messagesStore.pendingMessages[props.channelId] ?? []
  const showDeleted = settingsStore.settings.showDeletedMessagePlaceholder
  const filtered = showDeleted ? confirmed : confirmed.filter(m => m.content !== null)
  const unblocked = filtered.filter(m => !personalBlocksStore.isBlocked(m.authorId))
  return [...unblocked, ...pending]
})

const virtualizer = useVirtualizer(computed(() => ({
  count:            allMessages.value.length,
  getScrollElement: () => scrollContainer.value,
  estimateSize:     () => 60,
  overscan:         5,
})))

// Only auto-scroll to bottom when at the latest window (not inside a historical jump)
watch(() => allMessages.value.length, async () => {
  if (atBottom.value && !messagesStore.hasNewerMessages[props.channelId]) {
    await nextTick()
    scrollToBottom()
  }
})

function scrollToBottom() {
  const count = allMessages.value.length
  if (count > 0) virtualizer.value.scrollToIndex(count - 1, { align: 'end' })
}

function scrollToMessageId(id: string) {
  const idx = allMessages.value.findIndex(m => m.id === id)
  if (idx === -1) return
  atBottom.value = false
  virtualizer.value.scrollToIndex(idx, { align: 'center' })
  // Flash highlight
  if (highlightTimer) clearTimeout(highlightTimer)
  highlightedId.value = id
  highlightTimer = setTimeout(() => { highlightedId.value = null }, 2000)
}

defineExpose({ scrollToMessageId })

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
  // Top sentinel: load older messages on scroll-up
  if (topSentinel.value) {
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) {
        const cursor = messagesStore.cursors[props.channelId]
        if (cursor) messagesStore.loadMessages(props.channelId, cursor)
      }
    }, { threshold: 0.1 })
    observer.observe(topSentinel.value)
  }

  // Bottom sentinel: load newer messages when in a historical view
  if (bottomSentinel.value) {
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting && messagesStore.hasNewerMessages[props.channelId]) {
        messagesStore.loadNewerMessages(props.channelId)
      }
    }, { threshold: 0.1 })
    observer.observe(bottomSentinel.value)
  }

  if (props.scrollToId) {
    nextTick(() => scrollToMessageId(props.scrollToId!))
  } else {
    nextTick(scrollToBottom)
  }
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

/* ── Pull-to-refresh indicator ────────────────────────────────────────────── */
.ptr-wrap {
  overflow: hidden;
  display: flex;
  align-items: flex-end;
  justify-content: center;
  padding-bottom: 4px;
  min-height: 0;
}

.ptr-inner {
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-secondary);
  transition: color 0.15s;
}

.ptr-inner.triggered {
  color: var(--accent-color);
}

.bottom-sentinel {
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
