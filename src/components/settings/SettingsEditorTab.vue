<template>
  <div class="tab-content">
    <div class="setting-row">
      <label class="setting-label">
        Font size
        <span class="setting-value">{{ settings.fontSize }}px</span>
      </label>
      <div class="setting-control range-row">
        <span class="range-min">10</span>
        <input
          type="range" min="10" max="24" step="1"
          :value="settings.fontSize"
          @input="update('fontSize', Number(($event.target as HTMLInputElement).value))"
        />
        <span class="range-max">24</span>
      </div>
    </div>

    <div class="setting-row">
      <label class="setting-label">Font family</label>
      <div class="setting-control">
        <select
          :value="settings.fontFamily"
          @change="update('fontFamily', ($event.target as HTMLSelectElement).value)"
          class="setting-select"
        >
          <option v-for="f in fontFamilies" :key="f.value" :value="f.value">{{ f.label }}</option>
        </select>
      </div>
    </div>

    <div class="setting-row">
      <label class="setting-label">
        Line height
        <span class="setting-value">{{ settings.lineHeight }}</span>
      </label>
      <div class="setting-control range-row">
        <span class="range-min">1.2</span>
        <input
          type="range" min="1.2" max="2.4" step="0.1"
          :value="settings.lineHeight"
          @input="update('lineHeight', Number(($event.target as HTMLInputElement).value))"
        />
        <span class="range-max">2.4</span>
      </div>
    </div>

    <div class="setting-row">
      <label class="setting-label">Tab width</label>
      <div class="setting-control">
        <div class="pill-group">
          <button
            v-for="w in [2, 4]" :key="w"
            class="pill" :class="{ active: settings.tabWidth === w }"
            @click="update('tabWidth', w)"
          >{{ w }} spaces</button>
        </div>
      </div>
    </div>

    <div class="setting-row">
      <label class="setting-label">Spell check</label>
      <div class="setting-control">
        <div class="pill-group">
          <button class="pill" :class="{ active: settings.spellCheck }"  @click="update('spellCheck', true)">On</button>
          <button class="pill" :class="{ active: !settings.spellCheck }" @click="update('spellCheck', false)">Off</button>
        </div>
      </div>
    </div>

    <div class="setting-preview">
      <span class="preview-label">Preview</span>
      <div
        class="editor-preview-sample"
        :style="{ fontFamily: settings.fontFamily, fontSize: settings.fontSize + 'px', lineHeight: settings.lineHeight }"
      >The quick brown fox jumps over the lazy dog.</div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useSettingsStore } from '@/stores/settingsStore'

const settingsStore = useSettingsStore()
const settings = settingsStore.settings

const fontFamilies = [
  { label: 'Fira Code (default)', value: 'Fira Code, monospace' },
  { label: 'Courier New',         value: "'Courier New', monospace" },
  { label: 'JetBrains Mono',      value: "'JetBrains Mono', monospace" },
  { label: 'Consolas',            value: 'Consolas, monospace' },
  { label: 'Georgia (serif)',     value: 'Georgia, serif' },
  { label: 'System sans-serif',   value: 'system-ui, sans-serif' },
]

function update<K extends keyof typeof settings>(key: K, value: (typeof settings)[K]) {
  settingsStore.updateSetting(key, value)
}
</script>

<style scoped>
@import './settingsStyles.css';

.setting-preview {
  background: var(--bg-tertiary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  padding: var(--spacing-md);
}
.preview-label {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-tertiary);
  display: block;
  margin-bottom: var(--spacing-sm);
}
.editor-preview-sample {
  color: var(--text-primary);
  word-break: break-word;
}
</style>
