<template>
  <Teleport to="body">
    <div v-if="show" class="modal-backdrop" @click.self="$emit('close')">
      <div class="modal-box">
        <div class="modal-header">
          <h2>Your Join Link</h2>
          <button class="close-btn" @click="$emit('close')">
            <AppIcon :path="mdiClose" :size="16" />
          </button>
        </div>

        <p class="modal-hint">
          Show this QR code or share the link with a server admin. They will scan it to add you
          directly — no invite code required.
        </p>

        <div v-if="loading" class="loading-row">Generating…</div>
        <template v-else>
          <div v-if="qrSvg" class="qr-wrapper" v-html="qrSvg" />

          <label class="field-label">YOUR JOIN LINK</label>
          <div class="link-row">
            <input class="text-input" :value="capsuleLink" readonly />
            <button class="btn-copy" @click="copyLink" :title="copied ? 'Copied!' : 'Copy'">
              <AppIcon :path="copied ? mdiCheck : mdiContentCopy" :size="16" />
            </button>
          </div>

          <p class="modal-hint" style="margin-top: 8px; font-size: 12px;">
            This link contains your public identity. It does not expire, but the admin must be online
            when they approve to send you the server data.
          </p>
        </template>

        <div class="modal-actions">
          <button class="btn-primary" @click="$emit('close')">Done</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'
import QRCode from 'qrcode'
import { invoke } from '@tauri-apps/api/core'
import { mdiClose, mdiContentCopy, mdiCheck } from '@mdi/js'
import { useIdentityStore } from '@/stores/identityStore'
import { useServersStore } from '@/stores/serversStore'
import type { JoinCapsule, PeerEndpoint } from '@/types/core'

const props = defineProps<{
  show: boolean
  serverId: string
}>()
defineEmits<{ (e: 'close'): void }>()

const identityStore = useIdentityStore()
const serversStore  = useServersStore()

const loading     = ref(false)
const qrSvg       = ref('')
const capsuleLink = ref('')
const copied      = ref(false)

watch(() => props.show, async (open) => {
  if (!open || !props.serverId) return
  loading.value = true
  try {
    let endpoints: PeerEndpoint[] = []
    try {
      const raw = await invoke<Array<{ type: string; addr: string; port: number }>>('lan_get_local_addrs')
      endpoints = raw.map(e => ({ type: e.type as PeerEndpoint['type'], addr: e.addr, port: e.port }))
    } catch { /* non-fatal */ }

    const server = serversStore.servers[props.serverId]
    const capsule: JoinCapsule = {
      v:             1,
      userId:        identityStore.userId        ?? '',
      displayName:   identityStore.displayName,
      publicSignKey: identityStore.publicSignKey ?? '',
      publicDHKey:   identityStore.publicDHKey   ?? '',
      endpoints,
      serverId:      props.serverId,
      serverName:    server?.name ?? props.serverId,
    }

    const encoded = btoa(JSON.stringify(capsule))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
    capsuleLink.value = `hexfield://approve/${encoded}`

    qrSvg.value = await QRCode.toString(capsuleLink.value, {
      type: 'svg',
      margin: 1,
      width: 140,
      errorCorrectionLevel: 'L',
    })
  } finally {
    loading.value = false
  }
}, { immediate: false })

async function copyLink() {
  try {
    await navigator.clipboard.writeText(capsuleLink.value)
    copied.value = true
    setTimeout(() => { copied.value = false }, 2000)
  } catch { /* clipboard unavailable */ }
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
  width: 400px;
  max-width: calc(100vw - 32px);
  max-height: calc(100vh - 64px);
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: var(--spacing-lg);
  padding: var(--spacing-xl);
}

.modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.modal-header h2 {
  margin: 0;
  font-size: 18px;
  font-weight: 700;
  color: var(--text-primary);
}

.close-btn {
  background: none;
  border: none;
  cursor: pointer;
  color: var(--text-secondary);
  padding: 4px;
  border-radius: 4px;
  display: flex;
  align-items: center;
  padding: 0;
  transform: none;
}
.close-btn:hover { color: var(--text-primary); background: var(--bg-tertiary); }

.modal-hint {
  margin: 0;
  font-size: 13px;
  color: var(--text-secondary);
  line-height: 1.5;
}

.loading-row {
  font-size: 13px;
  color: var(--text-tertiary);
  text-align: center;
  padding: var(--spacing-xl) 0;
}

.qr-wrapper {
  display: flex;
  justify-content: center;
  padding: var(--spacing-md);
  background: white;
  border-radius: 8px;
}
.qr-wrapper :deep(svg) {
  width: 160px;
  height: 160px;
}

.field-label {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.06em;
  color: var(--text-tertiary);
}

.link-row {
  display: flex;
  gap: var(--spacing-sm);
  align-items: center;
}

.text-input {
  flex: 1;
  background: var(--bg-tertiary);
  border: 1px solid var(--border-color);
  border-radius: 4px;
  padding: 8px var(--spacing-sm);
  color: var(--text-secondary);
  font-size: 12px;
  font-family: monospace;
  min-width: 0;
}

.btn-copy {
  background: var(--bg-tertiary);
  border: 1px solid var(--border-color);
  border-radius: 4px;
  padding: 8px;
  cursor: pointer;
  color: var(--text-secondary);
  display: flex;
  align-items: center;
  padding: 0;
  transform: none;
}
.btn-copy:hover { color: var(--text-primary); background: var(--bg-primary); }

.modal-actions {
  display: flex;
  justify-content: flex-end;
}

.btn-primary {
  background: var(--accent-color);
  border: none;
  border-radius: 4px;
  padding: 8px 20px;
  color: white;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
}
.btn-primary:hover { filter: brightness(1.1); }
</style>
