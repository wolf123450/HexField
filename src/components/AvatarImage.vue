<template>
  <!--
    AvatarImage — shows an uploaded avatar image (static or animated GIF)
    or falls back to an initials circle.

    GIF animation is paused by default and plays on hover (or always when
    `animate` is true, e.g. inside the profile edit modal).
  -->
  <div
    class="avatar-image"
    :style="{ width: size + 'px', height: size + 'px', fontSize: Math.round(size * 0.38) + 'px' }"
  >
    <img
      v-if="resolvedSrc"
      :src="displaySrc"
      :alt="name"
      class="avatar-img"
      draggable="false"
      @mouseenter="gifPlaying = true"
      @mouseleave="gifPlaying = false"
    />
    <span v-else class="avatar-initials">{{ initials }}</span>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'

const props = withDefaults(defineProps<{
  /** base64 data URL or remote URL; null/undefined shows initials */
  src?: string | null
  /** display name — used to compute initials and alt text */
  name?: string
  /** pixel size for the circle */
  size?: number
  /** force animation to always play (e.g. in profile modal) */
  animate?: boolean
}>(), {
  src: null,
  name: '',
  size: 32,
  animate: false,
})

const resolvedSrc = computed(() => props.src || null)
const isGif = computed(() => resolvedSrc.value?.startsWith('data:image/gif') ?? false)
const gifPlaying = ref(props.animate)

watch(() => props.animate, v => { gifPlaying.value = v })

/**
 * For GIFs: swap between the real src (animated) and a 1×1 transparent pixel
 * (frozen) to control playback — CSS animation-play-state doesn't work on GIFs.
 */
const BLANK = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'
const displaySrc = computed(() => {
  if (!resolvedSrc.value) return ''
  if (isGif.value && !gifPlaying.value && !props.animate) return BLANK
  return resolvedSrc.value
})

const initials = computed(() => {
  const n = props.name?.trim() || '?'
  return n.split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase()
})
</script>

<style scoped>
.avatar-image {
  border-radius: 50%;
  background: var(--accent-color);
  color: white;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  overflow: hidden;
  font-weight: 700;
  user-select: none;
}

.avatar-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
  border-radius: 50%;
}

.avatar-initials {
  line-height: 1;
}
</style>
