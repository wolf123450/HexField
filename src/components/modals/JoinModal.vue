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
          placeholder="gamechat://join/…"
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
import { useUIStore } from '@/stores/uiStore'
import { useServersStore } from '@/stores/serversStore'
import { useChannelsStore } from '@/stores/channelsStore'
import { useNetworkStore } from '@/stores/networkStore'
import type { ServerManifest } from '@/types/core'

const uiStore        = useUIStore()
const serversStore   = useServersStore()
const channelsStore  = useChannelsStore()
const networkStore   = useNetworkStore()

const code        = ref('')
const joining     = ref(false)
const joiningLabel = ref('Joining…')
const statusMsg   = ref('')
const isError     = ref(false)
const inputRef    = ref<HTMLInputElement | null>(null)

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

function decodeManifest(raw: string): ServerManifest {
  let encoded = raw.trim()
  const prefix = 'gamechat://join/'
  if (encoded.startsWith(prefix)) encoded = encoded.slice(prefix.length)

  // Re-pad base64url → standard base64
  const pad = (4 - (encoded.length % 4)) % 4
  const b64 = encoded.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat(pad)
  const manifest = JSON.parse(atob(b64)) as ServerManifest
  if (manifest.v !== 1) throw new Error('Unrecognised invite version')
  if (!manifest.server?.id) throw new Error('Invite link is missing server data')
  return manifest
}

async function join() {
  if (!code.value.trim() || joining.value) return
  joining.value = true
  statusMsg.value = ''
  isError.value  = false

  try {
    // ── Step 1: decode manifest ──────────────────────────────────────
    let manifest: ServerManifest
    try {
      manifest = decodeManifest(code.value)
    } catch {
      throw new Error('Invalid invite link — make sure you pasted the full link.')
    }

    // ── Step 2: bootstrap server locally ────────────────────────────
    joiningLabel.value = 'Saving server…'
    const server = await serversStore.joinFromManifest(manifest)

    // ── Step 3: connect to signaling server ─────────────────────────
    if (manifest.rendezvousUrl) {
      joiningLabel.value = 'Connecting to relay…'
      if (networkStore.signalingState !== 'connected') {
        await networkStore.connect(manifest.rendezvousUrl)
      }
      try {
        await networkStore.waitForConnected(12000)
      } catch {
        // Non-fatal: server is saved locally; P2P will work next time both are online
        uiStore.showNotification(
          `Joined ${server.name} locally. Could not reach relay server — start chatting when online.`,
          'info', 6000,
        )
        navigateToServer(server.id)
        return
      }

      // ── Step 4: initiate WebRTC handshake with the server owner ───
      joiningLabel.value = 'Connecting to peer…'
      await networkStore.connectToPeer(manifest.owner.userId)
    }

    // ── Step 5: navigate ─────────────────────────────────────────────
    navigateToServer(server.id)
    uiStore.showNotification(`Joined ${server.name}!`, 'success', 3000)
  } catch (e: unknown) {
    joiningLabel.value = 'Joining…'
    statusMsg.value = e instanceof Error ? e.message : 'Could not join server.'
    isError.value   = true
    joining.value   = false
  }
}

function navigateToServer(serverId: string) {
  serversStore.setActiveServer(serverId)
  channelsStore.loadChannels(serverId).then(() => {
    const first = channelsStore.channels[serverId]?.find(c => c.type === 'text')
    if (first) channelsStore.setActiveChannel(first.id)
  })
  joining.value        = false
  joiningLabel.value   = 'Joining…'
  uiStore.showJoinModal = false
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
