<template>
  <Teleport to="body">
    <div v-if="uiStore.showInviteModal" class="modal-backdrop" @click.self="close">
      <div class="modal-box">
        <div class="modal-header">
          <h2>Invite People</h2>
          <button class="close-btn" @click="close">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
            </svg>
          </button>
        </div>

        <p class="modal-hint">
          Share this link with someone nearby. They can scan the QR code or paste
          the link to join directly over your local network.
        </p>

        <div v-if="qrSvg" class="qr-wrapper" v-html="qrSvg" />

        <label class="field-label">INVITE LINK</label>
        <div class="link-row">
          <input class="text-input" :value="inviteLink" readonly />
          <button class="btn-copy" @click="copyLink" :title="copied ? 'Copied!' : 'Copy'">
            <svg v-if="!copied" width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/>
            </svg>
            <svg v-else width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/>
            </svg>
          </button>
        </div>

        <p class="modal-hint small">
          Invite code: <strong>{{ server?.inviteCode }}</strong>
        </p>

        <div class="modal-actions">
          <button class="btn-primary" @click="close">Done</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import QRCode from 'qrcode'
import { useUIStore } from '@/stores/uiStore'
import { useServersStore } from '@/stores/serversStore'
import { useIdentityStore } from '@/stores/identityStore'
import type { PeerInvite, PeerEndpoint } from '@/types/core'

const uiStore        = useUIStore()
const serversStore   = useServersStore()
const identityStore  = useIdentityStore()

const qrSvg    = ref<string>('')
const copied   = ref(false)
const inviteToken = ref<string>('')
const endpoints   = ref<PeerEndpoint[]>([])

const server = computed(() =>
  uiStore.inviteServerId ? serversStore.servers[uiStore.inviteServerId] : null
)

const inviteLink = computed((): string => {
  if (!server.value || !inviteToken.value) return ''

  const invite: PeerInvite = {
    v:             2,
    userId:        identityStore.userId        ?? '',
    displayName:   identityStore.displayName,
    publicSignKey: identityStore.publicSignKey ?? '',
    publicDHKey:   identityStore.publicDHKey   ?? '',
    endpoints:     endpoints.value,
    serverId:      server.value.id,
    serverName:    server.value.name,
    inviteToken:   inviteToken.value,
  }

  const encoded = btoa(JSON.stringify(invite))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
  return `gamechat://join/${encoded}`
})

watch(() => uiStore.showInviteModal, async (open) => {
  if (!open) return
  if (!server.value) return

  // Generate a fresh invite token for this session.
  inviteToken.value = serversStore.createInviteToken(server.value.id)

  // Discover local endpoints (LAN IP:port from the signal server).
  try {
    const raw = await invoke<Array<{ type: string; addr: string; port: number }>>('lan_get_local_addrs')
    endpoints.value = raw.map(e => ({ type: e.type as PeerEndpoint['type'], addr: e.addr, port: e.port }))
  } catch {
    endpoints.value = []
  }

  // Render QR code once we have everything.
  if (inviteLink.value) {
    try {
      qrSvg.value = await QRCode.toString(inviteLink.value, { type: 'svg', margin: 1 })
    } catch {
      qrSvg.value = ''
    }
  }
})

async function copyLink() {
  try {
    await navigator.clipboard.writeText(inviteLink.value)
    copied.value = true
    setTimeout(() => { copied.value = false }, 2000)
  } catch {
    // clipboard not available
  }
}

function close() {
  uiStore.showInviteModal = false
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
  width: 480px;
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
  padding: 4px;
  border-radius: 4px;
  display: flex;
}
.close-btn:hover { color: var(--text-primary); background: var(--bg-tertiary); }

.modal-hint {
  margin: 0;
  font-size: 14px;
  color: var(--text-secondary);
}
.modal-hint.small { font-size: 12px; }

.qr-wrapper {
  display: flex;
  justify-content: center;
  background: white;
  border-radius: 8px;
  padding: var(--spacing-md);
}
.qr-wrapper :deep(svg) {
  width: 160px;
  height: 160px;
}

.field-label {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.04em;
  color: var(--text-secondary);
}

.link-row {
  display: flex;
  gap: var(--spacing-sm);
}

.text-input {
  flex: 1;
  background: var(--bg-primary);
  border: 1px solid var(--border-color);
  border-radius: 4px;
  padding: 10px var(--spacing-md);
  color: var(--text-primary);
  font-size: 13px;
  outline: none;
  min-width: 0;
}

.btn-copy {
  background: var(--bg-tertiary);
  border: 1px solid var(--border-color);
  border-radius: 4px;
  padding: 8px 12px;
  color: var(--text-primary);
  cursor: pointer;
  display: flex;
  align-items: center;
}
.btn-copy:hover { background: var(--bg-primary); }

.modal-actions {
  display: flex;
  justify-content: flex-end;
  margin-top: var(--spacing-sm);
}

.btn-primary {
  background: var(--accent-color);
  border: none;
  border-radius: 4px;
  padding: 8px 24px;
  color: white;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
}
.btn-primary:hover { filter: brightness(1.1); }
</style>
