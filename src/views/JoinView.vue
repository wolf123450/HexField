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
import { invoke } from '@tauri-apps/api/core'
import { useServersStore } from '@/stores/serversStore'
import { useChannelsStore } from '@/stores/channelsStore'
import { useNetworkStore } from '@/stores/networkStore'
import { useUIStore } from '@/stores/uiStore'
import type { PeerInvite } from '@/types/core'

const route     = useRoute()
const router    = useRouter()
const uiStore   = useUIStore()
const statusMsg = ref('Parsing invite link…')
const isError   = ref(false)

function decodeInvite(raw: string): PeerInvite {
  let encoded = raw.trim()
  const prefix = 'gamechat://join/'
  if (encoded.startsWith(prefix)) encoded = encoded.slice(prefix.length)
  const pad = (4 - (encoded.length % 4)) % 4
  const b64 = encoded.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat(pad)
  const invite = JSON.parse(atob(b64)) as PeerInvite
  if (invite.v !== 2) throw new Error('This invite link is outdated. Ask the server owner to generate a new one.')
  if (!invite.userId || !invite.serverId) throw new Error('Invite link is malformed.')
  return invite
}

onMounted(async () => {
  const serversStore  = useServersStore()
  const channelsStore = useChannelsStore()
  const networkStore  = useNetworkStore()

  try {
    const param = route.params.inviteCode as string
    if (!param) throw new Error('No invite code provided.')

    const invite = decodeInvite(param)

    // Try each endpoint until one connects
    let connected = false
    for (const ep of invite.endpoints) {
      try {
        statusMsg.value = `Connecting via ${ep.type === 'lan' ? 'local network' : 'direct'}…`
        await invoke('lan_connect_peer', { userId: invite.userId, addr: ep.addr, port: ep.port })
        connected = true
        break
      } catch {
        // try next endpoint
      }
    }
    if (!connected) throw new Error('Could not reach the server owner. Make sure you\'re on the same network.')

    statusMsg.value = 'Establishing encrypted connection…'
    await networkStore.connectToPeer(invite.userId)
    await networkStore.waitForPeer(invite.userId, 15000)

    statusMsg.value = `Requesting server info for "${invite.serverName}"…`
    const manifest = await networkStore.requestServerManifest(invite.userId, invite.serverId, invite.inviteToken)

    statusMsg.value = `Joining ${manifest.server.name}…`
    const server = await serversStore.joinFromManifest(manifest)

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
