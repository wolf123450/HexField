<template>
  <div class="app-layout" :class="{ 'member-list-hidden': !uiStore.memberListOpen }">
    <ServerRail />
    <ChannelSidebar />
    <MainPane />
    <MemberList />
  </div>
</template>

<script setup lang="ts">
import ServerRail from '@/components/layout/ServerRail.vue'
import ChannelSidebar from '@/components/layout/ChannelSidebar.vue'
import MainPane from '@/components/layout/MainPane.vue'
import MemberList from '@/components/layout/MemberList.vue'
import { useUIStore } from '@/stores/uiStore'

const uiStore = useUIStore()
</script>
