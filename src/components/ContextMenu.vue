<template>
  <Teleport to="body">
    <div
      v-if="uiStore.contextMenuVisible"
      ref="menuEl"
      class="context-menu"
      :style="{ left: posX + 'px', top: posY + 'px' }"
      role="menu"
      @click.stop
    >
      <template v-for="(item, i) in uiStore.contextMenuItems" :key="i">
        <hr v-if="item.type === 'separator'" class="context-menu-sep" />
        <div
          v-else-if="item.type === 'disabled'"
          class="context-menu-item context-menu-item--disabled"
          role="presentation"
        >{{ item.label }}</div>
        <button
          v-else
          class="context-menu-item"
          :class="{ 'context-menu-item--danger': item.danger }"
          role="menuitem"
          @click="run(item)"
        >
          <span class="item-label">{{ item.label }}</span>
          <span v-if="item.shortcut" class="item-shortcut">{{ item.shortcut }}</span>
        </button>
      </template>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, watch, nextTick, onMounted, onBeforeUnmount } from 'vue'
import { useUIStore } from '@/stores/uiStore'
import type { MenuItem } from '@/stores/uiStore'

const uiStore = useUIStore()
const menuEl  = ref<HTMLElement | null>(null)
const posX    = ref(0)
const posY    = ref(0)

watch(() => uiStore.contextMenuVisible, async (visible) => {
  if (!visible) return
  posX.value = uiStore.contextMenuX
  posY.value = uiStore.contextMenuY
  await nextTick()
  if (!menuEl.value) return
  const rect = menuEl.value.getBoundingClientRect()
  if (rect.right  > window.innerWidth)  posX.value -= (rect.right  - window.innerWidth  + 4)
  if (rect.bottom > window.innerHeight) posY.value -= (rect.bottom - window.innerHeight + 4)
  menuEl.value.focus()
})

function run(item: Extract<MenuItem, { type: 'action' }>) {
  uiStore.hideContextMenu()
  item.callback()
}

function onKeydown(e: KeyboardEvent) {
  if (!uiStore.contextMenuVisible) return
  if (e.key === 'Escape') { e.stopPropagation(); uiStore.hideContextMenu() }
}

function onPointerdown(e: PointerEvent) {
  if (!uiStore.contextMenuVisible) return
  if (!menuEl.value?.contains(e.target as Node)) uiStore.hideContextMenu()
}

onMounted(() => {
  document.addEventListener('pointerdown', onPointerdown, { capture: true })
  document.addEventListener('keydown',     onKeydown,     { capture: true })
})
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onPointerdown, { capture: true })
  document.removeEventListener('keydown',     onKeydown,     { capture: true })
})
</script>

<style scoped>
.context-menu {
  position: fixed;
  z-index: 1000;
  min-width: 160px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-lg);
  padding: 4px 0;
  outline: none;
}

.context-menu-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 24px;
  width: 100%;
  padding: 6px 14px;
  background: none;
  border: none;
  text-align: left;
  font-size: 13px;
  color: var(--text-primary);
  cursor: pointer;
  white-space: nowrap;
}
.context-menu-item:hover { background: var(--accent-color); color: #fff; }
.context-menu-item--disabled {
  color: var(--text-tertiary);
  cursor: default;
  font-size: 11px;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  padding: 6px 14px 2px;
}
.context-menu-item--disabled:hover { background: none; color: var(--text-tertiary); }
.context-menu-item--danger { color: var(--error-color); }
.context-menu-item--danger:hover { background: var(--error-color); color: #fff; }
.item-shortcut { font-size: 11px; opacity: 0.6; flex-shrink: 0; }
.context-menu-sep { margin: 4px 0; border: none; border-top: 1px solid var(--border-color); }
</style>
