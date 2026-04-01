<template>
  <aside class="member-list">
    <div class="member-list-header">MEMBERS — {{ totalCount }}</div>

    <div class="member-scroll">
      <template v-if="onlineMembers.length">
        <div class="member-category-label">ONLINE — {{ onlineMembers.length }}</div>
        <MemberRow v-for="m in onlineMembers" :key="m.userId" :member="m" />
      </template>

      <template v-if="offlineMembers.length">
        <div class="member-category-label">OFFLINE — {{ offlineMembers.length }}</div>
        <MemberRow v-for="m in offlineMembers" :key="m.userId" :member="m" />
      </template>

      <div v-if="!totalCount" class="no-members">
        No members yet
      </div>
    </div>
  </aside>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useServersStore } from '@/stores/serversStore'
import MemberRow from './MemberRow.vue'

const serversStore = useServersStore()

const activeMembers = computed(() => {
  const sid = serversStore.activeServerId
  if (!sid) return []
  return Object.values(serversStore.members[sid] ?? {})
})

const onlineMembers  = computed(() => activeMembers.value.filter(m => m.onlineStatus !== 'offline'))
const offlineMembers = computed(() => activeMembers.value.filter(m => m.onlineStatus === 'offline'))
const totalCount     = computed(() => activeMembers.value.length)
</script>

<style scoped>
.member-list {
  display: flex;
  flex-direction: column;
  background: var(--bg-secondary);
  border-left: 1px solid var(--border-color);
  overflow: hidden;
  min-width: 0;
}

.member-list-header {
  padding: 12px var(--spacing-md);
  font-size: 11px;
  font-weight: 700;
  color: var(--text-tertiary);
  letter-spacing: 0.04em;
  border-bottom: 1px solid var(--border-color);
  flex-shrink: 0;
  height: 48px;
  display: flex;
  align-items: center;
}

.member-scroll {
  flex: 1;
  overflow-y: auto;
  padding: var(--spacing-md) var(--spacing-sm);
}

.member-category-label {
  font-size: 11px;
  font-weight: 700;
  color: var(--text-tertiary);
  letter-spacing: 0.04em;
  padding: var(--spacing-sm) var(--spacing-sm) var(--spacing-xs);
}

.no-members {
  font-size: 13px;
  color: var(--text-tertiary);
  text-align: center;
  margin-top: var(--spacing-xl);
}
</style>
