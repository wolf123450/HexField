<template>
  <div
    class="app-layout"
    :class="{
      'member-list-hidden': !uiStore.memberListOpen,
      'layout-mobile':  isMobile,
      'layout-tablet':  isTablet,
      'layout-desktop': isDesktop,
      [`mobile-panel-${uiStore.mobilePanelView}`]: isMobile,
    }"
  >
    <ServerRail />
    <ChannelSidebar />
    <MainPane />
    <MemberList />

    <!-- Mobile bottom navigation bar -->
    <nav v-if="isMobile" class="mobile-nav-bar">
      <button
        class="mobile-nav-btn"
        :class="{ active: uiStore.mobilePanelView === 'servers' }"
        aria-label="Servers"
        @click="uiStore.setMobilePanelView('servers')"
      >
        <AppIcon :path="mdiViewGrid" :size="22" />
      </button>
      <button
        class="mobile-nav-btn"
        :class="{ active: uiStore.mobilePanelView === 'channels' }"
        aria-label="Channels"
        @click="uiStore.setMobilePanelView('channels')"
      >
        <AppIcon :path="mdiFormatListBulleted" :size="22" />
      </button>
      <button
        class="mobile-nav-btn"
        :class="{ active: uiStore.mobilePanelView === 'chat' }"
        aria-label="Chat"
        @click="uiStore.setMobilePanelView('chat')"
      >
        <AppIcon :path="mdiChat" :size="22" />
      </button>
      <button
        class="mobile-nav-btn"
        :class="{ active: uiStore.mobilePanelView === 'members' }"
        aria-label="Members"
        @click="uiStore.setMobilePanelView('members')"
      >
        <AppIcon :path="mdiAccountMultiple" :size="22" />
      </button>
    </nav>
  </div>
</template>

<script setup lang="ts">
import { mdiViewGrid, mdiFormatListBulleted, mdiChat, mdiAccountMultiple } from '@mdi/js'
import ServerRail from '@/components/layout/ServerRail.vue'
import ChannelSidebar from '@/components/layout/ChannelSidebar.vue'
import MainPane from '@/components/layout/MainPane.vue'
import MemberList from '@/components/layout/MemberList.vue'
import { useUIStore } from '@/stores/uiStore'
import { useBreakpoint } from '@/utils/useBreakpoint'

const uiStore = useUIStore()
const { isMobile, isTablet, isDesktop } = useBreakpoint()
</script>

<style scoped>
/* ── Mobile layout (< 640 px) ─────────────────────────────────────────── */

.layout-mobile {
  /* Switch to single-column; bottom nav bar takes 56 px */
  display: grid;
  grid-template-columns: 1fr;
  grid-template-rows: 1fr 56px;
  height: calc(100vh - var(--titlebar-height, 32px));
  position: relative;
}

/* All four panels fill the same grid cell — only the active one is visible */
.layout-mobile :deep(.server-rail),
.layout-mobile :deep(.channel-sidebar),
.layout-mobile :deep(.main-pane),
.layout-mobile :deep(.member-list) {
  grid-row: 1;
  grid-column: 1;
  display: none;
}

.layout-mobile.mobile-panel-servers :deep(.server-rail),
.layout-mobile.mobile-panel-channels :deep(.channel-sidebar),
.layout-mobile.mobile-panel-chat :deep(.main-pane),
.layout-mobile.mobile-panel-members :deep(.member-list) {
  display: flex;
}

/* ── Tablet layout (640 – 1024 px) ───────────────────────────────────── */

.layout-tablet {
  grid-template-columns:
    var(--server-rail-width)
    var(--channel-sidebar-width)
    1fr;
  /* Always hide member list on tablet to gain space */
  --member-list-active-width: 0px;
}

.layout-tablet :deep(.member-list) {
  display: none;
}

/* ── Mobile nav bar ────────────────────────────────────────────────────── */

.mobile-nav-bar {
  grid-row: 2;
  grid-column: 1;
  display: flex;
  align-items: center;
  justify-content: space-around;
  background: var(--bg-secondary);
  border-top: 1px solid var(--border-color);
  height: 56px;
  z-index: 10;
}

.mobile-nav-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 56px;
  height: 56px;
  background: none;
  border: none;
  color: var(--text-secondary);
  cursor: pointer;
  padding: 0;
  transform: none;
}

.mobile-nav-btn.active {
  color: var(--accent-color);
}

.mobile-nav-btn:hover {
  color: var(--text-primary);
  transform: none;
}
</style>
