<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import { useUIStore } from '@/stores/uiStore'
import { mdiMonitor, mdiApplicationOutline, mdiClose } from '@mdi/js'

interface ScreenSource {
  id: string
  name: string
  width: number
  height: number
  source_type: string
  thumbnail: string | null
}

interface ScreenSourceList {
  monitors: ScreenSource[]
  windows: ScreenSource[]
}

const uiStore = useUIStore()
const sources = ref<ScreenSourceList>({ monitors: [], windows: [] })
const loading = ref(true)
const activeTab = ref<'monitors' | 'windows'>('monitors')

onMounted(async () => {
  try {
    sources.value = await invoke<ScreenSourceList>('media_enumerate_screens')
  } catch (e) {
    console.error('[SourcePicker] enumerate failed:', e)
  } finally {
    loading.value = false
  }
})

function select(sourceId: string) {
  uiStore.closeSourcePicker(sourceId)
}

function cancel() {
  uiStore.closeSourcePicker(null)
}
</script>

<template>
  <Teleport to="body">
    <div class="modal-backdrop" @click.self="cancel">
      <div class="source-picker">
        <div class="picker-header">
          <h2>Share Your Screen</h2>
          <button class="close-btn" @click="cancel">
            <AppIcon :path="mdiClose" :size="20" />
          </button>
        </div>

        <div class="tab-bar">
          <button
            :class="{ active: activeTab === 'monitors' }"
            @click="activeTab = 'monitors'"
          >
            <AppIcon :path="mdiMonitor" :size="16" />
            Screens ({{ sources.monitors.length }})
          </button>
          <button
            :class="{ active: activeTab === 'windows' }"
            @click="activeTab = 'windows'"
          >
            <AppIcon :path="mdiApplicationOutline" :size="16" />
            Windows ({{ sources.windows.length }})
          </button>
        </div>

        <div v-if="loading" class="loading">Detecting sources…</div>

        <div v-else class="source-grid">
          <div
            v-for="src in (activeTab === 'monitors' ? sources.monitors : sources.windows)"
            :key="src.id"
            class="source-card"
            @click="select(src.id)"
          >
            <div class="thumb-wrapper">
              <img
                v-if="src.thumbnail"
                :src="'data:image/jpeg;base64,' + src.thumbnail"
                :alt="src.name"
                class="thumb"
              />
              <div v-else class="thumb placeholder">
                <AppIcon :path="activeTab === 'monitors' ? mdiMonitor : mdiApplicationOutline" :size="48" />
              </div>
            </div>
            <div class="source-label">{{ src.name }}</div>
            <div class="source-dims">{{ src.width }}×{{ src.height }}</div>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.modal-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.source-picker {
  background: var(--bg-secondary);
  border-radius: var(--radius-lg);
  width: min(800px, 90vw);
  max-height: 80vh;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.picker-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--spacing-md) var(--spacing-lg);
  border-bottom: 1px solid var(--border-color);
}

.picker-header h2 {
  margin: 0;
  font-size: 1.1rem;
  color: var(--text-primary);
}

.close-btn {
  padding: 0;
  transform: none;
  background: none;
  border: none;
  color: var(--text-secondary);
  cursor: pointer;
}

.tab-bar {
  display: flex;
  gap: var(--spacing-xs);
  padding: var(--spacing-sm) var(--spacing-lg);
  border-bottom: 1px solid var(--border-color);
}

.tab-bar button {
  display: flex;
  align-items: center;
  gap: var(--spacing-xs);
  padding: var(--spacing-xs) var(--spacing-sm);
  transform: none;
  background: none;
  border: none;
  border-radius: var(--radius-sm);
  color: var(--text-secondary);
  cursor: pointer;
  font-size: 0.875rem;
}

.tab-bar button.active {
  background: var(--bg-tertiary);
  color: var(--text-primary);
}

.loading {
  padding: var(--spacing-xl);
  text-align: center;
  color: var(--text-secondary);
}

.source-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: var(--spacing-md);
  padding: var(--spacing-lg);
  overflow-y: auto;
}

.source-card {
  cursor: pointer;
  border-radius: var(--radius-md);
  border: 2px solid transparent;
  padding: var(--spacing-sm);
  transition: border-color 0.15s, background 0.15s;
}

.source-card:hover {
  border-color: var(--accent-color);
  background: var(--bg-tertiary);
}

.thumb-wrapper {
  aspect-ratio: 16 / 9;
  border-radius: var(--radius-sm);
  overflow: hidden;
  background: var(--bg-primary);
}

.thumb {
  width: 100%;
  height: 100%;
  object-fit: contain;
}

.thumb.placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-tertiary);
}

.source-label {
  margin-top: var(--spacing-xs);
  font-size: 0.8125rem;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.source-dims {
  font-size: 0.75rem;
  color: var(--text-tertiary);
}
</style>
