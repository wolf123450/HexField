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

        <!-- Invite constraints -->
        <div class="constraints-row">
          <div class="constraint-field">
            <label class="field-label">EXPIRES AFTER</label>
            <select v-model="selectedExpiry" class="select-input">
              <option :value="1 * 60 * 60 * 1000">1 hour</option>
              <option :value="6 * 60 * 60 * 1000">6 hours</option>
              <option :value="24 * 60 * 60 * 1000">24 hours</option>
              <option :value="7 * 24 * 60 * 60 * 1000">7 days</option>
              <option :value="null">Never</option>
            </select>
          </div>
          <div class="constraint-field">
            <label class="field-label">MAX USES</label>
            <input
              v-model="maxUsesInput"
              type="number"
              min="1"
              placeholder="Unlimited"
              class="text-input constraint-input"
            />
          </div>
        </div>

        <button class="btn-generate" @click="generateNewLink">Generate new link</button>

        <!-- Active codes list -->
        <div v-if="activeCodes.length > 0" class="codes-section">
          <button class="codes-toggle" @click="showCodes = !showCodes">
            Active codes ({{ activeCodes.length }})
            <svg :style="{ transform: showCodes ? 'rotate(180deg)' : '' }" width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
              <path d="M7 10l5 5 5-5z"/>
            </svg>
          </button>
          <div v-if="showCodes" class="codes-list">
            <div v-for="c in activeCodes" :key="c.code" class="code-row">
              <span class="code-slug">{{ c.code.slice(0, 8) }}…</span>
              <span class="code-uses">{{ c.useCount }}/{{ c.maxUses ?? '∞' }} uses</span>
              <span class="code-expiry">{{ formatExpiry(c.expiresAt) }}</span>
              <button class="btn-revoke" @click="revokeCode(c.code)">Revoke</button>
            </div>
          </div>
        </div>

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
import type { InviteCode } from '@/stores/serversStore'
import type { PeerInvite, PeerEndpoint } from '@/types/core'

const uiStore        = useUIStore()
const serversStore   = useServersStore()
const identityStore  = useIdentityStore()

const qrSvg       = ref<string>('')
const copied      = ref(false)
const inviteToken = ref<string>('')
const endpoints   = ref<PeerEndpoint[]>([])
const showCodes   = ref(false)

// Constraint controls
const selectedExpiry = ref<number | null>(24 * 60 * 60 * 1000) // default 24h
const maxUsesInput   = ref<string>('')

const server = computed(() =>
  uiStore.inviteServerId ? serversStore.servers[uiStore.inviteServerId] : null
)

const activeCodes = computed((): InviteCode[] => {
  if (!server.value) return []
  const now = Date.now()
  return [...serversStore.inviteCodes.values()].filter(c =>
    c.serverId === server.value!.id &&
    (c.expiresAt == null || new Date(c.expiresAt).getTime() > now)
  )
})

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
  return `hexfield://join/${encoded}`
})

watch(() => uiStore.showInviteModal, async (open) => {
  if (!open) return
  if (!server.value) return

  // Load existing codes from DB for this server
  await serversStore.loadInviteCodes(server.value.id)

  // Generate a fresh code for immediate use
  await generateNewLink()

  // Discover local endpoints
  try {
    const raw = await invoke<Array<{ type: string; addr: string; port: number }>>('lan_get_local_addrs')
    endpoints.value = raw.map(e => ({ type: e.type as PeerEndpoint['type'], addr: e.addr, port: e.port }))
  } catch {
    endpoints.value = []
  }
})

watch(inviteLink, async (link) => {
  if (!link) { qrSvg.value = ''; return }
  try {
    qrSvg.value = await QRCode.toString(link, {
      type: 'svg',
      margin: 1,
      width: 140,
      errorCorrectionLevel: 'L',
    })
  } catch {
    qrSvg.value = ''
  }
})

async function generateNewLink() {
  if (!server.value) return
  const maxUses = maxUsesInput.value ? parseInt(maxUsesInput.value, 10) : null
  inviteToken.value = await serversStore.createInviteToken(server.value.id, {
    expiresInMs: selectedExpiry.value,
    maxUses,
  })
}

async function revokeCode(code: string) {
  await serversStore.revokeInviteCode(code)
  if (inviteToken.value === code) {
    inviteToken.value = ''
  }
}

async function copyLink() {
  try {
    await navigator.clipboard.writeText(inviteLink.value)
    copied.value = true
    setTimeout(() => { copied.value = false }, 2000)
  } catch {
    // clipboard not available
  }
}

function formatExpiry(expiresAt: string | null): string {
  if (!expiresAt) return 'Never'
  const ms = new Date(expiresAt).getTime() - Date.now()
  if (ms <= 0) return 'Expired'
  const hours = Math.floor(ms / 3_600_000)
  const days  = Math.floor(hours / 24)
  if (days >= 1) return `${days}d`
  return `${hours}h`
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
  width: 420px;
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

.qr-wrapper {
  display: flex;
  justify-content: center;
  background: white;
  border-radius: 8px;
  padding: var(--spacing-md);
}
.qr-wrapper :deep(svg) {
  width: 140px;
  height: 140px;
}

.field-label {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.04em;
  color: var(--text-secondary);
  display: block;
  margin-bottom: 4px;
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

/* Constraint controls */
.constraints-row {
  display: flex;
  gap: var(--spacing-md);
}

.constraint-field {
  flex: 1;
  display: flex;
  flex-direction: column;
}

.select-input {
  background: var(--bg-primary);
  border: 1px solid var(--border-color);
  border-radius: 4px;
  padding: 8px var(--spacing-md);
  color: var(--text-primary);
  font-size: 13px;
  outline: none;
  cursor: pointer;
}
.select-input:focus { border-color: var(--accent-color); }

.constraint-input {
  flex: none;
  width: 100%;
  padding: 8px var(--spacing-md);
}
.constraint-input:focus { border-color: var(--accent-color); }

.btn-generate {
  background: var(--bg-tertiary);
  border: 1px solid var(--border-color);
  border-radius: 4px;
  padding: 8px var(--spacing-md);
  color: var(--text-primary);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  text-align: center;
}
.btn-generate:hover { background: var(--bg-primary); }

/* Active codes list */
.codes-section {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.codes-toggle {
  background: none;
  border: none;
  padding: 0;
  color: var(--text-secondary);
  font-size: 12px;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 4px;
  text-align: left;
}
.codes-toggle:hover { color: var(--text-primary); }
.codes-toggle svg { transition: transform 0.15s; }

.codes-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.code-row {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  padding: 6px 8px;
  background: var(--bg-primary);
  border-radius: 4px;
  font-size: 12px;
}

.code-slug {
  font-family: monospace;
  color: var(--text-primary);
  flex: 1;
}

.code-uses, .code-expiry {
  color: var(--text-secondary);
  white-space: nowrap;
}

.btn-revoke {
  background: none;
  border: 1px solid var(--error-color, #f04747);
  border-radius: 3px;
  color: var(--error-color, #f04747);
  font-size: 11px;
  padding: 2px 6px;
  cursor: pointer;
}
.btn-revoke:hover { background: var(--error-color, #f04747); color: white; }

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
