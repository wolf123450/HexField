<template>
  <div class="settings-section">
    <h3>Privacy</h3>

    <div class="info-box">
      <h4>How message deletion works</h4>
      <p>
        When you delete a message, GameChat immediately erases the message content on your device
        and sends a delete notice to all currently online members. Each member's app erases the
        content from their device when they receive the notice. Members who are offline will have
        the content erased the next time they connect.
      </p>
      <p>
        Because GameChat is peer-to-peer, deleted content cannot be recovered from any GameChat
        server — there isn't one. However, peers who received your message before the delete notice
        arrived may retain a copy if they are running a modified version of the app. GameChat makes
        a good-faith effort to delete content on all connected devices but cannot guarantee deletion
        on non-standard clients.
      </p>
    </div>

    <div class="form-row">
      <label class="checkbox-row">
        <input v-model="showDeleted" type="checkbox" @change="saveShowDeleted" />
        <span>Show "message deleted" placeholder</span>
      </label>
      <p class="form-hint">Default: off. Shows a subtle indicator where deleted messages were.</p>
    </div>

    <div class="form-row">
      <label class="checkbox-row">
        <input v-model="confirmDelete" type="checkbox" @change="saveConfirmDelete" />
        <span>Confirm before deleting a message</span>
      </label>
    </div>

    <div class="form-row">
      <label class="form-label">Storage Limit</label>
      <div class="storage-row">
        <input
          v-model.number="storageLimit"
          type="range"
          min="1"
          max="10"
          step="1"
          class="storage-slider"
          @input="saveStorageLimit"
        />
        <span class="storage-value">{{ storageLimit }} GB</span>
      </div>
      <div class="storage-usage-row">
        <span class="storage-usage-label">Used: <strong>{{ usedDisplay }}</strong></span>
        <button class="btn-enforce" :disabled="enforcing" @click="enforceNow">
          {{ enforcing ? 'Pruning…' : 'Free Space Now' }}
        </button>
      </div>
      <p class="form-hint">Maximum local storage for message attachments. Oldest files are removed first when the limit is reached.</p>
    </div>

    <!-- ── Passphrase Protection ─────────────────────────────────── -->
    <div class="form-row">
      <label class="form-label">Key Protection</label>
      <p class="form-hint" style="margin-bottom: var(--spacing-sm)">
        Wrap your cryptographic identity with a passphrase using Argon2id + XSalsa20-Poly1305.
        Without the passphrase, keys on disk cannot be decrypted — even by someone with access to your device storage.
      </p>

      <div v-if="!identityStore.passphraseProtected" class="passphrase-box">
        <p class="passphrase-status passphrase-off">Keys stored without passphrase</p>
        <div class="passphrase-inputs">
          <input v-model="newPassphrase"     type="password" placeholder="New passphrase"     class="form-input passphrase-field" autocomplete="new-password" />
          <input v-model="confirmPassphrase" type="password" placeholder="Confirm passphrase" class="form-input passphrase-field" autocomplete="new-password" />
        </div>
        <p v-if="passphraseError" class="passphrase-error">{{ passphraseError }}</p>
        <button class="btn-set-passphrase" :disabled="settingPassphrase" @click="doSetPassphrase">
          {{ settingPassphrase ? 'Encrypting…' : 'Enable Passphrase Protection' }}
        </button>
      </div>

      <div v-else class="passphrase-box">
        <p class="passphrase-status passphrase-on">Keys protected with passphrase</p>
        <input v-model="currentPassphrase" type="password" placeholder="Current passphrase to disable" class="form-input passphrase-field" autocomplete="current-password" />
        <p v-if="passphraseError" class="passphrase-error">{{ passphraseError }}</p>
        <button class="btn-remove-passphrase" :disabled="removingPassphrase" @click="doRemovePassphrase">
          {{ removingPassphrase ? 'Removing…' : 'Disable Passphrase Protection' }}
        </button>
      </div>
    </div>

    <!-- ── OS Keychain ──────────────────────────────────────────── -->
    <div class="form-row">
      <label class="form-label">OS Keychain</label>
      <p class="form-hint" style="margin-bottom: var(--spacing-sm)">
        Store your identity keys in the OS-native credential store (Windows Credential Manager /
        macOS Keychain / libsecret). Keys are never written to disk — only a sentinel
        reference is kept in the database.
      </p>

      <div v-if="!identityStore.keychainProtected" class="passphrase-box">
        <p class="passphrase-status passphrase-off">Keys not stored in OS keychain</p>
        <p v-if="identityStore.passphraseProtected" class="passphrase-error" style="margin-bottom: var(--spacing-xs)">
          Disable passphrase protection first before enabling OS keychain.
        </p>
        <p v-if="keychainError" class="passphrase-error">{{ keychainError }}</p>
        <button
          class="btn-set-passphrase"
          :disabled="savingToKeychain || identityStore.passphraseProtected"
          @click="doSaveToKeychain"
        >
          {{ savingToKeychain ? 'Saving…' : 'Store in OS Keychain' }}
        </button>
      </div>

      <div v-else class="passphrase-box">
        <p class="passphrase-status passphrase-on">Keys stored in OS keychain</p>
        <p v-if="keychainError" class="passphrase-error">{{ keychainError }}</p>
        <button class="btn-remove-passphrase" :disabled="removingFromKeychain" @click="doRemoveFromKeychain">
          {{ removingFromKeychain ? 'Removing…' : 'Remove from OS Keychain' }}
        </button>
      </div>
    </div>

    <!-- ── Identity Export / Import ─────────────────────────────────── -->
    <div class="form-row">
      <label class="form-label">Identity Backup</label>
      <p class="form-hint" style="margin-bottom: var(--spacing-sm)">
        Export your cryptographic identity to a file so you can restore it on a new device.
        Keep this file secret — anyone with it can impersonate you.
      </p>
      <div class="identity-actions">
        <button class="btn-export" @click="doExport">Export Identity…</button>
        <label class="btn-import">
          Import Identity…
          <input type="file" accept=".json,application/json" style="display:none" @change="doImport" />
        </label>
      </div>
    </div>

    <!-- ── Linked Devices ──────────────────────────────────────────── -->
    <div class="devices-section">
      <div class="devices-header">
        <label class="form-label" style="margin: 0">Linked Devices</label>
        <button class="btn-link-device" @click="openLinkModal">
          <AppIcon :path="mdiQrcode" :size="16" />
          Link New Device
        </button>
      </div>
      <p class="form-hint" style="margin-bottom: var(--spacing-sm)">
        Other devices running GameChat that have been linked to your account.
      </p>

      <div v-if="ownDevices.length === 0" class="no-devices">
        No other linked devices yet.
      </div>
      <div v-else class="device-list">
        <div v-for="device in ownDevices" :key="device.deviceId" class="device-row">
          <AppIcon :path="mdiLaptop" :size="20" class="device-icon" />
          <div class="device-meta">
            <div class="device-id">{{ shortId(device.deviceId) }}</div>
            <div class="device-key">{{ shortKey(device.publicSignKey) }}</div>
          </div>
          <button class="btn-revoke" @click="revoke(device.deviceId)">
            <AppIcon :path="mdiLinkOff" :size="14" />
            Revoke
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { mdiQrcode, mdiLaptop, mdiLinkOff } from '@mdi/js'
import { invoke } from '@tauri-apps/api/core'
import { useIdentityStore } from '@/stores/identityStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { useDevicesStore } from '@/stores/devicesStore'
import { useUIStore } from '@/stores/uiStore'

const settingsStore = useSettingsStore()
const devicesStore  = useDevicesStore()
const identityStore = useIdentityStore()
const uiStore       = useUIStore()

const showDeleted   = ref(settingsStore.settings.showDeletedMessagePlaceholder)
const confirmDelete = ref(settingsStore.settings.confirmBeforeDelete)
const storageLimit  = ref(settingsStore.settings.storageLimitGB)
const usedBytes     = ref<number>(0)
const enforcing     = ref(false)

const usedDisplay = computed(() => {
  const b = usedBytes.value
  if (b < 1024) return `${b} B`
  if (b < 1_048_576) return `${(b / 1024).toFixed(1)} KB`
  if (b < 1_073_741_824) return `${(b / 1_048_576).toFixed(1)} MB`
  return `${(b / 1_073_741_824).toFixed(2)} GB`
})

async function refreshUsage() {
  try { usedBytes.value = await invoke<number>('get_attachment_storage_bytes') } catch { /* no attachments yet */ }
}

async function enforceNow() {
  enforcing.value = true
  try {
    await invoke('enforce_storage_limit', { limitGb: storageLimit.value })
    await refreshUsage()
  } finally {
    enforcing.value = false
  }
}

function saveShowDeleted()   { settingsStore.updateSetting('showDeletedMessagePlaceholder', showDeleted.value) }
function saveConfirmDelete() { settingsStore.updateSetting('confirmBeforeDelete', confirmDelete.value) }
function saveStorageLimit()  { settingsStore.updateSetting('storageLimitGB', storageLimit.value) }

// Device management
const ownDevices = computed(() =>
  devicesStore.getActiveDevices(identityStore.userId!).filter(
    d => d.deviceId !== devicesStore.deviceId,
  )
)

function shortId(id: string): string {
  return id.slice(0, 8)
}
function shortKey(key: string): string {
  return key.slice(0, 8) + '…' + key.slice(-8)
}

onMounted(async () => {
  await refreshUsage()
  if (identityStore.userId) {
    await devicesStore.loadPeerDevices(identityStore.userId)
  }
})

async function revoke(deviceId: string) {
  await devicesStore.revokeDevice(deviceId)
  // Broadcast revocation mutation to peers
  const { useNetworkStore } = await import('@/stores/networkStore')
  useNetworkStore().broadcast({
    type:     'mutation',
    mutation: {
      id:        crypto.randomUUID(),
      type:      'device_revoke',
      targetId:  deviceId,
      channelId: '',
      authorId:  identityStore.userId,
      logicalTs: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    },
  })
}

function openLinkModal() {
  uiStore.openDeviceLinkModal()
}

async function doExport() {
  try {
    const json = await identityStore.exportIdentity()
    const blob = new Blob([json], { type: 'application/json' })
    const url  = URL.createObjectURL(blob)
    const a    = document.createElement('a')
    a.href     = url
    a.download = `gamechat-identity-${identityStore.userId?.slice(0, 8)}.json`
    a.click()
    URL.revokeObjectURL(url)
  } catch (e: unknown) {
    alert(e instanceof Error ? e.message : 'Export failed.')
  }
}

async function doImport(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0]
  if (!file) return
  const confirmed = confirm(
    'Importing an identity will replace your current account on this device.\n\n' +
    'Proceed? This cannot be undone without another backup.',
  )
  if (!confirmed) return
  try {
    const text = await file.text()
    await identityStore.importIdentity(text)
    alert('Identity imported. The app will now reload.')
    window.location.reload()
  } catch (err: unknown) {
    alert(err instanceof Error ? err.message : 'Import failed — invalid identity file.')
  }
}

// ── Passphrase protection ─────────────────────────────────────────────────
const newPassphrase     = ref('')
const confirmPassphrase = ref('')
const currentPassphrase = ref('')
const passphraseError   = ref('')
const settingPassphrase  = ref(false)
const removingPassphrase = ref(false)

async function doSetPassphrase() {
  passphraseError.value = ''
  if (!newPassphrase.value) { passphraseError.value = 'Passphrase cannot be empty.'; return }
  if (newPassphrase.value !== confirmPassphrase.value) { passphraseError.value = 'Passphrases do not match.'; return }
  settingPassphrase.value = true
  try {
    await identityStore.setPassphrase(newPassphrase.value)
    newPassphrase.value = ''
    confirmPassphrase.value = ''
    uiStore.showNotification('Passphrase protection enabled.', 'success')
  } catch (e: unknown) {
    passphraseError.value = e instanceof Error ? e.message : 'Failed to set passphrase.'
  } finally {
    settingPassphrase.value = false
  }
}

async function doRemovePassphrase() {
  passphraseError.value = ''
  if (!currentPassphrase.value) { passphraseError.value = 'Enter current passphrase to disable.'; return }
  removingPassphrase.value = true
  try {
    const ok = await identityStore.unlockWithPassphrase(currentPassphrase.value)
    if (!ok) { passphraseError.value = 'Wrong passphrase.'; return }
    await identityStore.removePassphrase()
    currentPassphrase.value = ''
    uiStore.showNotification('Passphrase protection disabled.', 'info')
  } catch (e: unknown) {
    passphraseError.value = e instanceof Error ? e.message : 'Failed to remove passphrase.'
  } finally {
    removingPassphrase.value = false
  }
}

// ── OS Keychain ───────────────────────────────────────────────────────────
const keychainError       = ref('')
const savingToKeychain    = ref(false)
const removingFromKeychain = ref(false)

async function doSaveToKeychain() {
  keychainError.value = ''
  savingToKeychain.value = true
  try {
    await identityStore.saveToKeychain()
    uiStore.showNotification('Identity keys saved to OS keychain.', 'success')
  } catch (e: unknown) {
    keychainError.value = e instanceof Error ? e.message : 'Failed to save to keychain.'
  } finally {
    savingToKeychain.value = false
  }
}

async function doRemoveFromKeychain() {
  keychainError.value = ''
  removingFromKeychain.value = true
  try {
    await identityStore.removeFromKeychain()
    uiStore.showNotification('Keys moved back to local database.', 'info')
  } catch (e: unknown) {
    keychainError.value = e instanceof Error ? e.message : 'Failed to remove from keychain.'
  } finally {
    removingFromKeychain.value = false
  }
}
</script>

<style scoped>
.settings-section h3 { margin-bottom: var(--spacing-lg); }
.form-row { margin-bottom: var(--spacing-lg); }
.form-label { display: block; font-size: 12px; font-weight: 600; color: var(--text-secondary); margin-bottom: var(--spacing-xs); text-transform: uppercase; letter-spacing: 0.04em; }
.form-hint { font-size: 11px; color: var(--text-tertiary); margin-top: var(--spacing-xs); }

.info-box {
  background: var(--bg-primary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  padding: var(--spacing-md);
  margin-bottom: var(--spacing-xl);
}
.info-box h4 { font-size: 13px; margin-bottom: var(--spacing-sm); color: var(--text-primary); }
.info-box p { font-size: 12px; color: var(--text-secondary); line-height: 1.6; margin-bottom: var(--spacing-sm); }
.info-box p:last-child { margin-bottom: 0; }

.checkbox-row {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  font-size: 14px;
  color: var(--text-primary);
  cursor: pointer;
}

.storage-row {
  display: flex;
  align-items: center;
  gap: var(--spacing-md);
}
.storage-slider { flex: 1; }
.storage-value { font-size: 14px; font-weight: 600; color: var(--text-primary); min-width: 40px; }

.storage-usage-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: var(--spacing-sm);
}

.storage-usage-label { font-size: 13px; color: var(--text-secondary); }

.btn-enforce {
  background: var(--bg-tertiary);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  padding: 4px 12px;
  font-size: 12px;
  color: var(--text-secondary);
  cursor: pointer;
  transform: none;
}
.btn-enforce:hover:not(:disabled) { color: var(--text-primary); background: var(--bg-primary); }
.btn-enforce:disabled { opacity: 0.5; cursor: not-allowed; }

.identity-actions {
  display: flex;
  gap: var(--spacing-sm);
  flex-wrap: wrap;
}

.btn-export, .btn-import {
  background: var(--bg-tertiary);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  padding: 6px 14px;
  font-size: 13px;
  color: var(--text-secondary);
  cursor: pointer;
  transform: none;
  display: inline-flex;
  align-items: center;
}
.btn-export:hover, .btn-import:hover { color: var(--text-primary); background: var(--bg-primary); }

/* Passphrase protection */
.passphrase-box { background: var(--bg-primary); border: 1px solid var(--border-color); border-radius: var(--radius-sm); padding: var(--spacing-md); }
.passphrase-status { font-size: 13px; font-weight: 600; margin-bottom: var(--spacing-sm); }
.passphrase-on  { color: var(--success-color); }
.passphrase-off { color: var(--text-secondary); }
.passphrase-inputs { display: flex; flex-direction: column; gap: var(--spacing-xs); margin-bottom: var(--spacing-sm); }
.passphrase-field { margin-bottom: var(--spacing-xs); }
.passphrase-error { font-size: 12px; color: var(--error-color); margin-bottom: var(--spacing-xs); }
.btn-set-passphrase, .btn-remove-passphrase { padding: 6px var(--spacing-md); border: none; border-radius: var(--radius-sm); cursor: pointer; font-size: 13px; font-weight: 600; transform: none; }
.btn-set-passphrase    { background: var(--accent-color); color: #fff; }
.btn-set-passphrase:hover    { background: var(--accent-hover); }
.btn-remove-passphrase { background: var(--bg-secondary); color: var(--text-primary); }
.btn-remove-passphrase:hover { background: var(--bg-tertiary); }
.btn-set-passphrase:disabled, .btn-remove-passphrase:disabled { opacity: 0.5; cursor: not-allowed; }
</style>
