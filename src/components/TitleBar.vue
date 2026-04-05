<template>
  <div v-if="visible && isDesktop" class="title-bar">
    <div class="title-bar-drag" data-tauri-drag-region>
      <span class="title-bar-name" data-tauri-drag-region>{{ APP_NAME }}</span>
    </div>
    <div class="title-bar-controls">
      <button class="tb-btn" aria-label="Minimize" title="Minimize" @click="minimize">
        <AppIcon :path="mdiWindowMinimize" :size="12" />
      </button>
      <button class="tb-btn" :aria-label="isMaximized ? 'Restore' : 'Maximize'" :title="isMaximized ? 'Restore' : 'Maximize'" @click="toggleMaximize">
        <AppIcon :path="isMaximized ? mdiWindowRestore : mdiWindowMaximize" :size="12" />
      </button>
      <button class="tb-btn tb-close" aria-label="Close" title="Close" @click="closeWindow">
        <AppIcon :path="mdiWindowClose" :size="12" />
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from 'vue'
import {
  mdiWindowMinimize,
  mdiWindowMaximize,
  mdiWindowRestore,
  mdiWindowClose,
} from '@mdi/js'
import { APP_NAME } from '@/appConfig'
import { useBreakpoint } from '@/utils/useBreakpoint'

const { isDesktop } = useBreakpoint()

const visible = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
const isMaximized = ref(false)

let appWindow: import('@tauri-apps/api/window').Window | null = null
let unlistenResize: (() => void) | null = null

onMounted(async () => {
  if (!visible) return
  const { getCurrentWindow } = await import('@tauri-apps/api/window')
  appWindow = getCurrentWindow()
  isMaximized.value = await appWindow.isMaximized()
  unlistenResize = await appWindow.onResized(async () => {
    isMaximized.value = await appWindow!.isMaximized()
  })
})

onBeforeUnmount(() => { unlistenResize?.() })

async function minimize() { await appWindow?.minimize() }
async function toggleMaximize() { await appWindow?.toggleMaximize() }
async function closeWindow() { await appWindow?.close() }
</script>

<style scoped>
.title-bar {
  display: flex;
  align-items: stretch;
  height: var(--titlebar-height, 32px);
  background-color: var(--bg-secondary);
  flex-shrink: 0;
  user-select: none;
  -webkit-user-select: none;
}

.title-bar-drag {
  flex: 1;
  display: flex;
  align-items: center;
  padding-left: 12px;
  cursor: default;
}

.title-bar-name {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-secondary);
  letter-spacing: 0.04em;
  pointer-events: none;
}

.title-bar-controls {
  display: flex;
  align-items: stretch;
  -webkit-app-region: no-drag;
}

.tb-btn {
  width: 46px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: none;
  border: none;
  cursor: pointer;
  color: var(--text-secondary);
  transition: background-color var(--transition-fast), color var(--transition-fast);
}

.tb-btn:hover { background-color: var(--bg-tertiary); color: var(--text-primary); }
.tb-close:hover { background-color: #c42b1c; color: #ffffff; }
</style>
