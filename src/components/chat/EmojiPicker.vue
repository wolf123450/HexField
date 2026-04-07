<template>
  <Teleport to="body">
    <div
      v-if="isOpen"
      ref="pickerEl"
      class="emoji-picker"
      :style="positionStyle"
      @keydown.esc="close"
    >
      <div class="picker-search">
        <input
          ref="searchInput"
          v-model="searchQuery"
          class="picker-search-input"
          placeholder="Search emoji…"
          autocomplete="off"
          @keydown.stop
        />
      </div>

      <div class="picker-tabs">
        <button
          v-for="tab in tabs"
          :key="tab.id"
          class="picker-tab"
          :class="{ active: activeTab === tab.id }"
          :title="tab.label"
          @click="activeTab = tab.id"
        >
          <AppIcon :path="tab.icon" :size="16" />
        </button>
      </div>

      <div class="picker-grid-container">
        <template v-if="searchQuery">
          <div class="picker-section-label">Search results</div>
          <div class="picker-grid">
            <button
              v-for="emoji in searchResults"
              :key="emoji.id"
              class="emoji-btn"
              :title="emoji.name"
              @click="selectEmoji(emoji)"
            >
              <span class="native-emoji">{{ emoji.char }}</span>
            </button>
            <div v-if="searchResults.length === 0" class="picker-empty">No results</div>
          </div>
        </template>

        <template v-else-if="activeTab === 'recent'">
          <div class="picker-section-label">Recently used</div>
          <div class="picker-grid">
            <template v-for="id in recentEmoji" :key="id">
              <button
                v-if="isCustomEmojiId(id)"
                class="emoji-btn"
                :title="customEmojiName(id)"
                @click="selectCustomEmoji(id)"
              >
                <img
                  v-if="emojiStore.imageCache[id]"
                  :src="emojiStore.imageCache[id]"
                  class="ce-img"
                  :alt="customEmojiName(id)"
                />
                <span v-else>?</span>
              </button>
              <button
                v-else
                class="emoji-btn"
                :title="unicodeName(id)"
                @click="selectUnicodeById(id)"
            >
              <span class="native-emoji">{{ unicodeChar(id) }}</span>
            </button>
            </template>
            <div v-if="recentEmoji.length === 0" class="picker-empty">No recent emoji</div>
          </div>
        </template>

        <template v-else-if="activeTab.startsWith('server:')">
          <div class="picker-section-label">{{ serverTabLabel(activeTab) }}</div>
          <div class="picker-grid">
            <button
              v-for="emoji in serverEmojiList(activeTab)"
              :key="emoji.id"
              class="emoji-btn"
              :title="`:${emoji.name}:`"
              @click="selectCustomEmoji(emoji.id)"
            >
              <img
                v-if="emojiStore.imageCache[emoji.id]"
                :src="emojiStore.imageCache[emoji.id]"
                class="ce-img"
                :alt="emoji.name"
              />
              <span v-else>?</span>
            </button>
          </div>
        </template>

        <template v-else>
          <div v-for="category in activeCategories" :key="category">
            <div class="picker-section-label">{{ categoryLabel(category) }}</div>
            <div class="picker-grid">
              <button
                v-for="emoji in emojiByCategory(category)"
                :key="emoji.id"
                class="emoji-btn"
                :title="emoji.name"
                @click="selectEmoji(emoji)"
              >
                <span class="native-emoji">{{ emoji.char }}</span>
              </button>
            </div>
          </div>
        </template>
      </div>
    </div>
    <div v-if="isOpen" class="picker-backdrop" @click="close" @contextmenu.prevent="close" />
  </Teleport>
</template>

<script setup lang="ts">
import { ref, computed, nextTick } from 'vue'
import {
  mdiClockOutline, mdiEmoticonHappyOutline, mdiLeaf, mdiFood,
  mdiRun, mdiAirplane, mdiLightbulbOutline, mdiHeartOutline, mdiServerOutline,
} from '@mdi/js'
import { useEmojiStore } from '@/stores/emojiStore'
import { useServersStore } from '@/stores/serversStore'
import emojiData from '@/assets/emoji-data.json'

type EmojiEntry = { id: string; char: string; name: string; category: string }

const props = defineProps<{
  messageId: string
  channelId: string
  serverId:  string
  anchorX?:  number
  anchorY?:  number
}>()

const emit = defineEmits<{
  'select':       [emojiId: string]
  'close':        []
}>()

const isOpen      = ref(false)
const searchQuery = ref('')
const activeTab   = ref('recent')
const pickerEl    = ref<HTMLDivElement | null>(null)
const searchInput = ref<HTMLInputElement | null>(null)

const emojiStore   = useEmojiStore()
const serversStore = useServersStore()

// ── Positioning ───────────────────────────────────────────────────────────────

const positionStyle = computed(() => {
  const x = props.anchorX ?? 0
  const y = props.anchorY ?? 0
  const PICKER_W = 304
  const PICKER_H = 360
  const vw = window.innerWidth
  const vh = window.innerHeight
  const left = Math.min(x, vw - PICKER_W - 8)
  const top  = y + PICKER_H > vh ? y - PICKER_H - 4 : y + 4
  return { left: `${left}px`, top: `${top}px` }
})

// ── Tabs ──────────────────────────────────────────────────────────────────────

const UNICODE_CATEGORIES = ['people', 'nature', 'food', 'activities', 'travel', 'objects', 'symbols'] as const
const CATEGORY_ICONS: Record<string, string> = {
  people: mdiEmoticonHappyOutline,
  nature: mdiLeaf,
  food: mdiFood,
  activities: mdiRun,
  travel: mdiAirplane,
  objects: mdiLightbulbOutline,
  symbols: mdiHeartOutline,
}
const CATEGORY_LABELS: Record<string, string> = {
  people: 'People', nature: 'Nature', food: 'Food & Drink', activities: 'Activities',
  travel: 'Travel & Places', objects: 'Objects', symbols: 'Symbols',
}

const tabs = computed(() => {
  const base = [{ id: 'recent', label: 'Recent', icon: mdiClockOutline }]
  const serverIds = Object.keys(emojiStore.custom).filter(sid => Object.keys(emojiStore.custom[sid]).length > 0)
  for (const sid of serverIds) {
    const server = serversStore.servers[sid]
    base.push({ id: `server:${sid}`, label: server?.name ?? sid, icon: mdiServerOutline })
  }
  for (const cat of UNICODE_CATEGORIES) {
    base.push({ id: `unicode:${cat}`, label: CATEGORY_LABELS[cat], icon: CATEGORY_ICONS[cat] })
  }
  return base
})

const activeCategories = computed<string[]>(() => {
  if (!activeTab.value.startsWith('unicode:')) return []
  return [activeTab.value.replace('unicode:', '')]
})

// ── Data ──────────────────────────────────────────────────────────────────────

const unicodeIndex = computed<Record<string, EmojiEntry>>(() => {
  const m: Record<string, EmojiEntry> = {}
  for (const e of emojiData) m[e.id] = e as EmojiEntry
  return m
})

const recentEmoji = computed(() => emojiStore.recent)

function isCustomEmojiId(id: string): boolean { return id.length > 20 }
function unicodeChar(id: string): string { return unicodeIndex.value[id]?.char ?? id }
function unicodeName(id: string): string { return unicodeIndex.value[id]?.name ?? id }
function customEmojiName(id: string): string {
  for (const se of Object.values(emojiStore.custom)) {
    if (se[id]) return `:${se[id].name}:`
  }
  return id
}
function emojiByCategory(category: string): EmojiEntry[] {
  return (emojiData as EmojiEntry[]).filter(e => e.category === category)
}
function categoryLabel(category: string): string { return CATEGORY_LABELS[category] ?? category }
function serverTabLabel(tabId: string): string {
  const sid = tabId.replace('server:', '')
  return serversStore.servers[sid]?.name ?? sid
}
function serverEmojiList(tabId: string) {
  const sid = tabId.replace('server:', '')
  return Object.values(emojiStore.custom[sid] ?? {})
}

const searchResults = computed<EmojiEntry[]>(() => {
  if (!searchQuery.value) return []
  const q = searchQuery.value.toLowerCase().replace(/:/g, '')
  return (emojiData as EmojiEntry[]).filter(e =>
    e.name.includes(q) || e.char === q
  ).slice(0, 48)
})

// ── Selection ─────────────────────────────────────────────────────────────────

function selectEmoji(emoji: EmojiEntry) {
  emojiStore.useEmoji(emoji.id)
  emit('select', emoji.id)
  close()
}

function selectUnicodeById(id: string) {
  const entry = unicodeIndex.value[id]
  if (entry) selectEmoji(entry)
}

async function selectCustomEmoji(emojiId: string) {
  if (!emojiStore.imageCache[emojiId]) {
    for (const sid of Object.keys(emojiStore.custom)) {
      if (emojiStore.custom[sid][emojiId]) {
        await emojiStore.getEmojiImage(emojiId, sid)
        break
      }
    }
  }
  emojiStore.useEmoji(emojiId)
  emit('select', emojiId)
  close()
}

// ── Open / close ──────────────────────────────────────────────────────────────

function open() {
  isOpen.value = true
  searchQuery.value = ''
  activeTab.value = 'recent'
  nextTick(() => searchInput.value?.focus())
}

function close() {
  isOpen.value = false
  emit('close')
}

defineExpose({ open, close, isOpen })
</script>

<style scoped>
.picker-backdrop {
  position: fixed;
  inset: 0;
  z-index: 9998;
}

.emoji-picker {
  position: fixed;
  z-index: 9999;
  width: 304px;
  height: 360px;
  display: flex;
  flex-direction: column;
  background: var(--bg-primary);
  border: 1px solid rgba(255,255,255,0.1);
  border-radius: 8px;
  box-shadow: 0 8px 32px rgba(0,0,0,0.4);
  overflow: hidden;
}

.picker-search {
  padding: 8px;
  border-bottom: 1px solid rgba(255,255,255,0.06);
}

.picker-search-input {
  width: 100%;
  box-sizing: border-box;
  padding: 6px 10px;
  background: var(--bg-secondary);
  border: 1px solid rgba(255,255,255,0.08);
  border-radius: 6px;
  color: var(--text-primary);
  font-size: 13px;
  outline: none;
}

.picker-search-input::placeholder {
  color: var(--text-tertiary);
}

.picker-tabs {
  display: flex;
  overflow-x: auto;
  scrollbar-width: none;
  border-bottom: 1px solid rgba(255,255,255,0.06);
  padding: 0 4px;
  gap: 2px;
  flex-shrink: 0;
}

.picker-tabs::-webkit-scrollbar { display: none; }

.picker-tab {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  padding: 0;
  background: none;
  border: none;
  cursor: pointer;
  color: var(--text-tertiary);
  border-radius: 4px;
  transition: color 0.1s, background 0.1s;
  transform: none;
}

.picker-tab:hover { background: var(--bg-secondary); color: var(--text-secondary); transform: none; }
.picker-tab.active { color: var(--text-primary); background: var(--bg-secondary); transform: none; }

.picker-grid-container {
  flex: 1;
  overflow-y: auto;
  padding: 4px 8px 8px;
  scrollbar-width: thin;
}

.picker-section-label {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-tertiary);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  padding: 8px 0 4px;
}

.picker-grid {
  display: grid;
  grid-template-columns: repeat(8, 1fr);
  gap: 2px;
}

.emoji-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border: none;
  background: none;
  cursor: pointer;
  border-radius: 4px;
  font-size: 18px;
  line-height: 1;
  transition: background 0.1s;
}

.emoji-btn:hover { background: var(--bg-secondary); }

.native-emoji {
  font-size: 20px;
  line-height: 1;
  pointer-events: none;
}

.ce-img {
  width: 20px;
  height: 20px;
  object-fit: contain;
}

.picker-empty {
  grid-column: 1 / -1;
  padding: 16px 0;
  text-align: center;
  color: var(--text-tertiary);
  font-size: 13px;
}
</style>
