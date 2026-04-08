<template>
  <div class="member-row" @click="openProfile" @contextmenu.prevent="onContextMenu">
    <div class="member-avatar-wrap">
      <AvatarImage :hash="member.avatarHash" :src="member.avatarDataUrl" :name="member.displayName" :size="32" />
      <StatusBadge
        :status="(member.onlineStatus as 'online'|'idle'|'dnd'|'offline') || 'offline'"
        :size="12"
        class="member-status-badge"
      />
    </div>
    <div class="member-name">{{ member.displayName }}</div>
    <div v-if="member.roles.length" class="member-role">{{ member.roles[0] }}</div>
  </div>

  <!-- Kick confirm modal -->
  <ModerationActionModal
    :show="showKickModal"
    title="Kick member"
    :body="`Remove ${member.displayName} from this server? They can rejoin with an invite link.`"
    confirm-label="Kick"
    @confirm="doKick"
    @cancel="showKickModal = false"
  />

  <!-- Ban confirm modal -->
  <ModerationActionModal
    :show="showBanModal"
    title="Ban member"
    :body="`Ban ${member.displayName} from this server? Duration: ${banDurationLabel}`"
    confirm-label="Ban"
    @confirm="doBan"
    @cancel="showBanModal = false"
  />
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import type { ServerMember } from '@/types/core'
import { useUIStore } from '@/stores/uiStore'
import { useServersStore } from '@/stores/serversStore'
import { useIdentityStore } from '@/stores/identityStore'
import { usePersonalBlocksStore } from '@/stores/personalBlocksStore'
import { useIsAdmin } from '@/utils/useIsAdmin'
import ModerationActionModal from '@/components/modals/ModerationActionModal.vue'

const props = defineProps<{ member: ServerMember; serverId: string }>()

const uiStore              = useUIStore()
const serversStore         = useServersStore()
const identityStore        = useIdentityStore()
const personalBlocksStore  = usePersonalBlocksStore()

const showKickModal = ref(false)
const showBanModal  = ref(false)
const banDuration   = ref<'permanent' | '30d' | '7d' | '1d'>('permanent')

const banDurationLabel = computed(() => {
  const labels: Record<string, string> = {
    permanent: 'Permanent',
    '30d': '30 days',
    '7d':  '7 days',
    '1d':  '1 day',
  }
  return labels[banDuration.value] ?? 'Permanent'
})

const isAdmin = useIsAdmin(computed(() => props.serverId))

const isSelf = computed(() => identityStore.userId === props.member.userId)

function openProfile() {
  uiStore.openUserProfile(props.member.userId, props.serverId, true)
}

function onContextMenu(e: MouseEvent) {
  const items: import('@/stores/uiStore').MenuItem[] = [
    {
      type: 'action',
      label: 'View Profile',
      callback: openProfile,
    },
  ]

  if (isAdmin.value && !isSelf.value) {
    items.push({ type: 'separator' })
    items.push({
      type: 'action',
      label: 'Kick',
      danger: true,
      callback: () => { showKickModal.value = true },
    })
    items.push({
      type: 'action',
      label: 'Ban (permanent)',
      danger: true,
      callback: () => { banDuration.value = 'permanent'; showBanModal.value = true },
    })
    items.push({
      type: 'action',
      label: 'Ban (30 days)',
      danger: true,
      callback: () => { banDuration.value = '30d'; showBanModal.value = true },
    })
    items.push({
      type: 'action',
      label: 'Ban (7 days)',
      danger: true,
      callback: () => { banDuration.value = '7d'; showBanModal.value = true },
    })
    items.push({
      type: 'action',
      label: 'Ban (1 day)',
      danger: true,
      callback: () => { banDuration.value = '1d'; showBanModal.value = true },
    })
  }

  // Personal block/unblock — available for all non-self members
  if (!isSelf.value) {
    const blocked = personalBlocksStore.isBlocked(props.member.userId)
    items.push({ type: 'separator' })
    items.push({
      type: 'action',
      label: blocked ? 'Unblock' : 'Block',
      danger: !blocked,
      callback: () => {
        if (blocked) personalBlocksStore.unblockUser(props.member.userId)
        else         personalBlocksStore.blockUser(props.member.userId)
      },
    })
  }

  uiStore.showContextMenu(e.clientX, e.clientY, items)
}

async function doKick(reason: string) {
  showKickModal.value = false
  await serversStore.kickMember(props.serverId, props.member.userId, reason)
}

async function doBan(reason: string) {
  showBanModal.value = false
  const expiresAt = banDurationToIso(banDuration.value)
  await serversStore.banMember(props.serverId, props.member.userId, reason, expiresAt)
}

function banDurationToIso(duration: string): string | null {
  if (duration === 'permanent') return null
  const msMap: Record<string, number> = {
    '1d':  86_400_000,
    '7d':  7 * 86_400_000,
    '30d': 30 * 86_400_000,
  }
  const ms = msMap[duration]
  return ms ? new Date(Date.now() + ms).toISOString() : null
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
