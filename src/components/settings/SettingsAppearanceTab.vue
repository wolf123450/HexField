<template>
  <div class="tab-content">
    <div class="setting-row">
      <label class="setting-label">Theme</label>
      <div class="setting-control">
        <div class="pill-group">
          <button
            class="pill" :class="{ active: settings.theme === 'dark' }"
            @click="setTheme('dark')"
          ><AppIcon :path="mdiWeatherNight" :size="14" style="vertical-align:middle;margin-right:5px" />Dark</button>
          <button
            class="pill" :class="{ active: settings.theme === 'light' }"
            @click="setTheme('light')"
          ><AppIcon :path="mdiWhiteBalanceSunny" :size="14" style="vertical-align:middle;margin-right:5px" />Light</button>
        </div>
      </div>
    </div>

    <div class="color-section">
      <div class="color-section-header">
        <span class="color-section-title">Custom colors <span class="color-theme-badge">{{ settings.theme }}</span></span>
        <button v-if="hasColorOverrides()" class="reset-colors-btn" @click="resetColors" title="Reset to theme defaults">Reset</button>
      </div>
      <div v-for="grp in colorGroups" :key="grp.group" class="color-group">
        <div class="color-group-label">{{ grp.group }}</div>
        <div class="color-grid">
          <div v-for="c in grp.items" :key="c.varName" class="color-row">
            <label class="color-label">{{ c.label }}</label>
            <div class="color-swatch-wrap">
              <input
                type="color"
                class="color-swatch"
                :value="getColorValue(c.varName)"
                @input="setColorValue(c.varName, ($event.target as HTMLInputElement).value)"
                :title="c.varName"
              />
              <span v-if="settings.themeColors?.[settings.theme]?.[c.varName]" class="color-override-dot" title="Customised"></span>
            </div>
          </div>
        </div>
      </div>
      <p class="setting-hint">Overrides apply to the currently selected theme only.</p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useSettingsStore, CUSTOMIZABLE_VARS, type CustomizableVar } from '@/stores/settingsStore'
import { useUIStore } from '@/stores/uiStore'
import { mdiWeatherNight, mdiWhiteBalanceSunny } from '@mdi/js'

const settingsStore = useSettingsStore()
const settings = settingsStore.settings
const uiStore = useUIStore()

function setTheme(theme: 'dark' | 'light') {
  settingsStore.updateSetting('theme', theme)
  uiStore.setTheme(theme)
}

const colorGroups: { group: string; items: { varName: CustomizableVar; label: string }[] }[] = [
  {
    group: 'Surfaces',
    items: [
      { varName: '--bg-primary',   label: 'Editor BG' },
      { varName: '--bg-secondary', label: 'Panel BG' },
      { varName: '--bg-tertiary',  label: 'Hover BG' },
    ],
  },
  {
    group: 'Text',
    items: [
      { varName: '--text-primary',   label: 'Primary' },
      { varName: '--text-secondary', label: 'Muted' },
      { varName: '--text-tertiary',  label: 'Faint' },
    ],
  },
  {
    group: 'UI Chrome',
    items: [
      { varName: '--border-color', label: 'Border' },
      { varName: '--accent-color', label: 'Accent' },
      { varName: '--accent-hover', label: 'Accent hover' },
    ],
  },
  {
    group: 'Semantic',
    items: [
      { varName: '--success-color', label: 'Success' },
      { varName: '--error-color',   label: 'Error' },
      { varName: '--warning-color', label: 'Warning' },
    ],
  },
]

function getColorValue(varName: CustomizableVar): string {
  const override = settings.themeColors?.[settings.theme]?.[varName]
  if (override) return override
  return getComputedStyle(document.documentElement).getPropertyValue(varName).trim()
}

function setColorValue(varName: CustomizableVar, value: string) {
  settingsStore.updateThemeColor(settings.theme, varName, value)
}

function hasColorOverrides(): boolean {
  const overrides = settings.themeColors?.[settings.theme] ?? {}
  return CUSTOMIZABLE_VARS.some(v => !!overrides[v])
}

function resetColors() {
  settingsStore.resetThemeColors(settings.theme)
}
</script>

<style scoped>
@import './settingsStyles.css';

.color-section { margin-top: 14px; padding-top: 14px; border-top: 1px solid var(--border-color); }
.color-section-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
.color-section-title {
  font-size: 12px; font-weight: 600; color: var(--text-secondary);
  text-transform: uppercase; letter-spacing: 0.06em;
  display: flex; align-items: center; gap: 6px;
}
.color-theme-badge {
  font-size: 10px; font-weight: 500; text-transform: none; letter-spacing: 0;
  background: color-mix(in srgb, var(--accent-color) 15%, transparent);
  color: var(--accent-color); border-radius: 3px; padding: 1px 5px;
}
.reset-colors-btn {
  background: none; border: 1px solid var(--border-color); border-radius: 4px;
  color: var(--text-secondary); font-size: 11px; cursor: pointer; padding: 2px 8px;
  transition: color 0.15s, border-color 0.15s;
}
.reset-colors-btn:hover { color: var(--error-color); border-color: var(--error-color); }
.color-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(52px, 1fr)); gap: 8px; }
.color-group { margin-bottom: 10px; }
.color-group:last-child { margin-bottom: 0; }
.color-group-label {
  font-size: 10px; font-weight: 700; text-transform: uppercase;
  letter-spacing: 0.06em; color: var(--text-tertiary); margin-bottom: 6px;
}
.color-row { display: flex; flex-direction: column; align-items: center; gap: 5px; }
.color-label { font-size: 10px; color: var(--text-secondary); text-align: center; white-space: nowrap; }
.color-swatch-wrap { position: relative; display: inline-flex; }
.color-swatch { width: 36px; height: 28px; border: 1px solid var(--border-color); border-radius: 5px; cursor: pointer; padding: 2px; background: none; }
.color-swatch::-webkit-color-swatch-wrapper { padding: 0; }
.color-swatch::-webkit-color-swatch { border-radius: 3px; border: none; }
.color-override-dot {
  position: absolute; top: -3px; right: -3px; width: 7px; height: 7px;
  background: var(--accent-color); border-radius: 50%; pointer-events: none;
}
</style>
