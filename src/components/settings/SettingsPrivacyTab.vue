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
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { useSettingsStore } from '@/stores/settingsStore'

const settingsStore = useSettingsStore()
const showDeleted   = ref(settingsStore.settings.showDeletedMessagePlaceholder)
const confirmDelete = ref(settingsStore.settings.confirmBeforeDelete)
const storageLimit  = ref(settingsStore.settings.storageLimitGB)

function saveShowDeleted()   { settingsStore.updateSetting('showDeletedMessagePlaceholder', showDeleted.value) }
function saveConfirmDelete() { settingsStore.updateSetting('confirmBeforeDelete', confirmDelete.value) }
function saveStorageLimit()  { settingsStore.updateSetting('storageLimitGB', storageLimit.value) }
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
