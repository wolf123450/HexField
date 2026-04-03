<template>
  <Teleport to="body">
    <div v-if="uiStore.showJoinModal" class="modal-backdrop" @click.self="close">
      <div class="modal-box" @keydown.esc="close">
        <div class="modal-header">
          <h2>Join a Server</h2>
          <button class="close-btn" @click="close">
            <AppIcon :path="mdiClose" :size="16" />
          </button>
        </div>

        <p class="modal-hint">
          Paste an invite link or scan a QR code to join a server.
        </p>

        <label class="field-label">INVITE LINK OR CODE</label>
        <input
          ref="inputRef"
          v-model="code"
          class="text-input"
          placeholder="gamechat://join/â€¦"
          :disabled="joining"
          @keydown.enter="join"
        />

        <p v-if="statusMsg" class="status-msg" :class="{ error: isError }">{{ statusMsg }}</p>

        <div class="modal-actions">
          <button class="btn-secondary" :disabled="joining" @click="close">Cancel</button>
          <button class="btn-primary" :disabled="!code.trim() || joining" @click="join">
            {{ joining ? joiningLabel : 'Join Server' }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, watch, nextTick } from 'vue'
import { mdiClose } from '@mdi/js'
import { invoke } from '@tauri-apps/api/core'
import { useUIStore } from '@/stores/uiStore'
import { useServersStore } from '@/stores/serversStore'
import { useChannelsStore } from '@/stores/channelsStore'
import { useNetworkStore } from '@/stores/networkStore'
import type { PeerInvite } from '@/types/core'

const uiStore        = useUIStore()
const serversStore   = useServersStore()
const channelsStore  = useChannelsStore()
const networkStore   = useNetworkStore()

const code         = ref('')
const joining      = ref(false)
const joiningLabel = ref('Joiningâ€¦')
const statusMsg    = ref('')
const isError      = ref(false)
const inputRef     = ref<HTMLInputElement | null>(null)

watch(() => uiStore.showJoinModal, async (open) => {
  if (open) {
    code.value      = ''
    joining.value   = false
    statusMsg.value = ''
    isError.value   = false
    await nextTick()
    inputRef.value?.focus()
  }
})

function decodeInvite(raw: string): PeerInvite {
  let encoded = raw.trim()
  const prefix = 'gamechat://join/'
  if (encoded.startsWith(prefix)) encoded = encoded.slice(prefix.length)
  const pad = (4 - (encoded.length % 4)) % 4
  const b64 = encoded.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat(pad)
  const invite = JSON.parse(atob(b64)) as PeerInvite | { v?: number }
  if ((invite as PeerInvite).v !== 2) throw new Error('This invite link is from an older version. Ask the server owner to generate a new one.')
  const pi = invite as PeerInvite
  if (!pi.userId || !pi.serverId) throw new Error('Invite link is incomplete.')
  return pi
}

async function join() {
  if (!code.value.trim() || joining.value) return
  joining.value  = true
  statusMsg.value = ''
  isError.value   = false

  try {
    // â”€â”€ 1. Decode invite â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    let invite: PeerInvite
    try {
      invite = decodeInvite(code.value)
    } catch (e: unknown) {
      throw new Error(e instanceof Error ? e.message : 'Invalid invite link.')
    }

    // â”€â”€ 2. Connect to the inviter's signal server (LAN endpoints) â”€â”€
    let connected = false
    for (const ep of invite.endpoints) {
      joiningLabel.value = `Connecting via ${ep.type === 'lan' ? 'local network' : 'internet'}â€¦`
      try {
        await invoke('lan_connect_peer', { userId: invite.userId, addr: ep.addr, port: ep.port })
        connected = true
        break
      } catch {
        // Try next endpoint
      }
    }

    if (!connected && invite.endpoints.length > 0) {
      throw new Error(`Could not reach ${invite.displayName}'s device. Make sure you're on the same network and the invite is still open.`)
    }
    if (invite.endpoints.length === 0) {
      throw new Error('Invite has no endpoints. Ask the server owner to regenerate the invite while their app is open.')
    }

    // â”€â”€ 3. WebRTC offer â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    joiningLabel.value = 'Establishing secure connectionâ€¦'
    await networkStore.connectToPeer(invite.userId)
    await networkStore.waitForPeer(invite.userId, 15000)

    // â”€â”€ 4. Request the full server manifest over the data channel â”€â”€
    joiningLabel.value = 'Requesting server dataâ€¦'
    const manifest = await networkStore.requestServerManifest(
      invite.userId,
      invite.serverId,
      invite.inviteToken,
    )

    // â”€â”€ 5. Bootstrap server locally from the received manifest â”€â”€â”€â”€â”€
    joiningLabel.value = 'Saving serverâ€¦'
    const server = await serversStore.joinFromManifest(manifest)

    // â”€â”€ 6. Navigate â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    serversStore.setActiveServer(server.id)
    await channelsStore.loadChannels(server.id)
    const first = channelsStore.channels[server.id]?.find(c => c.type === 'text')
    if (first) channelsStore.setActiveChannel(first.id)

    uiStore.showJoinModal = false
    uiStore.showNotification(`Joined ${server.name}!`, 'success', 3000)
  } catch (e: unknown) {
    statusMsg.value = e instanceof Error ? e.message : 'Could not join server.'
    isError.value   = true
  } finally {
    joining.value      = false
    joiningLabel.value = 'Joiningâ€¦'
  }
}

function close() {
  if (!joining.value) uiStore.showJoinModal = false
}
</script>

<style scoped>
.modal-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.7);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.modal-box {
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  padding: var(--spacing-xl);
  width: 440px;
  max-width: 90vw;
  display: flex;
  flex-direction: column;
  gap: var(--spacing-md);
}

.modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.modal-header h2 { margin: 0; font-size: 20px; color: var(--text-primary); }

.close-btn {
  background: none;
  border: none;
  cursor: pointer;
  color: var(--text-secondary);
  padding: 0;
  transform: none;
  border-radius: 4px;
  display: flex;
}
.close-btn:hover { color: var(--text-primary); background: var(--bg-tertiary); }

.modal-hint {
  margin: 0;
  font-size: 14px;
  color: var(--text-secondary);
}

.field-label {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.04em;
  color: var(--text-secondary);
}

.text-input {
  background: var(--bg-primary);
  border: 1px solid var(--border-color);
  border-radius: 4px;
  padding: 10px var(--spacing-md);
  color: var(--text-primary);
  font-size: 14px;
  outline: none;
  width: 100%;
  box-sizing: border-box;
}
.text-input:focus { border-color: var(--accent-color); }

.status-msg {
  font-size: 13px;
  color: var(--text-secondary);
  margin: 0;
}
.status-msg.error { color: var(--error-color); }

.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--spacing-sm);
  margin-top: var(--spacing-sm);
}

.btn-secondary {
  background: none;
  border: 1px solid var(--border-color);
  border-radius: 4px;
  padding: 8px 16px;
  color: var(--text-primary);
  font-size: 14px;
  cursor: pointer;
}
.btn-secondary:hover { background: var(--bg-tertiary); }

.btn-primary {
  background: var(--accent-color);
  border: none;
  border-radius: 4px;
  padding: 8px 16px;
  color: white;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
}
.btn-primary:hover:not(:disabled) { filter: brightness(1.1); }
.btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
</style>
