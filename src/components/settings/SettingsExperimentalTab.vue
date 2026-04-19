<template>
  <div class="tab-content experimental-tab">
    <div class="info-box warning">
      <p>
        These features are experimental and may impact performance or stability.
        They can be toggled freely — changes take effect the next time you start a screen share.
      </p>
    </div>

    <div class="setting-row">
      <label class="checkbox-row">
        <input v-model="newPipeline" type="checkbox" @change="saveNewPipeline" />
        <span>New capture pipeline</span>
      </label>
      <p class="setting-hint">
        Uses the threaded encoder pipeline with fused YUV conversion.
        More efficient at high resolutions. Default: on.
      </p>
    </div>

    <div class="setting-row" :class="{ disabled: !newPipeline }">
      <label class="checkbox-row">
        <input v-model="dualEncoding" type="checkbox" :disabled="!newPipeline" @change="saveDualEncoding" />
        <span>Dual encoding (720p + 1080p)</span>
      </label>
      <p class="setting-hint">
        Encodes screen share at both 720p and 1080p simultaneously for adaptive quality.
        Requires the new capture pipeline. Increases CPU usage significantly. Default: off.
      </p>
    </div>

    <div class="setting-row">
      <label class="checkbox-row">
        <input v-model="inlinePreview" type="checkbox" @change="saveInlinePreview" />
        <span>Inline preview (base64)</span>
      </label>
      <p class="setting-hint">
        Sends screen share preview frames as inline base64 data URLs instead of writing temporary
        JPEG files to disk. Reduces disk I/O but uses more memory. Default: on.
      </p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { useSettingsStore } from '@/stores/settingsStore'

const settingsStore = useSettingsStore()

const newPipeline = ref(settingsStore.settings.experimentalNewPipeline)
const dualEncoding = ref(settingsStore.settings.experimentalDualEncoding)
const inlinePreview = ref(settingsStore.settings.experimentalInlinePreview)

function saveNewPipeline() {
  settingsStore.updateSetting('experimentalNewPipeline', newPipeline.value)
  if (!newPipeline.value && dualEncoding.value) {
    dualEncoding.value = false
    settingsStore.updateSetting('experimentalDualEncoding', false)
  }
}
function saveDualEncoding() {
  settingsStore.updateSetting('experimentalDualEncoding', dualEncoding.value)
}
function saveInlinePreview() {
  settingsStore.updateSetting('experimentalInlinePreview', inlinePreview.value)
}
</script>

<style scoped>
@import './settingsStyles.css';

.experimental-tab {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-lg);
}
.info-box {
  background: var(--bg-tertiary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  padding: var(--spacing-md);
  font-size: 12px;
  color: var(--text-secondary);
  line-height: 1.5;
}
.info-box.warning {
  border-color: var(--warning-color);
}
.checkbox-row {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  font-size: 13px;
  color: var(--text-primary);
  cursor: pointer;
}
.checkbox-row input[type="checkbox"] {
  accent-color: var(--accent-color);
}
.setting-row.disabled {
  opacity: 0.5;
}
.setting-row.disabled .checkbox-row {
  cursor: not-allowed;
}
</style>
