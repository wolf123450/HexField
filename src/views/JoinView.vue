<template>
  <div class="join-view">
    <div class="join-card">
      <h2>Joining server…</h2>
      <p v-if="statusMsg" :class="{ error: isError }">{{ statusMsg }}</p>
      <div v-if="!isError" class="spinner" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useServersStore } from '@/stores/serversStore'
import { useChannelsStore } from '@/stores/channelsStore'
import { useNetworkStore } from '@/stores/networkStore'
import { useUIStore } from '@/stores/uiStore'
import type { ServerManifest } from '@/types/core'

const route     = useRoute()
const router    = useRouter()
const uiStore   = useUIStore()
const statusMsg = ref('Parsing invite link…')
const isError   = ref(false)

function decodeManifest(raw: string): ServerManifest {
  let encoded = raw.trim()
  const prefix = 'gamechat://join/'
  if (encoded.startsWith(prefix)) encoded = encoded.slice(prefix.length)
  const pad = (4 - (encoded.length % 4)) % 4
  const b64 = encoded.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat(pad)
  const manifest = JSON.parse(atob(b64)) as ServerManifest
  if (manifest.v !== 1) throw new Error('Unrecognised invite version')
  if (!manifest.server?.id) throw new Error('Invite link is missing server data')
  return manifest
}

onMounted(async () => {
  const serversStore  = useServersStore()
  const channelsStore = useChannelsStore()
  const networkStore  = useNetworkStore()

  try {
    const param = route.params.inviteCode as string
    if (!param) throw new Error('No invite code provided.')

    const manifest = decodeManifest(param)

    statusMsg.value = `Joining ${manifest.server.name}…`
    const server    = await serversStore.joinFromManifest(manifest)

    if (manifest.rendezvousUrl) {
      statusMsg.value = 'Connecting to relay…'
      if (networkStore.signalingState !== 'connected') {
        await networkStore.connect(manifest.rendezvousUrl)
      }
      try {
        await networkStore.waitForConnected(12000)
        statusMsg.value = 'Connecting to peer…'
        await networkStore.connectToPeer(manifest.owner.userId)
      } catch {
        uiStore.showNotification(
          `Joined ${server.name} locally. Could not reach relay server — start chatting when online.`,
          'info', 6000,
        )
      }
    }

    serversStore.setActiveServer(server.id)
    await channelsStore.loadChannels(server.id)
    const first = channelsStore.channels[server.id]?.find(c => c.type === 'text')
    if (first) channelsStore.setActiveChannel(first.id)

    uiStore.showNotification(`Joined ${server.name}!`, 'success', 3000)
    router.replace({ path: '/servers' })
  } catch (e: unknown) {
    isError.value   = true
    statusMsg.value = e instanceof Error ? e.message : 'Invalid invite link.'
  }
})
</script>

<style scoped>
.join-view {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100vh;
  background: var(--bg-primary);
}

.join-card {
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  padding: 40px 48px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
  min-width: 320px;
}

h2 { margin: 0; color: var(--text-primary); font-size: 20px; }

p {
  margin: 0;
  font-size: 14px;
  color: var(--text-secondary);
  text-align: center;
}
p.error { color: var(--error-color); }

.spinner {
  width: 32px;
  height: 32px;
  border: 3px solid var(--border-color);
  border-top-color: var(--accent-color);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }
</style>
