<template>
  <svg
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="currentColor"
    v-bind="ariaAttrs"
  >
    <title v-if="title">{{ title }}</title>
    <path :d="path" />
  </svg>
</template>

<script setup lang="ts">
import { computed } from 'vue'

const props = withDefaults(defineProps<{
  path: string
  size?: number | string
  title?: string
}>(), {
  size: 16,
})

const ariaAttrs = computed(() =>
  props.title
    ? { role: 'img' as const }
    : { 'aria-hidden': true as const }
)
</script>
