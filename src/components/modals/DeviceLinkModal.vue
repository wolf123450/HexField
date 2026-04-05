<template>
  <Teleport to="body">
    <!-- ── QR display (Device A — showing link code) ───────────────────────── -->
    <div v-if="uiStore.showDeviceLinkModal" class="modal-backdrop" @click.self="closeQR">
      <div class="modal device-link-modal">
        <div class="modal-header">
          <AppIcon :path="mdiQrcode" :size="20" />
          <span>Link a new device</span>
          <button class="close-btn" @click="closeQR">
            <AppIcon :path="mdiClose" :size="16" />
          </button>
        </div>
        <div class="modal-body">
          <p class="hint">Scan this QR code from your other device running HexField.</p>
          <p class="hint expire-hint">Expires in {{ expiryCountdown }}</p>
          <div v-if="qrSvg" class="qr-wrap" v-html="qrSvg" />
          <div v-else class="qr-loading">Generating…</div>
        </div>
      </div>
    </div>

    <!-- ── Incoming link request (Device A — approval prompt) ─────────────── -->
    <div v-if="devicesStore.hasPendingLinkRequest" class="modal-backdrop">
      <div class="modal device-link-modal">
        <div class="modal-header">
          <AppIcon :path="mdiLinkVariant" :size="20" />
          <span>Link device?</span>
        </div>
        <div class="modal-body">
          <p class="hint">
            A new device wants to link to your account
            <strong>{{ identityStore.displayName }}</strong>.
          </p>
          <div class="device-info">
            <AppIcon :path="mdiLaptop" :size="32" class="device-icon" />
            <div>
              <div class="device-name">{{ devicesStore.pendingLinkRequest?.displayName || 'New Device' }}</div>
              <div class="device-key">{{ shortKey(devicesStore.pendingLinkRequest?.publicSignKey) }}</div>
            </div>
          </div>
          <p class="warning">Only confirm if you initiated this from your other device.</p>
        </div>
        <div class="modal-footer">
          <button class="btn-secondary" @click="rejectLink">Deny</button>
          <button class="btn-primary" @click="confirmLink">
            <AppIcon :path="mdiCheck" :size="16" />
            Link Device
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, watch, onUnmounted } from 'vue'
import QRCode from 'qrcode'
import { mdiQrcode, mdiClose, mdiLinkVariant, mdiLaptop, mdiCheck } from '@mdi/js'
import { useDevicesStore } from '@/stores/devicesStore'
import { useIdentityStore } from '@/stores/identityStore'
import { useUIStore } from '@/stores/uiStore'

const devicesStore  = useDevicesStore()
const identityStore = useIdentityStore()
const uiStore       = useUIStore()

const qrSvg           = ref<string | null>(null)
const expiryCountdown = ref('')
let countdownTimer: ReturnType<typeof setInterval> | null = null

// Auto-generate QR when modal opens
watch(() => uiStore.showDeviceLinkModal, async (open) => {
  if (open) await generateQR()
  else      cleanupQR()
})

function shortKey(key?: string | null): string {
  if (!key) return ''
  return key.slice(0, 8) + '…' + key.slice(-8)
}

async function generateQR() {
  const token = devicesStore.generateLinkToken()

  const payload = JSON.stringify({
    type:         'device_link',
    userId:       identityStore.userId,
    deviceId:     devicesStore.deviceId,
    publicSignKey: devicesStore.deviceSignKey,
    linkToken:    token,
  })

  qrSvg.value = await QRCode.toString(payload, { type: 'svg', margin: 2, width: 240 })
  startCountdown()
}

function startCountdown() {
  const EXPIRY = 5 * 60 * 1000
  const start  = Date.now()
  if (countdownTimer) clearInterval(countdownTimer)
  countdownTimer = setInterval(() => {
    const remaining = EXPIRY - (Date.now() - start)
    if (remaining <= 0) {
      expiryCountdown.value = 'Expired'
      closeQR()
    } else {
      const m = Math.floor(remaining / 60000)
      const s = Math.floor((remaining % 60000) / 1000)
      expiryCountdown.value = `${m}:${s.toString().padStart(2, '0')}`
    }
  }, 1000)
}

function closeQR() {
  uiStore.showDeviceLinkModal = false
  cleanupQR()
}

function cleanupQR() {
  qrSvg.value  = null
  devicesStore.clearLinkToken()
  if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null }
}

async function confirmLink() {
  const device = await devicesStore.confirmLinkRequest(identityStore.userId!)
  if (device) {
    // Broadcast attestation to all connected peers
    const { useNetworkStore } = await import('@/stores/networkStore')
    useNetworkStore().broadcast({
      type:          'device_attest',
      device:        {
        deviceId:        device.deviceId,
        userId:          device.userId,
        publicSignKey:   device.publicSignKey,
        publicDHKey:     device.publicDHKey,
        attestedBy:      device.attestedBy,
        attestationSig:  device.attestationSig,
        revoked:         device.revoked,
        createdAt:       device.createdAt,
      },
    })
    uiStore.showNotification('Device linked successfully', 'success')
  }
}

function rejectLink() {
  devicesStore.rejectLinkRequest()
}

onUnmounted(() => {
  if (countdownTimer) clearInterval(countdownTimer)
})
</script>

<style scoped>
.modal-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.device-link-modal {
  background: var(--bg-primary);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 8px;
  padding: 0;
  width: 340px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
  overflow: hidden;
}

.modal-header {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  padding: var(--spacing-md);
  border-bottom: 1px solid rgba(255, 255, 255, 0.07);
  color: var(--text-primary);
  font-weight: 600;
}

.modal-header .close-btn {
  margin-left: auto;
  padding: 0;
  background: none;
  border: none;
  cursor: pointer;
  color: var(--text-tertiary);
  display: flex;
  transform: none;
}

.modal-header .close-btn:hover {
  color: var(--text-primary);
  background: none;
  transform: none;
}

.modal-body {
  padding: var(--spacing-md);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--spacing-sm);
}

.hint {
  font-size: 13px;
  color: var(--text-secondary);
  text-align: center;
  margin: 0;
}

.expire-hint {
  color: var(--warning-color);
  font-weight: 600;
}

.qr-wrap {
  background: white;
  padding: 8px;
  border-radius: 6px;
}

.qr-wrap :deep(svg) {
  display: block;
  width: 200px;
  height: 200px;
}

.qr-loading {
  width: 200px;
  height: 200px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-tertiary);
  font-size: 13px;
}

.device-info {
  display: flex;
  align-items: center;
  gap: var(--spacing-md);
  background: var(--bg-secondary);
  border-radius: 6px;
  padding: var(--spacing-sm) var(--spacing-md);
  width: 100%;
}

.device-icon {
  color: var(--accent-color);
  flex-shrink: 0;
}

.device-name {
  font-weight: 600;
  font-size: 14px;
  color: var(--text-primary);
}

.device-key {
  font-size: 11px;
  color: var(--text-tertiary);
  font-family: monospace;
  margin-top: 2px;
}

.warning {
  font-size: 12px;
  color: var(--warning-color);
  text-align: center;
  margin: 0;
}

.modal-footer {
  display: flex;
  gap: var(--spacing-sm);
  justify-content: flex-end;
  padding: var(--spacing-sm) var(--spacing-md) var(--spacing-md);
  border-top: 1px solid rgba(255, 255, 255, 0.07);
}

.btn-primary {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 0 var(--spacing-md);
  height: 34px;
  background: var(--accent-color);
  color: white;
  border: none;
  border-radius: var(--radius-md);
  cursor: pointer;
  font-size: 14px;
  font-weight: 500;
  transform: none;
}

.btn-primary:hover {
  background: var(--accent-hover);
  transform: none;
}

.btn-secondary {
  display: inline-flex;
  align-items: center;
  height: 34px;
  padding: 0 var(--spacing-md);
  background: var(--bg-secondary);
  color: var(--text-secondary);
  border: none;
  border-radius: var(--radius-md);
  cursor: pointer;
  font-size: 14px;
  transform: none;
}

.btn-secondary:hover {
  background: var(--bg-tertiary);
  color: var(--text-primary);
  transform: none;
}
</style>
