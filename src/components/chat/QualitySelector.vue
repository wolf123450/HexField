<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import { mdiCogOutline } from '@mdi/js'

defineProps<{
  currentTier: 'low' | 'high'
}>()

const emit = defineEmits<{
  'quality-change': [tier: 'low' | 'high']
}>()

const menuOpen = ref(false)
const selectorRef = ref<HTMLElement>()

function toggleMenu() {
  menuOpen.value = !menuOpen.value
}

function selectTier(tier: 'low' | 'high') {
  emit('quality-change', tier)
  menuOpen.value = false
}

function handleClickOutside(e: MouseEvent) {
  if (selectorRef.value && !selectorRef.value.contains(e.target as Node)) {
    menuOpen.value = false
  }
}

onMounted(() => document.addEventListener('click', handleClickOutside))
onUnmounted(() => document.removeEventListener('click', handleClickOutside))
</script>

<template>
  <div ref="selectorRef" class="quality-selector" @click.stop>
    <button
      class="gear-btn"
      :title="'Quality: ' + (currentTier === 'high' ? '1080p' : '720p')"
      @click="toggleMenu"
    >
      <AppIcon :path="mdiCogOutline" :size="18" />
    </button>

    <div v-if="menuOpen" class="quality-menu">
      <button
        class="quality-option"
        :class="{ active: currentTier === 'high' }"
        @click="selectTier('high')"
      >
        1080p
      </button>
      <button
        class="quality-option"
        :class="{ active: currentTier === 'low' }"
        @click="selectTier('low')"
      >
        720p
      </button>
    </div>
  </div>
</template>

<style scoped>
.quality-selector {
  position: absolute;
  bottom: 8px;
  right: 8px;
  z-index: 10;
}

.gear-btn {
  padding: 0;
  transform: none;
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.6);
  border: none;
  border-radius: 4px;
  color: var(--text-primary);
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.15s;
}

.video-tile:hover .gear-btn {
  opacity: 1;
}

.quality-menu {
  position: absolute;
  bottom: 100%;
  right: 0;
  margin-bottom: 4px;
  background: var(--bg-tertiary);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  padding: 4px;
  min-width: 80px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
}

.quality-option {
  display: block;
  width: 100%;
  padding: 6px 12px;
  transform: none;
  background: none;
  border: none;
  color: var(--text-primary);
  font-size: 13px;
  text-align: left;
  cursor: pointer;
  border-radius: 4px;
}

.quality-option:hover {
  background: var(--bg-hover);
}

.quality-option.active {
  color: var(--accent-color);
  font-weight: 600;
}

.quality-option.active::before {
  content: '●';
  margin-right: 6px;
  font-size: 8px;
}
</style>
