import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import { v7 as uuidv7 } from 'uuid'
import type { Device } from '@/types/core'
import { cryptoService } from '@/services/cryptoService'

const LINK_TOKEN_EXPIRY_MS = 5 * 60 * 1000 // 5 minutes

export const useDevicesStore = defineStore('devices', () => {
  // This device's own identity
  const deviceId        = ref<string | null>(null)
  const deviceSignKey   = ref<string | null>(null)  // public, for sharing
  const deviceDHKey     = ref<string | null>(null)  // public, for sharing

  // Cache of peer's attested devices: userId → Device[]
  const peerDevices = ref<Record<string, Device[]>>({})

  // Pending inbound link request from a new device
  const pendingLinkRequest = ref<{
    deviceId:      string
    publicSignKey: string
    publicDHKey:   string
    displayName:   string
  } | null>(null)

  // Active outbound link token (for showing QR)
  const activeLinkToken = ref<string | null>(null)
  let linkTokenExpiry = 0

  // ── Initialise ──────────────────────────────────────────────────────────────

  async function initDeviceIdentity(userId: string) {
    const existingDeviceId      = await invoke<string | null>('db_load_key', { keyId: 'local_device_id' })
    const existingDeviceSignKey = await invoke<string | null>('db_load_key', { keyId: 'local_device_sign_secret' })
    const existingDeviceDHKey   = await invoke<string | null>('db_load_key', { keyId: 'local_device_dh_secret' })

    if (existingDeviceId && existingDeviceSignKey && existingDeviceDHKey) {
      await cryptoService.loadDeviceKeys(existingDeviceSignKey, existingDeviceDHKey)
      deviceId.value      = existingDeviceId
      deviceSignKey.value = cryptoService.getDevicePublicSignKey()
      deviceDHKey.value   = cryptoService.getDevicePublicDHKey()
    } else {
      // First launch on this device — generate device keys
      const newDeviceId = uuidv7()
      const keys = await cryptoService.generateDeviceKeys()

      await invoke('db_save_key', { keyId: 'local_device_id',           keyType: 'device_id',           keyData: newDeviceId })
      await invoke('db_save_key', { keyId: 'local_device_sign_secret',  keyType: 'device_sign_secret',  keyData: keys.deviceSignSecret })
      await invoke('db_save_key', { keyId: 'local_device_dh_secret',    keyType: 'device_dh_secret',    keyData: keys.deviceDHSecret })

      deviceId.value      = newDeviceId
      deviceSignKey.value = cryptoService.getDevicePublicSignKey()
      deviceDHKey.value   = cryptoService.getDevicePublicDHKey()

      // Persist our own device record (unattested; will be updated on link confirm)
      await invoke('db_save_device', {
        device: {
          device_id:       newDeviceId,
          user_id:         userId,
          public_sign_key: deviceSignKey.value,
          public_dh_key:   deviceDHKey.value,
          attested_by:     null,
          attestation_sig: null,
          revoked:         false,
          created_at:      new Date().toISOString(),
        },
      })
    }
  }

  // ── Outbound link token (Device A shows QR) ──────────────────────────────────

  function generateLinkToken(): string {
    const bytes = crypto.getRandomValues(new Uint8Array(32))
    const token = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')
    activeLinkToken.value = token
    linkTokenExpiry = Date.now() + LINK_TOKEN_EXPIRY_MS
    return token
  }

  function isLinkTokenValid(token: string): boolean {
    return !!activeLinkToken.value &&
      activeLinkToken.value === token &&
      Date.now() < linkTokenExpiry
  }

  function clearLinkToken() {
    activeLinkToken.value = null
    linkTokenExpiry = 0
  }

  // ── Confirm link (Device A confirms Device B's request) ────────────────────

  async function confirmLinkRequest(userId: string): Promise<Device | null> {
    if (!pendingLinkRequest.value) return null
    const req = pendingLinkRequest.value

    const attestationPayload = {
      userId,
      deviceId:      req.deviceId,
      publicSignKey: req.publicSignKey,
      publicDHKey:   req.publicDHKey,
      attestedBy:    deviceId.value,
      issuedAt:      new Date().toISOString(),
    }
    const sig = cryptoService.signAttestation(attestationPayload)

    const device: Device = {
      deviceId:        req.deviceId,
      userId,
      publicSignKey:   req.publicSignKey,
      publicDHKey:     req.publicDHKey,
      attestedBy:      deviceId.value!,
      attestationSig:  sig,
      revoked:         false,
      createdAt:       new Date().toISOString(),
    }

    await invoke('db_save_device', {
      device: {
        device_id:       device.deviceId,
        user_id:         device.userId,
        public_sign_key: device.publicSignKey,
        public_dh_key:   device.publicDHKey,
        attested_by:     device.attestedBy ?? null,
        attestation_sig: device.attestationSig ?? null,
        revoked:         false,
        created_at:      device.createdAt,
      },
    })

    if (!peerDevices.value[userId]) peerDevices.value[userId] = []
    const existing = peerDevices.value[userId].findIndex(d => d.deviceId === device.deviceId)
    if (existing >= 0) peerDevices.value[userId][existing] = device
    else peerDevices.value[userId].push(device)

    pendingLinkRequest.value = null
    clearLinkToken()
    return device
  }

  function rejectLinkRequest() {
    pendingLinkRequest.value = null
  }

  // ── Load peer devices ───────────────────────────────────────────────────────

  async function loadPeerDevices(userId: string): Promise<void> {
    const rows = await invoke<any[]>('db_load_devices', { userId })
    peerDevices.value[userId] = rows.map(r => ({
      deviceId:        r.device_id,
      userId:          r.user_id,
      publicSignKey:   r.public_sign_key,
      publicDHKey:     r.public_dh_key,
      attestedBy:      r.attested_by ?? undefined,
      attestationSig:  r.attestation_sig ?? undefined,
      revoked:         r.revoked !== 0,
      createdAt:       r.created_at,
    }))
  }

  // Called when we receive a device_attest wire message from a peer
  async function receiveAttestedDevice(device: Device): Promise<void> {
    await invoke('db_save_device', {
      device: {
        device_id:       device.deviceId,
        user_id:         device.userId,
        public_sign_key: device.publicSignKey,
        public_dh_key:   device.publicDHKey,
        attested_by:     device.attestedBy ?? null,
        attestation_sig: device.attestationSig ?? null,
        revoked:         device.revoked ? 1 : 0,
        created_at:      device.createdAt,
      },
    })
    if (!peerDevices.value[device.userId]) peerDevices.value[device.userId] = []
    const idx = peerDevices.value[device.userId].findIndex(d => d.deviceId === device.deviceId)
    if (idx >= 0) peerDevices.value[device.userId][idx] = device
    else peerDevices.value[device.userId].push(device)
  }

  async function revokeDevice(dId: string): Promise<void> {
    await invoke('db_revoke_device', { deviceId: dId })
    for (const userId of Object.keys(peerDevices.value)) {
      const d = peerDevices.value[userId].find(x => x.deviceId === dId)
      if (d) d.revoked = true
    }
  }

  // ── Computed helpers ───────────────────────────────────────────────────────

  function getActiveDevices(userId: string): Device[] {
    return (peerDevices.value[userId] ?? []).filter(d => !d.revoked)
  }

  const hasPendingLinkRequest = computed(() => !!pendingLinkRequest.value)

  return {
    deviceId,
    deviceSignKey,
    deviceDHKey,
    peerDevices,
    pendingLinkRequest,
    activeLinkToken,
    hasPendingLinkRequest,
    initDeviceIdentity,
    generateLinkToken,
    isLinkTokenValid,
    clearLinkToken,
    confirmLinkRequest,
    rejectLinkRequest,
    loadPeerDevices,
    receiveAttestedDevice,
    revokeDevice,
    getActiveDevices,
  }
})
