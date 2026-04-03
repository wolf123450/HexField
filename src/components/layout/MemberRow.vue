<template>
  <div class="member-row" @click="openProfile">
    <div class="member-avatar-wrap">
      <div class="member-avatar">{{ initials }}</div>
      <div class="status-dot" :class="member.onlineStatus" />
    </div>
    <div class="member-name">{{ member.displayName }}</div>
    <div v-if="member.roles.length" class="member-role">{{ member.roles[0] }}</div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { ServerMember } from '@/types/core'
import { useUIStore } from '@/stores/uiStore'

const props = defineProps<{ member: ServerMember; serverId: string }>()

const uiStore = useUIStore()

const initials = computed(() => {
  return props.member.displayName.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase()
})

function openProfile() {
  uiStore.openUserProfile(props.member.userId, props.serverId)
}
</script>

<style scoped>
.member-row {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  padding: 4px var(--spacing-sm);
  border-radius: 4px;
  cursor: pointer;
  transition: background 0.1s ease;
}

.member-row:hover {
  background: var(--bg-tertiary);
}

.member-avatar-wrap {
  position: relative;
  flex-shrink: 0;
}

.member-avatar {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  background: var(--accent-color);
  color: white;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  font-weight: 700;
}

.status-dot {
  position: absolute;
  bottom: 0;
  right: 0;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  border: 2px solid var(--bg-secondary);
}

.status-dot.online  { background: var(--success-color); }
.status-dot.idle    { background: var(--warning-color); }
.status-dot.dnd     { background: var(--error-color); }
.status-dot.offline { background: var(--text-tertiary); }

.member-name {
  font-size: 14px;
  color: var(--text-secondary);
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.member-role {
  font-size: 11px;
  color: var(--text-tertiary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
