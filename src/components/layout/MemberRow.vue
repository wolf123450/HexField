<template>
  <div class="member-row" @click="openProfile">
    <div class="member-avatar-wrap">
      <AvatarImage :src="member.avatarDataUrl" :name="member.displayName" :size="32" />
      <StatusBadge
        :status="(member.onlineStatus as 'online'|'idle'|'dnd'|'offline') || 'offline'"
        :size="12"
        class="member-status-badge"
      />
    </div>
    <div class="member-name">{{ member.displayName }}</div>
    <div v-if="member.roles.length" class="member-role">{{ member.roles[0] }}</div>
  </div>
</template>

<script setup lang="ts">
import type { ServerMember } from '@/types/core'
import { useUIStore } from '@/stores/uiStore'

const props = defineProps<{ member: ServerMember; serverId: string }>()

const uiStore = useUIStore()

function openProfile() {
  // Always open read-only from the member list — even for own profile.
  // The self-panel (ChannelSidebar) is the designated place to edit your own profile.
  uiStore.openUserProfile(props.member.userId, props.serverId, true)
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

.member-status-badge {
  position: absolute;
  bottom: -1px;
  right: -1px;
  border-radius: 50%;
  background: var(--bg-secondary);
  padding: 1px;
  box-sizing: content-box;
}

.member-role {
  font-size: 11px;
  color: var(--text-tertiary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.member-name {
  font-size: 14px;
  color: var(--text-secondary);
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
