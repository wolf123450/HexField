<template>
  <TitleBar />
  <RouterView />
  <Settings />
  <Notification />
  <ContextMenu />
  <ServerCreateModal />
  <InviteModal />
  <JoinModal />
  <DeviceLinkModal />
  <UserProfileModal />
</template>

<script setup lang="ts">
import { onMounted } from 'vue'
import { RouterView } from 'vue-router'
import TitleBar from '@/components/TitleBar.vue'
import Settings from '@/components/Settings.vue'
import Notification from '@/components/Notification.vue'
import ContextMenu from '@/components/ContextMenu.vue'
import ServerCreateModal from '@/components/modals/ServerCreateModal.vue'
import InviteModal from '@/components/modals/InviteModal.vue'
import JoinModal from '@/components/modals/JoinModal.vue'
import DeviceLinkModal from '@/components/modals/DeviceLinkModal.vue'
import UserProfileModal from '@/components/modals/UserProfileModal.vue'
import { useUIStore } from '@/stores/uiStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { useIdentityStore } from '@/stores/identityStore'
import { useServersStore } from '@/stores/serversStore'
import { useNetworkStore } from '@/stores/networkStore'
import { useMessagesStore } from '@/stores/messagesStore'
import { useVoiceStore } from '@/stores/voiceStore'
import { autoCheckForUpdate } from '@/utils/updateService'
import { initializeKeyboardShortcuts, registerDefaultShortcuts, keyboardShortcutManager } from '@/utils/keyboard'
import { createContextMenuResolver } from '@/utils/contextMenuResolver'
import { APP_ONBOARDING_KEY, APP_NAME } from '@/appConfig'

const uiStore       = useUIStore()
const settingsStore = useSettingsStore()
const identityStore = useIdentityStore()
const serversStore  = useServersStore()
const networkStore  = useNetworkStore()
const messagesStore = useMessagesStore()
const voiceStore    = useVoiceStore()

// Apply persisted theme immediately
uiStore.setTheme(settingsStore.settings.theme)

const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

const contextMenuResolver = createContextMenuResolver({ sidebarResetWidth: () => {} })

onMounted(async () => {
  // Initialize identity (loads or generates keypair + WASM init)
  await identityStore.initializeIdentity()

  // Give messagesStore the local userId for synchronous reaction computation
  if (identityStore.userId) {
    messagesStore.setMyUserId(identityStore.userId)
  }

  // Initialize P2P networking layer
  if (identityStore.userId) {
    await networkStore.init(identityStore.userId)
    // Connect to rendezvous server if configured
    const rendezvousUrl = settingsStore.settings.rendezvousServerUrl
    if (rendezvousUrl) {
      networkStore.connect(rendezvousUrl).catch(() => {
        // Non-fatal — app works without a rendezvous server
      })
    }
  }

  // Load joined servers
  await serversStore.loadServers()

  // Select first server if any, and load its first text channel
  const firstId = serversStore.joinedServerIds[0]
  if (firstId) {
    serversStore.setActiveServer(firstId)
    const { useChannelsStore } = await import('@/stores/channelsStore')
    const channelsStore = useChannelsStore()
    await Promise.all([
      channelsStore.loadChannels(firstId),
      serversStore.fetchMembers(firstId),
    ])
    const first = channelsStore.channels[firstId]?.find(c => c.type === 'text')
    if (first) {
      channelsStore.setActiveChannel(first.id)
      const { useMessagesStore } = await import('@/stores/messagesStore')
      const messagesStore = useMessagesStore()
      await messagesStore.loadMessages(first.id)
      await messagesStore.loadMutationsForChannel(first.id)
    }
  }

  // Keyboard shortcuts
  initializeKeyboardShortcuts()
  registerDefaultShortcuts({
    settings: () => uiStore.toggleSettings(),
  })
  // Voice control shortcuts
  keyboardShortcutManager.register('m', () => {
    if (voiceStore.session) voiceStore.toggleMute()
  }, { ctrl: true, shift: true })
  keyboardShortcutManager.register('d', () => {
    if (voiceStore.session) voiceStore.toggleDeafen()
  }, { ctrl: true, shift: true })

  // Global context menu handler
  document.addEventListener('contextmenu', (e) => {
    if (import.meta.env.PROD && isTauri) e.preventDefault()
    const items = contextMenuResolver(e)
    if (items.length > 0) {
      e.preventDefault()
      uiStore.showContextMenu(e.clientX, e.clientY, items)
    }
  })

  // Welcome notification on first launch
  if (!localStorage.getItem(APP_ONBOARDING_KEY)) {
    localStorage.setItem(APP_ONBOARDING_KEY, '1')
    uiStore.showNotification(`Welcome to ${APP_NAME}!`, 'info', 5000)
  }

  // Auto-update check (deferred)
  setTimeout(() => autoCheckForUpdate(), 10_000)
})
</script>
