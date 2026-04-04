<template>
  <main class="main-pane">
    <!-- Voice content pane: only while in voice AND voice view is active -->
    <VoiceContentPane v-if="voiceStore.session && voiceStore.voiceViewActive" />

    <!-- Normal text channel view -->
    <template v-else-if="activeChannel">
      <!-- Voice-active banner: click to return to voice pane -->
      <div v-if="voiceStore.session" class="voice-active-bar" @click="voiceStore.voiceViewActive = true">
        <AppIcon :path="mdiVolumeHigh" :size="14" />
        <span>Connected to <strong>{{ voiceChannelName }}</strong></span>
        <span class="vab-hint">Click to return</span>
      </div>
      <div class="channel-header">
        <span class="channel-hash">#</span>
        <span class="channel-name">{{ activeChannel.name }}</span>
        <span v-if="activeChannel.topic && !searchActive" class="channel-topic">{{ activeChannel.topic }}</span>
        <div class="channel-header-actions">
          <button class="icon-btn" :class="{ active: searchActive }" title="Search messages" @click="toggleSearch">
            <AppIcon :path="mdiMagnify" :size="18" />
          </button>
          <button class="icon-btn" title="Toggle member list" @click="uiStore.memberListOpen = !uiStore.memberListOpen">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
              <path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/>
            </svg>
          </button>
        </div>
      </div>

      <!-- Search overlay -->
      <template v-if="searchActive">
        <div class="search-bar">
          <AppIcon :path="mdiMagnify" :size="16" class="search-icon" />
          <input
            ref="searchInputEl"
            v-model="searchQuery"
            class="search-input"
            placeholder="Search messages in this server…"
            @keydown.escape="closeSearch"
          />
          <label class="search-scope-label">
            <input type="checkbox" v-model="scopeToChannel" />
            This channel only
          </label>
          <button v-if="searchQuery" class="search-clear" @click="searchQuery = ''">
            <AppIcon :path="mdiClose" :size="14" />
          </button>
        </div>
        <div class="search-results" v-if="searchQuery.trim()">
          <div v-if="searching" class="search-state">Searching…</div>
          <div v-else-if="searchResults.length === 0" class="search-state">No results for <em>{{ searchQuery }}</em></div>
          <div
            v-else
            v-for="msg in searchResults"
            :key="msg.id"
            class="search-result-row"
            @click="jumpToResult(msg)"
          >
            <div class="search-result-meta">
              <span class="search-result-channel"># {{ channelName(msg.channel_id) }}</span>
              <span class="search-result-author">{{ authorName(msg.author_id, msg.server_id) }}</span>
              <span class="search-result-ts">{{ formatTs(msg.created_at) }}</span>
            </div>
            <div class="search-result-content" v-html="highlightMatch(msg.content ?? '', searchQuery)" />
          </div>
        </div>
        <div v-else class="search-empty-hint">Type to search messages in this server.</div>
      </template>

      <!-- Normal chat view -->
      <template v-else>
        <MessageHistory ref="messageHistoryRef" :channel-id="activeChannel.id" :scroll-to-id="pendingScrollId" />
        <MessageInput :channel-id="activeChannel.id" :server-id="activeChannel.serverId" />
      </template>
    </template>

    <div v-else class="empty-state">
      <div class="empty-icon">💬</div>
      <div class="empty-title">No channel selected</div>
      <div class="empty-sub">Pick a channel from the sidebar to get started</div>
    </div>
  </main>
</template>

<script setup lang="ts">
import { computed, ref, watch, nextTick } from 'vue'
import { useChannelsStore } from '@/stores/channelsStore'
import { useUIStore } from '@/stores/uiStore'
import { useVoiceStore } from '@/stores/voiceStore'
import { useServersStore } from '@/stores/serversStore'
import { mdiVolumeHigh, mdiMagnify, mdiClose } from '@mdi/js'
import { invoke } from '@tauri-apps/api/core'
import MessageHistory from '@/components/chat/MessageHistory.vue'
import MessageInput from '@/components/chat/MessageInput.vue'
import VoiceContentPane from '@/components/chat/VoiceContentPane.vue'

// Raw Rust row shape — Serde serializes MessageRow with snake_case keys
interface MessageRow {
  id: string
  channel_id: string
  server_id: string
  author_id: string
  content: string | null
  content_type: string
  reply_to_id: string | null
  created_at: string
  logical_ts: string
  verified: boolean
  raw_attachments: string | null
}

const channelsStore = useChannelsStore()
const uiStore       = useUIStore()
const voiceStore    = useVoiceStore()
const serversStore  = useServersStore()

const activeChannel = computed(() => {
  const id = channelsStore.activeChannelId
  if (!id) return null
  for (const list of Object.values(channelsStore.channels)) {
    const ch = list.find(c => c.id === id)
    if (ch) return ch
  }
  return null
})

const voiceChannelName = computed(() => {
  const session = voiceStore.session
  if (!session) return ''
  const list = channelsStore.channels[session.serverId] ?? []
  return list.find(c => c.id === session.channelId)?.name ?? 'voice'
})

// ── Search ────────────────────────────────────────────────────────────────────

const searchActive   = ref(false)
const searchQuery    = ref('')
const scopeToChannel = ref(false)
const searching      = ref(false)
const searchResults  = ref<MessageRow[]>([])
const searchInputEl  = ref<HTMLInputElement | null>(null)
const messageHistoryRef = ref<InstanceType<typeof MessageHistory> | null>(null)
const pendingScrollId   = ref<string | null>(null)

let debounceTimer: ReturnType<typeof setTimeout> | null = null

function toggleSearch() {
  searchActive.value = !searchActive.value
  if (searchActive.value) {
    searchQuery.value = ''
    searchResults.value = []
    nextTick(() => searchInputEl.value?.focus())
  }
}

function closeSearch() {
  searchActive.value = false
  searchQuery.value  = ''
  searchResults.value = []
}

watch([searchQuery, scopeToChannel], ([q]) => {
  if (debounceTimer) clearTimeout(debounceTimer)
  searchResults.value = []
  if (!q.trim() || !activeChannel.value) return
  debounceTimer = setTimeout(runSearch, 300)
})

async function runSearch() {
  const q      = searchQuery.value.trim()
  const ch     = activeChannel.value
  if (!q || !ch) return
  const serverId   = serversStore.activeServerId
  if (!serverId) return

  searching.value = true
  try {
    const rows = await invoke<MessageRow[]>('db_search_messages', {
      serverId,
      query: q,
      channelId: scopeToChannel.value ? ch.id : undefined,
      limit: 50,
    })
    searchResults.value = rows
  } catch {
    searchResults.value = []
  } finally {
    searching.value = false
  }
}

function channelName(channelId: string): string {
  const serverId = serversStore.activeServerId
  if (!serverId) return channelId
  return channelsStore.channels[serverId]?.find(c => c.id === channelId)?.name ?? channelId
}

function authorName(userId: string, serverId: string): string {
  return serversStore.members[serverId]?.[userId]?.displayName ?? userId.slice(0, 8)
}

function formatTs(createdAt: string): string {
  const ms = Number(createdAt)
  if (!isNaN(ms) && ms > 1_000_000_000_000) {
    return new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  }
  return createdAt
}

function highlightMatch(content: string, query: string): string {
  const term = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return content.replace(new RegExp(`(${term})`, 'gi'), '<mark>$1</mark>')
}

async function jumpToResult(msg: MessageRow) {
  const { useMessagesStore } = await import('@/stores/messagesStore')
  const messagesStore = useMessagesStore()

  // Switch channel if needed
  if (msg.channel_id !== channelsStore.activeChannelId) {
    channelsStore.setActiveChannel(msg.channel_id)
  }

  // Load the message window ending at this message (so it's in the rendered list)
  await messagesStore.loadMessagesAround(msg.channel_id, msg.id)
  await messagesStore.loadMutationsForChannel(msg.channel_id)

  // Set pending scroll target, then close search (which mounts MessageHistory)
  pendingScrollId.value = msg.id
  closeSearch()

  // Wait two ticks: (1) MessageHistory mounts, (2) virtualizer renders items
  await nextTick()
  await nextTick()
  messageHistoryRef.value?.scrollToMessageId(msg.id)

  // Clear so subsequent loadMessages/scroll-to-bottom works normally
  pendingScrollId.value = null
}
</script>

<style scoped>
.main-pane {
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--bg-primary);
  min-width: 0;
}

.voice-active-bar {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  padding: 0 var(--spacing-md);
  height: 32px;
  background: rgba(59,165,93,0.15);
  border-bottom: 1px solid rgba(59,165,93,0.3);
  font-size: 13px;
  color: #3ba55d;
  cursor: pointer;
  flex-shrink: 0;
  transition: background 0.15s;
}
.voice-active-bar:hover { background: rgba(59,165,93,0.25); }
.vab-hint {
  margin-left: auto;
  font-size: 11px;
  opacity: 0.7;
}

.channel-header {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  padding: 0 var(--spacing-md);
  height: 48px;
  border-bottom: 1px solid var(--border-color);
  flex-shrink: 0;
}

.channel-hash {
  color: var(--text-tertiary);
  font-size: 20px;
  flex-shrink: 0;
}

.channel-name {
  font-weight: 600;
  font-size: 15px;
  color: var(--text-primary);
}

.channel-topic {
  font-size: 13px;
  color: var(--text-tertiary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  margin-left: var(--spacing-sm);
  padding-left: var(--spacing-sm);
  border-left: 1px solid var(--border-color);
}

.channel-header-actions {
  margin-left: auto;
  display: flex;
  gap: var(--spacing-xs);
}

.icon-btn {
  background: none;
  border: none;
  cursor: pointer;
  color: var(--text-secondary);
  padding: 4px;
  border-radius: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
  transform: none;
}

.icon-btn:hover {
  background: var(--bg-secondary);
  color: var(--text-primary);
}

.icon-btn.active {
  color: var(--accent-color);
  background: var(--bg-secondary);
}

/* ── Search ────────────────────────────────────────────────────────────── */

.search-bar {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  padding: var(--spacing-sm) var(--spacing-md);
  border-bottom: 1px solid var(--border-color);
  flex-shrink: 0;
  background: var(--bg-secondary);
}

.search-icon {
  color: var(--text-tertiary);
  flex-shrink: 0;
}

.search-input {
  flex: 1;
  background: none;
  border: none;
  outline: none;
  font-size: 14px;
  color: var(--text-primary);
  min-width: 0;
}

.search-input::placeholder { color: var(--text-tertiary); }

.search-scope-label {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: var(--text-secondary);
  white-space: nowrap;
  cursor: pointer;
  user-select: none;
}

.search-clear {
  background: none;
  border: none;
  cursor: pointer;
  color: var(--text-tertiary);
  padding: 2px;
  border-radius: 4px;
  display: flex;
  align-items: center;
  transform: none;
}
.search-clear:hover { color: var(--text-primary); }

.search-results {
  flex: 1;
  overflow-y: auto;
  padding: var(--spacing-sm) 0;
}

.search-state {
  padding: var(--spacing-md) var(--spacing-lg);
  font-size: 14px;
  color: var(--text-tertiary);
}

.search-empty-hint {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
  color: var(--text-tertiary);
}

.search-result-row {
  padding: var(--spacing-sm) var(--spacing-md);
  cursor: pointer;
  border-bottom: 1px solid var(--border-color);
}

.search-result-row:hover {
  background: var(--bg-secondary);
}

.search-result-meta {
  display: flex;
  gap: var(--spacing-sm);
  align-items: center;
  margin-bottom: 4px;
  font-size: 12px;
}

.search-result-channel {
  color: var(--accent-color);
  font-weight: 600;
}

.search-result-author {
  color: var(--text-secondary);
  font-weight: 500;
}

.search-result-ts {
  color: var(--text-tertiary);
  margin-left: auto;
}

.search-result-content {
  font-size: 13px;
  color: var(--text-primary);
  line-height: 1.4;
  white-space: pre-wrap;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
}

.search-result-content :deep(mark) {
  background: rgba(250, 166, 26, 0.35);
  color: var(--text-primary);
  border-radius: 2px;
  padding: 0 1px;
}

.empty-state {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--spacing-md);
  color: var(--text-tertiary);
}

.empty-icon {
  font-size: 48px;
}

.empty-title {
  font-size: 18px;
  font-weight: 600;
  color: var(--text-secondary);
}

.empty-sub {
  font-size: 14px;
}
</style>
