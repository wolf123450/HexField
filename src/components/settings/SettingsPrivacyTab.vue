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
      <p class="form-hint">Maximum local storage for messages and attachments. Old attachments are pruned first when the limit is reached.</p>
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
import { useSettingsStore } from '@/stores/settingsStore'
import { useDevicesStore } from '@/stores/devicesStore'
import { useIdentityStore } from '@/stores/identityStore'
import { useUIStore } from '@/stores/uiStore'

const settingsStore = useSettingsStore()
const devicesStore  = useDevicesStore()
const identityStore = useIdentityStore()
const uiStore       = useUIStore()

const showDeleted   = ref(settingsStore.settings.showDeletedMessagePlaceholder)
const confirmDelete = ref(settingsStore.settings.confirmBeforeDelete)
const storageLimit  = ref(settingsStore.settings.storageLimitGB)

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
</style>
