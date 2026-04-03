<template>
  <!--
    StatusBadge — renders a status indicator using both shape and color so it
    is distinguishable without relying on color alone (colorblind-friendly).

    Shapes (12×12 SVG viewport):
      online  → filled circle
      idle    → crescent (outer circle minus offset inner circle, evenodd fill)
      dnd     → circle with horizontal bar cutout (evenodd fill)
      offline → hollow circle (stroke only)
  -->
  <svg
    :width="size"
    :height="size"
    viewBox="0 0 12 12"
    :aria-label="label"
    role="img"
    class="status-badge"
    :class="status"
    xmlns="http://www.w3.org/2000/svg"
  >
    <!-- Online: filled circle -->
    <circle v-if="status === 'online'" cx="6" cy="6" r="5" fill="currentColor" />

    <!-- Idle: crescent moon — outer circle minus right-shifted inner circle -->
    <path
      v-else-if="status === 'idle'"
      fill-rule="evenodd"
      fill="currentColor"
      d="M6 1a5 5 0 1 0 0 10A5 5 0 0 0 6 1ZM7.7 2.7a3.5 3.5 0 1 1 0 6.6 3.5 3.5 0 0 1 0-6.6Z"
    />

    <!-- DND: circle with horizontal bar cutout -->
    <path
      v-else-if="status === 'dnd'"
      fill-rule="evenodd"
      fill="currentColor"
      d="M6 1a5 5 0 1 0 0 10A5 5 0 0 0 6 1ZM2.5 5H9.5V7H2.5Z"
    />

    <!-- Offline: hollow circle (stroke only) -->
    <circle
      v-else
      cx="6"
      cy="6"
      r="3.5"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
    />
  </svg>
</template>

<script setup lang="ts">
import { computed } from 'vue'

type UserStatus = 'online' | 'idle' | 'dnd' | 'offline'

const LABELS: Record<UserStatus, string> = {
  online:  'Online',
  idle:    'Idle',
  dnd:     'Do Not Disturb',
  offline: 'Offline',
}

const props = withDefaults(defineProps<{
  status: UserStatus
  size?: number
}>(), { size: 10 })

const label = computed(() => LABELS[props.status])
</script>

<style scoped>
.status-badge {
  display: block;
  flex-shrink: 0;
}
.status-badge.online  { color: var(--success-color, #3ba55d); }
.status-badge.idle    { color: var(--warning-color, #faa61a); }
.status-badge.dnd     { color: var(--error-color,   #ed4245); }
.status-badge.offline { color: var(--text-tertiary,  #747f8d); }
</style>
