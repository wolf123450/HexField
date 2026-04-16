import { defineStore } from "pinia";
import { ref, watch } from "vue";
import { logger, type LogLevel } from "@/utils/logger";
import { APP_STORAGE_PREFIX } from "@/appConfig";
import type { ServerNotificationPrefs, ChannelNotificationPrefs, KeywordFilter, SoundEvent } from '@/types/core'

export const CUSTOMIZABLE_VARS = [
  // Surfaces
  '--bg-primary',
  '--bg-secondary',
  '--bg-tertiary',
  // Text
  '--text-primary',
  '--text-secondary',
  '--text-tertiary',
  // UI chrome
  '--border-color',
  '--accent-color',
  '--accent-hover',
  // Semantic
  '--success-color',
  '--error-color',
  '--warning-color',
  // Status badges
  '--status-draft-bg',
  '--status-draft-fg',
  '--status-progress-bg',
  '--status-progress-fg',
  '--status-complete-bg',
  '--status-complete-fg',
] as const

export type CustomizableVar = typeof CUSTOMIZABLE_VARS[number]

export type ThemeColorOverrides = {
  dark:  Partial<Record<CustomizableVar, string>>
  light: Partial<Record<CustomizableVar, string>>
}

export interface UserSettings {
  theme: "dark" | "light";
  fontSize: number;
  fontFamily: string;
  lineHeight: number;
  tabWidth: number;
  spellCheck: boolean;
  autoSaveInterval: number;
  keyboardShortcuts: Record<string, string>;
  themeColors: ThemeColorOverrides;
  // Privacy
  showDeletedMessagePlaceholder: boolean;
  confirmBeforeDelete: boolean;
  storageLimitGB: number;
  // Voice
  inputDeviceId: string;
  outputDeviceId: string;
  pushToTalkKey: string | null;
  noiseSuppression: boolean;
  customTURNServers: RTCIceServer[];
  // Video quality (screen share)
  videoQuality: 'auto' | '360p' | '720p' | '1080p';
  videoBitrate: 'auto' | '500kbps' | '1mbps' | '2.5mbps' | '5mbps' | '10mbps';
  videoFrameRate: 10 | 15 | 30 | 60;
  videoDownscaleMethod: 'nearest' | 'bilinear' | 'bicubic' | 'lanczos3';
  // Network
  rendezvousServerUrl: string;
  userDiscoverability: 'public' | 'private';
  soundEnabled: boolean;
  notificationsEnabled: boolean;
  // Per-server / channel notification rules
  serverNotificationPrefs:  Record<string, ServerNotificationPrefs>;
  channelNotificationPrefs: Record<string, ChannelNotificationPrefs>;
  keywordFilters:           KeywordFilter[];
  // Per-event custom sound overrides (data: URLs)
  customSounds:             Partial<Record<SoundEvent, string>>;
  // Developer
  logLevel:                 LogLevel;
}

const STORAGE_KEY = APP_STORAGE_PREFIX + 'settings'

function detectOSTheme(): 'dark' | 'light' {
  try {
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
  } catch { return 'dark' }
}

const defaultSettings: UserSettings = {
  theme: detectOSTheme(),
  fontSize: 14,
  fontFamily: "system-ui, -apple-system, sans-serif",
  lineHeight: 1.5,
  tabWidth: 2,
  spellCheck: true,
  autoSaveInterval: 10000,
  keyboardShortcuts: {
    settings: "ctrl+,",
  },
  themeColors: { dark: {}, light: {} },
  // Privacy
  showDeletedMessagePlaceholder: false,
  confirmBeforeDelete: true,
  storageLimitGB: 5,
  // Voice
  inputDeviceId: '',
  outputDeviceId: '',
  pushToTalkKey: null,
  noiseSuppression: true,
  customTURNServers: [],
  // Video quality (screen share)
  videoQuality: 'auto',
  videoBitrate: 'auto',
  videoFrameRate: 60,
  videoDownscaleMethod: 'bilinear',
  // Network
  rendezvousServerUrl: '',
  userDiscoverability: 'public',
  soundEnabled: true,
  notificationsEnabled: true,
  serverNotificationPrefs:  {},
  channelNotificationPrefs: {},
  keywordFilters:           [],
  customSounds:             {},
  logLevel:                 'info',
};

function loadFromStorage(): UserSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw)
      if (typeof parsed === 'object' && parsed !== null && typeof parsed.theme === 'string') {
        return { ...defaultSettings, ...parsed }
      }
      logger.warn('Settings', 'Stored settings failed validation — using defaults')
    }
  } catch {}
  return { ...defaultSettings }
}

function applyCSSVars(s: UserSettings) {
  const root = document.documentElement
  root.style.setProperty('--editor-font-size', `${s.fontSize}px`)
  root.style.setProperty('--editor-line-height', String(s.lineHeight))
  root.style.setProperty('--editor-font-family', s.fontFamily)
  const overrides = s.themeColors?.[s.theme] ?? {}
  for (const v of CUSTOMIZABLE_VARS) {
    const val = overrides[v]
    if (val) {
      root.style.setProperty(v, val)
    } else {
      root.style.removeProperty(v)
    }
  }
}

export const useSettingsStore = defineStore("settings", () => {
  const settings = ref<UserSettings>(loadFromStorage());

  let _persistTimer: ReturnType<typeof setTimeout> | undefined
  watch(settings, (val) => {
    applyCSSVars(val)
    logger.level = val.logLevel
    if (_persistTimer !== undefined) clearTimeout(_persistTimer)
    _persistTimer = setTimeout(() => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(val))
    }, 300)
  }, { deep: true, immediate: true })

  const updateSetting = <K extends keyof UserSettings>(
    key: K,
    value: UserSettings[K]
  ) => {
    settings.value[key] = value;
  };

  const updateKeyboardShortcut = (action: string, shortcut: string) => {
    settings.value.keyboardShortcuts[action] = shortcut;
  };

  const updateThemeColor = (theme: 'dark' | 'light', varName: CustomizableVar, value: string) => {
    settings.value.themeColors[theme][varName] = value
  }

  const resetThemeColors = (theme: 'dark' | 'light') => {
    settings.value.themeColors[theme] = {}
  }

  const resetToDefaults = () => {
    settings.value = { ...defaultSettings, themeColors: { dark: {}, light: {} } };
  };

  const getSetting = <K extends keyof UserSettings>(key: K): UserSettings[K] => {
    return settings.value[key];
  };

  return {
    settings,
    updateSetting,
    updateKeyboardShortcut,
    updateThemeColor,
    resetThemeColors,
    resetToDefaults,
    getSetting,
  };
});
