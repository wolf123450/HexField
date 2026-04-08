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
import { resolveImageHash } from '@/utils/imageCache'

const props = withDefaults(defineProps<{
  /** base64 data URL or remote URL; null/undefined shows initials */
  src?: string | null
  /** BLAKE3 content hash — resolved via imageCache */
  hash?: string | null
  /** display name — used to compute initials and alt text */
  name?: string
  /** pixel size for the circle */
  size?: number
  /** force animation to always play (e.g. in profile modal) */
  animate?: boolean
}>(), {
  src: null,
  hash: null,
  name: '',
  size: 32,
  animate: false,
})

const hashResolvedSrc = ref<string | null>(null)

watch(() => props.hash, async (newHash) => {
  if (newHash) {
    hashResolvedSrc.value = await resolveImageHash(newHash)
  } else {
    hashResolvedSrc.value = null
  }
}, { immediate: true })

const resolvedSrc = computed(() => hashResolvedSrc.value || props.src || null)
const isGif = computed(() => resolvedSrc.value?.startsWith('data:image/gif') ?? false)
const gifPlaying = ref(props.animate)

watch(() => props.animate, v => { gifPlaying.value = v })

// Capture the first frame of a GIF as a static PNG so the non-hover state
// shows a meaningful thumbnail instead of a transparent/coloured placeholder.
const firstFrameUrl = ref<string | null>(null)
watch(resolvedSrc, (src) => {
  if (!src?.startsWith('data:image/gif')) {
    firstFrameUrl.value = null
    return
  }
  const img = new Image()
  img.onload = () => {
    const canvas = document.createElement('canvas')
    canvas.width  = img.naturalWidth
    canvas.height = img.naturalHeight
    canvas.getContext('2d')!.drawImage(img, 0, 0)
    firstFrameUrl.value = canvas.toDataURL('image/png')
  }
  img.src = src
}, { immediate: true })

const displaySrc = computed(() => {
  if (!resolvedSrc.value) return ''
  if (isGif.value && !gifPlaying.value && !props.animate) return firstFrameUrl.value ?? resolvedSrc.value
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
