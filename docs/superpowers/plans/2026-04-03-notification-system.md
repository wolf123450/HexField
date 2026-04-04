# Notification System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the broken single-boolean notification stub with a full system: OS notifications that actually fire in Tauri, per-server/channel/keyword rules, Web Audio synthesized sounds with user file overrides, and granular settings UI.

**Architecture:** A new `notificationStore` owns the rules engine (server/channel/keyword hierarchy) and dispatches to both `soundService` and the Tauri notification plugin. `soundService` is a standalone service with a `SoundBackend` interface — `SynthBackend` (Web Audio oscillators) is the default; users can override per-event with uploaded audio files. All existing callers (`messagesStore`, `networkStore` for voice) are updated to call `notificationStore.notify()`.

**Tech Stack:** Vue 3 + Pinia Setup Stores, Web Audio API (`AudioContext`, `OscillatorNode`), `@tauri-apps/plugin-notification`, `@tauri-apps/api/window` (`getCurrentWindow().isFocused()`), `@mdi/js` icons.

**Spec:** `docs/superpowers/specs/2026-04-03-notification-system-design.md`

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `src/types/core.ts` | Modify | Add `NotificationLevel`, `ServerNotificationPrefs`, `ChannelNotificationPrefs`, `KeywordFilter`, `SoundEvent` |
| `src/stores/settingsStore.ts` | Modify | Add 4 new `UserSettings` fields + defaults |
| `src/services/soundService.ts` | Create | `SoundBackend` interface, `SynthBackend` (Web Audio), file override logic |
| `src/stores/notificationStore.ts` | Create | `notify()` rules engine, OS dispatch, sound dispatch |
| `src/stores/messagesStore.ts` | Modify | Remove `maybeNotify()`, call `notificationStore.notify()` |
| `src/stores/networkStore.ts` | Modify | Add voice join/leave notifications in `handleVoiceJoin` / `handleVoiceLeave` |
| `src/components/settings/SettingsNotificationsTab.vue` | Rewrite | 4 sections: global, sounds, per-server, keywords |
| `src/components/layout/ChannelNotifPopover.vue` | Create | Inline per-channel level + mute popover |
| `src/components/layout/ChannelSidebar.vue` | Modify | Add "Notification settings" to channel context menu |
| `src/utils/contextMenuResolver.ts` | Modify | Channel notification menu item |
| `src/services/__tests__/soundService.test.ts` | Create | Synth fallback, file decode, clear |
| `src/stores/__tests__/notificationStore.test.ts` | Create | Full rules hierarchy tests |

---

## Task 1: Add shared types to `core.ts`

**Files:**
- Modify: `src/types/core.ts`

- [ ] **Step 1: Add the new types** — append this block at the end of `src/types/core.ts`:

```ts
// ── Notifications & Sounds ─────────────────────────────────────────────────

export type NotificationLevel = 'all' | 'mentions' | 'muted'

export interface ServerNotificationPrefs {
  level: NotificationLevel   // default treated as 'mentions' when absent
  muteUntil?: number         // epoch ms; absent or past = not muted
}

export interface ChannelNotificationPrefs {
  level: NotificationLevel | 'inherit'  // 'inherit' = defer to server setting
  muteUntil?: number
}

export interface KeywordFilter {
  id: string                 // UUID v7
  keyword: string            // case-insensitive substring match
  serverId?: string          // undefined = applies globally
}

export type SoundEvent = 'message' | 'mention' | 'join_self' | 'join_other' | 'leave'
```

- [ ] **Step 2: Verify build passes**

```
npm run build 2>&1 | Select-String "error TS"
```
Expected: no output (zero errors).

- [ ] **Step 3: Commit**

```
git add src/types/core.ts
git commit -m "feat(notif): add notification + sound types to core.ts"
```

---

## Task 2: Extend `UserSettings` with notification fields

**Files:**
- Modify: `src/stores/settingsStore.ts`

- [ ] **Step 1: Add imports** — the new types need to be imported at the top of `settingsStore.ts`. Change the existing import line (there is no types import yet, so add one):

Inside `src/stores/settingsStore.ts`, after the existing imports at the top, add:

```ts
import type { ServerNotificationPrefs, ChannelNotificationPrefs, KeywordFilter, SoundEvent } from '@/types/core'
```

- [ ] **Step 2: Add fields to the `UserSettings` interface** — find the `notificationsEnabled: boolean;` line and add the four new fields below it:

Old:
```ts
  soundEnabled: boolean;
  notificationsEnabled: boolean;
}
```

New:
```ts
  soundEnabled: boolean;
  notificationsEnabled: boolean;
  // Per-server / channel notification rules
  serverNotificationPrefs:  Record<string, ServerNotificationPrefs>;
  channelNotificationPrefs: Record<string, ChannelNotificationPrefs>;
  keywordFilters:           KeywordFilter[];
  // Per-event custom sound overrides (data: URLs)
  customSounds:             Partial<Record<SoundEvent, string>>;
}
```

- [ ] **Step 3: Add defaults** — find the `soundEnabled: true,` line in `defaultSettings` and add the four new default values below `notificationsEnabled`:

Old:
```ts
  soundEnabled: true,
  notificationsEnabled: true,
};
```

New:
```ts
  soundEnabled: true,
  notificationsEnabled: true,
  serverNotificationPrefs:  {},
  channelNotificationPrefs: {},
  keywordFilters:           [],
  customSounds:             {},
};
```

- [ ] **Step 4: Verify build passes**

```
npm run build 2>&1 | Select-String "error TS"
```
Expected: no output.

- [ ] **Step 5: Commit**

```
git add src/stores/settingsStore.ts
git commit -m "feat(notif): extend UserSettings with per-server/channel/keyword/sound fields"
```

---

## Task 3: Create `soundService.ts`

**Files:**
- Create: `src/services/soundService.ts`
- Create: `src/services/__tests__/soundService.test.ts`

This service lazily creates one shared `AudioContext`. `SynthBackend` generates each sound using Web Audio oscillator nodes. If a custom data URL is stored for an event, it decodes and plays that instead.

- [ ] **Step 1: Write the failing test first**

Create `src/services/__tests__/soundService.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock Web Audio API (not available in jsdom)
const mockDisconnect  = vi.fn()
const mockStart       = vi.fn()
const mockStop        = vi.fn()
const mockConnect     = vi.fn()
const mockSetValueAtTime = vi.fn()
const mockLinearRampToValueAtTime = vi.fn()
const mockExponentialRampToValueAtTime = vi.fn()

const createOscillator = () => ({
  type: 'sine' as OscillatorType,
  frequency: { value: 0, setValueAtTime: mockSetValueAtTime },
  connect:    mockConnect,
  disconnect: mockDisconnect,
  start:      mockStart,
  stop:       mockStop,
})

const createGain = () => ({
  gain: {
    value: 0,
    setValueAtTime:                mockSetValueAtTime,
    linearRampToValueAtTime:       mockLinearRampToValueAtTime,
    exponentialRampToValueAtTime:  mockExponentialRampToValueAtTime,
  },
  connect:    mockConnect,
  disconnect: mockDisconnect,
})

const mockDecodeAudioData = vi.fn()
const mockCreateBufferSource = vi.fn(() => ({
  buffer: null,
  connect:    mockConnect,
  disconnect: mockDisconnect,
  start:      mockStart,
}))

const mockAudioContext = {
  currentTime: 0,
  destination: {},
  state: 'running' as AudioContextState,
  resume: vi.fn().mockResolvedValue(undefined),
  createOscillator,
  createGain,
  decodeAudioData: mockDecodeAudioData,
  createBufferSource: mockCreateBufferSource,
}

vi.stubGlobal('AudioContext', vi.fn(() => mockAudioContext))

describe('soundService', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockAudioContext.state = 'running'
    // Re-import fresh instance each test to reset module state
    vi.resetModules()
  })

  it('play("message") calls start on an oscillator without throwing', async () => {
    const { soundService } = await import('../soundService')
    await expect(soundService.play('message')).resolves.not.toThrow()
    expect(mockStart).toHaveBeenCalled()
  })

  it('play("mention") calls start at least twice (two-tone chime)', async () => {
    const { soundService } = await import('../soundService')
    await soundService.play('mention')
    expect(mockStart.mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  it('setCustomSound stores the data URL and play() attempts decodeAudioData', async () => {
    mockDecodeAudioData.mockResolvedValue({} as AudioBuffer)
    mockCreateBufferSource.mockReturnValue({ buffer: null, connect: mockConnect, start: mockStart, disconnect: mockDisconnect })
    const { soundService } = await import('../soundService')
    soundService.setCustomSound('message', 'data:audio/ogg;base64,abc')
    await soundService.play('message')
    expect(mockDecodeAudioData).toHaveBeenCalled()
  })

  it('falls back to synth if decodeAudioData rejects', async () => {
    mockDecodeAudioData.mockRejectedValue(new Error('decode error'))
    const { soundService } = await import('../soundService')
    soundService.setCustomSound('message', 'data:audio/ogg;base64,bad')
    // Should not throw — falls back silently
    await expect(soundService.play('message')).resolves.not.toThrow()
    // Synth oscillator should fire instead
    expect(mockStart).toHaveBeenCalled()
  })

  it('clearCustomSound removes the override so synth is used', async () => {
    mockDecodeAudioData.mockResolvedValue({} as AudioBuffer)
    const { soundService } = await import('../soundService')
    soundService.setCustomSound('mention', 'data:audio/ogg;base64,abc')
    soundService.clearCustomSound('mention')
    await soundService.play('mention')
    // decodeAudioData should NOT be called after clear
    expect(mockDecodeAudioData).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run tests — expect failure**

```
npm run test -- --run src/services/__tests__/soundService.test.ts 2>&1 | Select-String "PASS|FAIL|error"
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `soundService.ts`**

Create `src/services/soundService.ts`:

```ts
import type { SoundEvent } from '@/types/core'

// ── Backend interface (MIDI backend will implement this) ───────────────────
interface SoundBackend {
  play(event: SoundEvent, ctx: AudioContext): Promise<void>
}

// ── Helpers ────────────────────────────────────────────────────────────────

function playTone(
  ctx:      AudioContext,
  freq:     number,
  type:     OscillatorType,
  startAt:  number,
  duration: number,
  peak:     number = 0.3,
): void {
  const osc  = ctx.createOscillator()
  const gain = ctx.createGain()
  osc.type              = type
  osc.frequency.value   = freq
  gain.gain.setValueAtTime(0, startAt)
  gain.gain.linearRampToValueAtTime(peak, startAt + 0.01)
  gain.gain.exponentialRampToValueAtTime(0.001, startAt + duration)
  osc.connect(gain)
  gain.connect(ctx.destination)
  osc.start(startAt)
  osc.stop(startAt + duration + 0.01)
}

// ── SynthBackend ───────────────────────────────────────────────────────────

const synthBackend: SoundBackend = {
  async play(event: SoundEvent, ctx: AudioContext): Promise<void> {
    const t = ctx.currentTime
    switch (event) {
      case 'message':
        // Soft sine ding at 880 Hz, ~160ms
        playTone(ctx, 880, 'sine', t, 0.16)
        break
      case 'mention':
        // Two-tone chime C5 (523) → E5 (659), 150ms each
        playTone(ctx, 523, 'triangle', t,        0.15)
        playTone(ctx, 659, 'triangle', t + 0.17, 0.15)
        break
      case 'join_self':
        // Ascending 3-note arp E4→G4→B4 (330→392→494), 100ms per note
        playTone(ctx, 330, 'sine', t,        0.10)
        playTone(ctx, 392, 'sine', t + 0.11, 0.10)
        playTone(ctx, 494, 'sine', t + 0.22, 0.10)
        break
      case 'join_other':
        // Single soft triangle blip at 660 Hz, ~160ms
        playTone(ctx, 660, 'triangle', t, 0.16, 0.2)
        break
      case 'leave':
        // Descending two-tone B4→G4 (494→392), 120ms each, softer
        playTone(ctx, 494, 'sine', t,        0.12, 0.2)
        playTone(ctx, 392, 'sine', t + 0.14, 0.12, 0.15)
        break
    }
  },
}

// ── soundService (module singleton) ───────────────────────────────────────

let _ctx:          AudioContext | null = null
const _overrides:  Partial<Record<SoundEvent, string>> = {}

function getCtx(): AudioContext {
  if (!_ctx) _ctx = new AudioContext()
  return _ctx
}

async function playWithFileOverride(event: SoundEvent, ctx: AudioContext): Promise<void> {
  const dataUrl = _overrides[event]
  if (!dataUrl) {
    await synthBackend.play(event, ctx)
    return
  }
  try {
    // Convert data URL → ArrayBuffer
    const base64 = dataUrl.split(',')[1]
    const binary  = atob(base64)
    const bytes   = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    const buffer = await ctx.decodeAudioData(bytes.buffer)
    const source = ctx.createBufferSource()
    source.buffer = buffer
    source.connect(ctx.destination)
    source.start()
  } catch {
    // Decode failed — fall back to synth silently
    await synthBackend.play(event, ctx)
  }
}

export const soundService = {
  async play(event: SoundEvent): Promise<void> {
    const ctx = getCtx()
    if (ctx.state === 'suspended') await ctx.resume()
    await playWithFileOverride(event, ctx)
  },

  setCustomSound(event: SoundEvent, dataUrl: string): void {
    _overrides[event] = dataUrl
  },

  clearCustomSound(event: SoundEvent): void {
    delete _overrides[event]
  },

  /** Load overrides from persisted settings (called on app init). */
  loadFromSettings(customSounds: Partial<Record<SoundEvent, string>>): void {
    for (const [k, v] of Object.entries(customSounds)) {
      if (v) _overrides[k as SoundEvent] = v
    }
  },

  // Future hook — MIDI backend will call this:
  // setBackend(backend: SoundBackend): void { ... }
}
```

- [ ] **Step 4: Run tests — expect pass**

```
npm run test -- --run src/services/__tests__/soundService.test.ts 2>&1 | Select-String "PASS|FAIL|✓|×"
```
Expected: PASS, 5 tests passing.

- [ ] **Step 5: Verify build**

```
npm run build 2>&1 | Select-String "error TS"
```
Expected: no output.

- [ ] **Step 6: Commit**

```
git add src/services/soundService.ts src/services/__tests__/soundService.test.ts
git commit -m "feat(notif): soundService — Web Audio synth + file override"
```

---

## Task 4: Create `notificationStore.ts`

**Files:**
- Create: `src/stores/notificationStore.ts`
- Create: `src/stores/__tests__/notificationStore.test.ts`

This store owns all routing logic. `notify()` evaluates the hierarchy and dispatches to sound and/or OS notification.

- [ ] **Step 1: Write the failing tests**

Create `src/stores/__tests__/notificationStore.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { createTestingPinia } from '@pinia/testing'

// Mock @tauri-apps/api/window
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ isFocused: vi.fn().mockResolvedValue(false) }),
}))

// Mock @tauri-apps/plugin-notification
const mockSendNotification = vi.fn()
const mockIsPermissionGranted = vi.fn().mockResolvedValue(true)
vi.mock('@tauri-apps/plugin-notification', () => ({
  sendNotification:     mockSendNotification,
  isPermissionGranted:  mockIsPermissionGranted,
  requestPermission:    vi.fn().mockResolvedValue('granted'),
}))

// Mock soundService
const mockSoundPlay = vi.fn().mockResolvedValue(undefined)
vi.mock('@/services/soundService', () => ({
  soundService: { play: mockSoundPlay, setCustomSound: vi.fn(), clearCustomSound: vi.fn(), loadFromSettings: vi.fn() },
}))

// Stub dynamic imports used inside notificationStore
vi.mock('@/stores/settingsStore', () => ({
  useSettingsStore: () => ({
    settings: {
      notificationsEnabled: true,
      soundEnabled: true,
      serverNotificationPrefs: {},
      channelNotificationPrefs: {},
      keywordFilters: [],
    },
  }),
}))

vi.mock('@/stores/identityStore', () => ({
  useIdentityStore: () => ({ displayName: 'Alice', userId: 'user-alice' }),
}))

describe('notificationStore — rules hierarchy', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    vi.resetModules()
    // Reset isFocused to false (window not focused) by default
    vi.mock('@tauri-apps/api/window', () => ({
      getCurrentWindow: () => ({ isFocused: vi.fn().mockResolvedValue(false) }),
    }))
  })

  it('fires OS notification + sound for a mention when window is not focused', async () => {
    const { useNotificationStore } = await import('../notificationStore')
    const store = useNotificationStore()
    await store.notify({
      type:      'mention',
      serverId:  'srv1',
      channelId: 'ch1',
      content:   'hey @Alice check this out',
      titleText: 'Bob mentioned you',
      bodyText:  'hey @Alice check this out',
    })
    expect(mockSendNotification).toHaveBeenCalledOnce()
    expect(mockSoundPlay).toHaveBeenCalledWith('mention')
  })

  it('plays sound but suppresses OS notification when window IS focused', async () => {
    vi.mock('@tauri-apps/api/window', () => ({
      getCurrentWindow: () => ({ isFocused: vi.fn().mockResolvedValue(true) }),
    }))
    const { useNotificationStore } = await import('../notificationStore')
    const store = useNotificationStore()
    await store.notify({
      type: 'mention', serverId: 'srv1', channelId: 'ch1',
      content: 'hey @Alice', titleText: 'Mention', bodyText: 'hey @Alice',
    })
    expect(mockSendNotification).not.toHaveBeenCalled()
    expect(mockSoundPlay).toHaveBeenCalledWith('mention')
  })

  it('blocks everything when channel is muted (muteUntil in future)', async () => {
    vi.mock('@/stores/settingsStore', () => ({
      useSettingsStore: () => ({
        settings: {
          notificationsEnabled: true,
          soundEnabled: true,
          serverNotificationPrefs: {},
          channelNotificationPrefs: {
            ch1: { level: 'inherit', muteUntil: Date.now() + 3_600_000 },
          },
          keywordFilters: [],
        },
      }),
    }))
    const { useNotificationStore } = await import('../notificationStore')
    const store = useNotificationStore()
    await store.notify({
      type: 'mention', serverId: 'srv1', channelId: 'ch1',
      content: 'hey @Alice', titleText: 'Mention', bodyText: 'hey @Alice',
    })
    expect(mockSendNotification).not.toHaveBeenCalled()
    expect(mockSoundPlay).not.toHaveBeenCalled()
  })

  it('passes when muteUntil is in the past', async () => {
    vi.mock('@/stores/settingsStore', () => ({
      useSettingsStore: () => ({
        settings: {
          notificationsEnabled: true,
          soundEnabled: true,
          serverNotificationPrefs: {},
          channelNotificationPrefs: {
            ch1: { level: 'inherit', muteUntil: Date.now() - 1000 },
          },
          keywordFilters: [],
        },
      }),
    }))
    const { useNotificationStore } = await import('../notificationStore')
    const store = useNotificationStore()
    await store.notify({
      type: 'mention', serverId: 'srv1', channelId: 'ch1',
      content: 'hey @Alice', titleText: 'Mention', bodyText: 'hey @Alice',
    })
    expect(mockSoundPlay).toHaveBeenCalled()
  })

  it('blocks non-mention message when server level is "mentions"', async () => {
    vi.mock('@/stores/settingsStore', () => ({
      useSettingsStore: () => ({
        settings: {
          notificationsEnabled: true,
          soundEnabled: true,
          serverNotificationPrefs: { srv1: { level: 'mentions' } },
          channelNotificationPrefs: {},
          keywordFilters: [],
        },
      }),
    }))
    const { useNotificationStore } = await import('../notificationStore')
    const store = useNotificationStore()
    await store.notify({
      type: 'message', serverId: 'srv1', channelId: 'ch1',
      content: 'just a regular message', titleText: 'Bob', bodyText: 'just a regular message',
    })
    expect(mockSendNotification).not.toHaveBeenCalled()
    expect(mockSoundPlay).not.toHaveBeenCalled()
  })

  it('passes non-mention when server level is "all"', async () => {
    vi.mock('@/stores/settingsStore', () => ({
      useSettingsStore: () => ({
        settings: {
          notificationsEnabled: true,
          soundEnabled: true,
          serverNotificationPrefs: { srv1: { level: 'all' } },
          channelNotificationPrefs: {},
          keywordFilters: [],
        },
      }),
    }))
    const { useNotificationStore } = await import('../notificationStore')
    const store = useNotificationStore()
    await store.notify({
      type: 'message', serverId: 'srv1', channelId: 'ch1',
      content: 'hello everyone', titleText: 'Bob', bodyText: 'hello everyone',
    })
    expect(mockSoundPlay).toHaveBeenCalled()
  })

  it('keyword match elevates a "mentions"-level server event to pass', async () => {
    vi.mock('@/stores/settingsStore', () => ({
      useSettingsStore: () => ({
        settings: {
          notificationsEnabled: true,
          soundEnabled: true,
          serverNotificationPrefs: { srv1: { level: 'mentions' } },
          channelNotificationPrefs: {},
          keywordFilters: [{ id: 'k1', keyword: 'urgent' }],
        },
      }),
    }))
    const { useNotificationStore } = await import('../notificationStore')
    const store = useNotificationStore()
    await store.notify({
      type: 'message', serverId: 'srv1', channelId: 'ch1',
      content: 'this is urgent!!', titleText: 'Bob', bodyText: 'this is urgent!!',
    })
    expect(mockSoundPlay).toHaveBeenCalled()
  })

  it('keyword does NOT override a mute', async () => {
    vi.mock('@/stores/settingsStore', () => ({
      useSettingsStore: () => ({
        settings: {
          notificationsEnabled: true,
          soundEnabled: true,
          serverNotificationPrefs: { srv1: { level: 'muted' } },
          channelNotificationPrefs: {},
          keywordFilters: [{ id: 'k1', keyword: 'urgent' }],
        },
      }),
    }))
    const { useNotificationStore } = await import('../notificationStore')
    const store = useNotificationStore()
    await store.notify({
      type: 'message', serverId: 'srv1', channelId: 'ch1',
      content: 'this is urgent!!', titleText: 'Bob', bodyText: 'this is urgent!!',
    })
    expect(mockSoundPlay).not.toHaveBeenCalled()
    expect(mockSendNotification).not.toHaveBeenCalled()
  })

  it('plays join_other sound for voice join event', async () => {
    const { useNotificationStore } = await import('../notificationStore')
    const store = useNotificationStore()
    await store.notify({
      type: 'join_other', serverId: 'srv1', channelId: 'ch1',
      titleText: 'Bob joined voice', bodyText: undefined,
    })
    expect(mockSoundPlay).toHaveBeenCalledWith('join_other')
  })
})
```

- [ ] **Step 2: Run tests — expect failure**

```
npm run test -- --run src/stores/__tests__/notificationStore.test.ts 2>&1 | Select-String "PASS|FAIL|error"
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `notificationStore.ts`**

Create `src/stores/notificationStore.ts`:

```ts
import { defineStore } from 'pinia'
import type { SoundEvent } from '@/types/core'
import { soundService } from '@/services/soundService'

export interface NotificationEvent {
  type:       SoundEvent
  serverId?:  string
  channelId?: string
  authorId?:  string
  content?:   string   // raw plaintext for mention/keyword detection
  titleText:  string
  bodyText?:  string
}

export const useNotificationStore = defineStore('notifications', () => {

  async function notify(event: NotificationEvent): Promise<void> {
    const { useSettingsStore }  = await import('./settingsStore')
    const { useIdentityStore }  = await import('./identityStore')
    const settings   = useSettingsStore().settings
    const myName     = useIdentityStore().displayName ?? ''
    const now        = Date.now()

    const chPrefs  = event.channelId ? settings.channelNotificationPrefs[event.channelId]  : undefined
    const srvPrefs = event.serverId  ? settings.serverNotificationPrefs[event.serverId]    : undefined

    // ── Step 1–2: timed mutes ──────────────────────────────────────────────
    if (chPrefs?.muteUntil  && chPrefs.muteUntil  > now) return
    if (srvPrefs?.muteUntil && srvPrefs.muteUntil > now) return

    // ── Step 3: channel-level override (not inherit) ───────────────────────
    const chLevel = chPrefs?.level && chPrefs.level !== 'inherit' ? chPrefs.level : undefined

    if (chLevel === 'muted') return

    // ── Step 4: server-level fallback ──────────────────────────────────────
    const srvLevel = srvPrefs?.level ?? 'mentions'  // default = 'mentions'

    if (srvLevel === 'muted') return

    // Effective level = channel override if set, else server level
    const effectiveLevel = chLevel ?? srvLevel

    // ── Step 5: mention/keyword check when level = 'mentions' ──────────────
    if (effectiveLevel === 'mentions') {
      const content = (event.content ?? '').toLowerCase()
      const mentioned = myName && content.includes(`@${myName.toLowerCase()}`)

      const keywordMatch = settings.keywordFilters.some(f => {
        // Scope: undefined = global; if scoped, only match that server
        if (f.serverId && f.serverId !== event.serverId) return false
        return content.includes(f.keyword.toLowerCase())
      })

      if (!mentioned && !keywordMatch) return
    }

    // ── Event passes — dispatch sound and/or OS notification ──────────────
    if (settings.soundEnabled) {
      soundService.play(event.type).catch(() => {})
    }

    if (settings.notificationsEnabled) {
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window')
        const focused = await getCurrentWindow().isFocused()
        if (!focused) {
          const { sendNotification, isPermissionGranted, requestPermission } =
            await import('@tauri-apps/plugin-notification')
          let granted = await isPermissionGranted()
          if (!granted) {
            const perm = await requestPermission()
            granted = perm === 'granted'
          }
          if (granted) {
            sendNotification({
              title: event.titleText,
              body:  event.bodyText?.slice(0, 120),
            })
          }
        }
      } catch {
        // Tauri APIs unavailable in browser dev mode — ignore
      }
    }
  }

  return { notify }
})
```

- [ ] **Step 4: Run tests — expect pass**

```
npm run test -- --run src/stores/__tests__/notificationStore.test.ts 2>&1 | Select-String "PASS|FAIL|✓|×"
```
Expected: PASS, 8 tests passing.

- [ ] **Step 5: Verify build**

```
npm run build 2>&1 | Select-String "error TS"
```
Expected: no output.

- [ ] **Step 6: Commit**

```
git add src/stores/notificationStore.ts src/stores/__tests__/notificationStore.test.ts
git commit -m "feat(notif): notificationStore — rules hierarchy, OS dispatch, sound dispatch"
```

---

## Task 5: Update `messagesStore.ts` — replace `maybeNotify`

**Files:**
- Modify: `src/stores/messagesStore.ts`

The existing `maybeNotify()` function and its call site need to be removed, replaced with a `notificationStore.notify()` call.

- [ ] **Step 1: Find and remove `maybeNotify()`**

In `src/stores/messagesStore.ts`, delete the entire `maybeNotify` function (from `async function maybeNotify(` through its closing `}`). It spans roughly 35 lines. The function starts with:

```ts
  async function maybeNotify(msg: Message, plaintext: string, serverId: string) {
```

And ends approximately at:
```ts
    } catch (e) {
      // Notification API unavailable (e.g. in browser dev mode) — ignore
    }
  }
```

Delete that entire function body.

- [ ] **Step 2: Replace the call site**

Find the existing call to `maybeNotify`:
```ts
    // Fire OS notification when the window is not focused
    maybeNotify(msg, plaintext, wire.serverId)
```

Replace it with:
```ts
    // Route to notification system (OS notification + sound + rules)
    const isMention = myName && plaintext.toLowerCase().includes(`@${myName.toLowerCase()}`)
    const { useNotificationStore } = await import('./notificationStore')
    const { useServersStore }      = await import('./serversStore')
    const sender = useServersStore().members[wire.serverId]?.[msg.authorId]?.displayName
                   ?? msg.authorId.slice(0, 8)
    const { useChannelsStore } = await import('./channelsStore')
    const channel = Object.values(useChannelsStore().channels).flat().find(c => c.id === msg.channelId)
    const chanName = channel?.name ? `#${channel.name}` : 'a channel'
    await useNotificationStore().notify({
      type:      isMention ? 'mention' : 'message',
      serverId:  wire.serverId,
      channelId: wire.channelId,
      authorId:  wire.authorId,
      content:   plaintext,
      titleText: isMention ? `${sender} mentioned you in ${chanName}` : `${sender} in ${chanName}`,
      bodyText:  plaintext.slice(0, 120),
    })
```

Note: `myName` is already in scope at the call site (it's used for mention detection in `parsedContent`). Verify this is true after the edit — if not, add:
```ts
    const { useIdentityStore } = await import('./identityStore')
    const myName = useIdentityStore().displayName ?? ''
```

- [ ] **Step 3: Verify build passes**

```
npm run build 2>&1 | Select-String "error TS"
```
Expected: no output.

- [ ] **Step 4: Run full test suite**

```
npm run test -- --run 2>&1 | Select-String "Tests|PASS|FAIL"
```
Expected: all tests passing (should be >= previous count).

- [ ] **Step 5: Commit**

```
git add src/stores/messagesStore.ts
git commit -m "feat(notif): messagesStore — replace maybeNotify with notificationStore.notify"
```

---

## Task 6: Add voice join/leave notifications to `networkStore.ts`

**Files:**
- Modify: `src/stores/networkStore.ts`

Voice join/leave events pass through `handleVoiceJoin` and `handleVoiceLeave` in `networkStore.ts`. Both need to fire `notificationStore.notify()`.

- [ ] **Step 1: Update `handleVoiceJoin`**

Find the `handleVoiceJoin` function (around line 770 in `networkStore.ts`). It currently ends with:

```ts
      if (!msg.isReply) {
        sendToPeer(userId, { type: 'voice_join', channelId, isReply: true })
      }
    }
  }
```

Add a notification call after `voiceStore.setPeerVoiceChannel(userId, channelId)` but before the `if (voiceStore.session?.channelId === channelId)` block:

```ts
    // Notify: someone joined a voice channel
    const peerName = (await import('./serversStore')).useServersStore()
      .members[voiceStore.session?.serverId ?? '']?.[userId]?.displayName ?? userId.slice(0, 8)
    ;(await import('./notificationStore')).useNotificationStore().notify({
      type:      'join_other',
      serverId:  voiceStore.session?.serverId,
      channelId,
      authorId:  userId,
      titleText: `${peerName} joined voice`,
    }).catch(() => {})
```

- [ ] **Step 2: Update `handleVoiceLeave`**

Find the `handleVoiceLeave` function. It currently reads:

```ts
  async function handleVoiceLeave(userId: string) {
    const { useVoiceStore } = await import('./voiceStore')
    const voiceStore = useVoiceStore()
    voiceStore.removePeer(userId)
    voiceStore.clearPeerVoiceChannel(userId)
  }
```

Replace with:

```ts
  async function handleVoiceLeave(userId: string) {
    const { useVoiceStore } = await import('./voiceStore')
    const voiceStore = useVoiceStore()
    const serverId = voiceStore.session?.serverId
    voiceStore.removePeer(userId)
    voiceStore.clearPeerVoiceChannel(userId)
    // Notify: peer left voice
    const peerName = (await import('./serversStore')).useServersStore()
      .members[serverId ?? '']?.[userId]?.displayName ?? userId.slice(0, 8)
    ;(await import('./notificationStore')).useNotificationStore().notify({
      type:      'leave',
      serverId,
      authorId:  userId,
      titleText: `${peerName} left voice`,
    }).catch(() => {})
  }
```

- [ ] **Step 3: Add self-join notification to `voiceStore.ts`**

In `src/stores/voiceStore.ts`, find the `joinVoiceChannel` function. After the `useNetworkStore().broadcast({ type: 'voice_join', channelId, serverId })` line at the end, add:

```ts
    // Notify self: joined voice channel
    const { useNotificationStore } = await import('./notificationStore')
    const { useChannelsStore }     = await import('./channelsStore')
    const ch = Object.values(useChannelsStore().channels).flat().find(c => c.id === channelId)
    useNotificationStore().notify({
      type:      'join_self',
      serverId,
      channelId,
      titleText: `You joined ${ch?.name ? `#${ch.name}` : 'voice'}`,
    }).catch(() => {})
```

- [ ] **Step 4: Verify build**

```
npm run build 2>&1 | Select-String "error TS"
```
Expected: no output.

- [ ] **Step 5: Commit**

```
git add src/stores/networkStore.ts src/stores/voiceStore.ts
git commit -m "feat(notif): voice join/leave events route through notificationStore"
```

---

## Task 7: Rewrite `SettingsNotificationsTab.vue`

**Files:**
- Rewrite: `src/components/settings/SettingsNotificationsTab.vue`

Four sections: global toggles, sound customization, per-server prefs, keyword filters.

- [ ] **Step 1: Replace the file contents**

Replace the entire content of `src/components/settings/SettingsNotificationsTab.vue` with:

```vue
<template>
  <div class="tab-content">

    <!-- ── Section A: Global Toggles ─────────────────────────────────── -->
    <div class="settings-section">
      <h3>Notifications</h3>
      <div class="setting-row">
        <label class="checkbox-row">
          <input v-model="settings.notificationsEnabled" type="checkbox"
            @change="save('notificationsEnabled', settings.notificationsEnabled)" />
          <span>Enable desktop notifications</span>
        </label>
        <p class="setting-hint">Shows OS-level notifications for mentions and messages when the window is not focused.</p>
      </div>
      <div class="setting-row">
        <label class="checkbox-row">
          <input v-model="settings.soundEnabled" type="checkbox"
            @change="save('soundEnabled', settings.soundEnabled)" />
          <span>Play notification sounds</span>
        </label>
      </div>
    </div>

    <!-- ── Section B: Sound Customization ────────────────────────────── -->
    <div class="settings-section">
      <h3>Sounds</h3>
      <p class="setting-hint" style="margin-bottom: var(--spacing-md)">
        Default sounds are synthesized tones. Upload an audio file (.mp3, .ogg, .wav, .flac, max 2 MB) to override any event.
      </p>
      <div v-for="ev in soundEvents" :key="ev.key" class="sound-row">
        <span class="sound-label">{{ ev.label }}</span>
        <div class="sound-controls">
          <button class="btn-secondary-sm" @click="previewSound(ev.key)">
            <AppIcon :path="mdiPlay" :size="14" />
            Preview
          </button>
          <label class="btn-secondary-sm upload-label" :title="'Upload custom sound for ' + ev.label">
            <AppIcon :path="mdiUpload" :size="14" />
            Upload
            <input type="file" accept=".mp3,.ogg,.wav,.flac" class="file-input-hidden"
              @change="(e) => handleSoundUpload(ev.key, e)" />
          </label>
          <button v-if="settings.customSounds[ev.key]" class="icon-btn danger-btn"
            title="Reset to default sound" @click="clearSound(ev.key)">
            <AppIcon :path="mdiClose" :size="14" />
          </button>
          <span v-if="settings.customSounds[ev.key]" class="custom-badge">Custom</span>
        </div>
        <p v-if="soundErrors[ev.key]" class="sound-error">{{ soundErrors[ev.key] }}</p>
      </div>
    </div>

    <!-- ── Section C: Per-Server Prefs ───────────────────────────────── -->
    <div class="settings-section">
      <h3>Server Notifications</h3>
      <p class="setting-hint" style="margin-bottom: var(--spacing-md)">
        Override notification level per server. Default is <strong>Only Mentions</strong>.
        Per-channel overrides are set by right-clicking a channel name.
      </p>
      <div v-if="servers.length === 0" class="empty-hint">No servers joined yet.</div>
      <div v-for="srv in servers" :key="srv.id" class="server-notif-row">
        <div class="srv-identity">
          <AvatarImage :src="srv.avatarDataUrl ?? srv.iconUrl ?? null" :name="srv.name" :size="28" />
          <span class="srv-name">{{ srv.name }}</span>
        </div>
        <div class="srv-controls">
          <select class="notif-select"
            :value="serverLevel(srv.id)"
            @change="setServerLevel(srv.id, ($event.target as HTMLSelectElement).value as NotificationLevel)">
            <option value="all">All Messages</option>
            <option value="mentions">Only Mentions</option>
            <option value="muted">Muted</option>
          </select>
          <div v-if="activeMute('server', srv.id)" class="mute-badge">
            Muted until {{ muteLabel('server', srv.id) }}
            <button class="inline-clear" @click="clearMute('server', srv.id)">×</button>
          </div>
          <button v-else class="btn-secondary-sm" @click="openMutePicker('server', srv.id)">
            <AppIcon :path="mdiBellOff" :size="14" />
            Mute…
          </button>
        </div>
      </div>
    </div>

    <!-- ── Section D: Keyword Filters ────────────────────────────────── -->
    <div class="settings-section">
      <h3>Keyword Notifications</h3>
      <p class="setting-hint" style="margin-bottom: var(--spacing-md)">
        Receive a notification when any of these keywords appear in a message, even on "Only Mentions" servers.
        Muted servers and channels still block keyword notifications.
      </p>
      <div class="keyword-add-row">
        <input v-model="newKeyword" class="keyword-input" placeholder="Add keyword…" maxlength="60"
          @keydown.enter="addKeyword" />
        <select v-model="newKeywordServerId" class="keyword-scope-select">
          <option value="">All Servers</option>
          <option v-for="srv in servers" :key="srv.id" :value="srv.id">{{ srv.name }}</option>
        </select>
        <button class="btn-primary-sm" :disabled="!newKeyword.trim()" @click="addKeyword">Add</button>
      </div>
      <div v-if="settings.keywordFilters.length === 0" class="empty-hint">
        No keyword filters. Keywords will trigger notifications on "Only Mentions" servers.
      </div>
      <div v-for="kw in settings.keywordFilters" :key="kw.id" class="keyword-row">
        <span class="keyword-text">{{ kw.keyword }}</span>
        <span class="keyword-scope">{{ scopeLabel(kw) }}</span>
        <button class="icon-btn" title="Remove keyword" @click="removeKeyword(kw.id)">
          <AppIcon :path="mdiTrashCan" :size="14" />
        </button>
      </div>
    </div>

    <!-- Mute duration picker (portal) -->
    <Teleport to="body">
      <div v-if="mutePicker.open" class="mute-backdrop" @click.self="mutePicker.open = false">
        <div class="mute-picker-popup">
          <p class="mute-picker-title">Mute for how long?</p>
          <button v-for="opt in muteOptions" :key="opt.label"
            class="mute-option-btn" @click="applyMute(opt.hours)">
            {{ opt.label }}
          </button>
          <button class="mute-option-btn mute-option-forever" @click="applyMute(0)">Until I unmute</button>
          <button class="btn-secondary-sm" style="margin-top:var(--spacing-sm)" @click="mutePicker.open = false">Cancel</button>
        </div>
      </div>
    </Teleport>

  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import { v7 as uuidv7 } from 'uuid'
import { mdiPlay, mdiUpload, mdiClose, mdiBellOff, mdiTrashCan } from '@mdi/js'
import { useSettingsStore } from '@/stores/settingsStore'
import { useServersStore }  from '@/stores/serversStore'
import { soundService }     from '@/services/soundService'
import type { NotificationLevel, SoundEvent } from '@/types/core'

const settingsStore = useSettingsStore()
const settings      = settingsStore.settings
const serversStore  = useServersStore()

const servers = computed(() =>
  serversStore.joinedServerIds.map(id => serversStore.servers[id]).filter(Boolean)
)

// ── Helpers ────────────────────────────────────────────────────────────────

function save<K extends keyof typeof settings>(key: K, value: (typeof settings)[K]) {
  settingsStore.updateSetting(key, value)
}

// ── Section B: sounds ──────────────────────────────────────────────────────

const soundEvents: { key: SoundEvent; label: string }[] = [
  { key: 'message',    label: 'New message' },
  { key: 'mention',    label: 'Mentioned / keyword' },
  { key: 'join_self',  label: 'You joined voice' },
  { key: 'join_other', label: 'Someone joined voice' },
  { key: 'leave',      label: 'Someone left voice' },
]

const soundErrors = ref<Partial<Record<SoundEvent, string>>>({})
const MAX_SOUND_BYTES = 2 * 1024 * 1024

function previewSound(ev: SoundEvent) {
  soundService.play(ev)
}

async function handleSoundUpload(ev: SoundEvent, event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0]
  if (!file) return
  soundErrors.value[ev] = undefined
  if (file.size > MAX_SOUND_BYTES) {
    soundErrors.value[ev] = `File too large (max 2 MB). This file is ${(file.size / 1024 / 1024).toFixed(1)} MB.`
    return
  }
  const reader = new FileReader()
  reader.onload = () => {
    const dataUrl = reader.result as string
    soundService.setCustomSound(ev, dataUrl)
    settings.customSounds = { ...settings.customSounds, [ev]: dataUrl }
    save('customSounds', settings.customSounds)
  }
  reader.readAsDataURL(file)
}

function clearSound(ev: SoundEvent) {
  soundService.clearCustomSound(ev)
  const next = { ...settings.customSounds }
  delete next[ev]
  settings.customSounds = next
  save('customSounds', next)
}

// ── Section C: per-server ──────────────────────────────────────────────────

function serverLevel(serverId: string): NotificationLevel {
  return settings.serverNotificationPrefs[serverId]?.level ?? 'mentions'
}

function setServerLevel(serverId: string, level: NotificationLevel) {
  const existing = settings.serverNotificationPrefs[serverId] ?? {}
  settings.serverNotificationPrefs = {
    ...settings.serverNotificationPrefs,
    [serverId]: { ...existing, level },
  }
  save('serverNotificationPrefs', settings.serverNotificationPrefs)
}

function activeMute(scope: 'server' | 'channel', id: string): boolean {
  const prefs = scope === 'server'
    ? settings.serverNotificationPrefs[id]
    : settings.channelNotificationPrefs[id]
  return !!(prefs?.muteUntil && prefs.muteUntil > Date.now())
}

function muteLabel(scope: 'server' | 'channel', id: string): string {
  const prefs = scope === 'server'
    ? settings.serverNotificationPrefs[id]
    : settings.channelNotificationPrefs[id]
  if (!prefs?.muteUntil) return ''
  if (prefs.muteUntil === Infinity || prefs.muteUntil > Date.now() + 365 * 24 * 3_600_000) return 'indefinitely'
  return new Date(prefs.muteUntil).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function clearMute(scope: 'server' | 'channel', id: string) {
  if (scope === 'server') {
    const existing = { ...settings.serverNotificationPrefs[id] }
    delete existing.muteUntil
    settings.serverNotificationPrefs = { ...settings.serverNotificationPrefs, [id]: existing }
    save('serverNotificationPrefs', settings.serverNotificationPrefs)
  } else {
    const existing = { ...settings.channelNotificationPrefs[id] }
    delete existing.muteUntil
    settings.channelNotificationPrefs = { ...settings.channelNotificationPrefs, [id]: existing }
    save('channelNotificationPrefs', settings.channelNotificationPrefs)
  }
}

// Mute picker state
const mutePicker = ref<{ open: boolean; scope: 'server' | 'channel'; id: string }>({
  open: false, scope: 'server', id: '',
})
const muteOptions = [
  { label: '1 hour',   hours: 1 },
  { label: '8 hours',  hours: 8 },
  { label: '24 hours', hours: 24 },
]

function openMutePicker(scope: 'server' | 'channel', id: string) {
  mutePicker.value = { open: true, scope, id }
}

function applyMute(hours: number) {
  const muteUntil = hours === 0
    ? Number.MAX_SAFE_INTEGER
    : Date.now() + hours * 3_600_000
  const { scope, id } = mutePicker.value
  if (scope === 'server') {
    const existing = settings.serverNotificationPrefs[id] ?? { level: 'mentions' as NotificationLevel }
    settings.serverNotificationPrefs = {
      ...settings.serverNotificationPrefs,
      [id]: { ...existing, muteUntil },
    }
    save('serverNotificationPrefs', settings.serverNotificationPrefs)
  } else {
    const existing = settings.channelNotificationPrefs[id] ?? { level: 'inherit' as const }
    settings.channelNotificationPrefs = {
      ...settings.channelNotificationPrefs,
      [id]: { ...existing, muteUntil },
    }
    save('channelNotificationPrefs', settings.channelNotificationPrefs)
  }
  mutePicker.value.open = false
}

// ── Section D: keywords ────────────────────────────────────────────────────

const newKeyword         = ref('')
const newKeywordServerId = ref('')

function scopeLabel(kw: { serverId?: string }) {
  if (!kw.serverId) return 'All Servers'
  return serversStore.servers[kw.serverId]?.name ?? kw.serverId.slice(0, 8)
}

function addKeyword() {
  const kw = newKeyword.value.trim()
  if (!kw) return
  const filters = [
    ...settings.keywordFilters,
    {
      id:       uuidv7(),
      keyword:  kw,
      serverId: newKeywordServerId.value || undefined,
    },
  ]
  settings.keywordFilters = filters
  save('keywordFilters', filters)
  newKeyword.value = ''
}

function removeKeyword(id: string) {
  const filters = settings.keywordFilters.filter(f => f.id !== id)
  settings.keywordFilters = filters
  save('keywordFilters', filters)
}
</script>

<style scoped>
.tab-content { display: flex; flex-direction: column; gap: var(--spacing-xl); }

.settings-section h3 { margin: 0 0 var(--spacing-md); font-size: 13px; font-weight: 600;
  text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-secondary); }

.setting-row { margin-bottom: var(--spacing-md); }
.setting-hint { font-size: 11px; color: var(--text-tertiary); margin-top: var(--spacing-xs); }

.checkbox-row { display: flex; align-items: center; gap: var(--spacing-sm); font-size: 14px;
  color: var(--text-primary); cursor: pointer; }

/* Section B — sounds */
.sound-row { display: flex; flex-direction: column; gap: 4px; padding: var(--spacing-sm) 0;
  border-bottom: 1px solid var(--border-color); }
.sound-row:last-of-type { border-bottom: none; }
.sound-label { font-size: 13px; color: var(--text-primary); }
.sound-controls { display: flex; align-items: center; gap: var(--spacing-sm); flex-wrap: wrap; }
.upload-label { cursor: pointer; display: flex; align-items: center; gap: 4px; }
.file-input-hidden { display: none; }
.custom-badge { font-size: 10px; background: var(--accent-color); color: #fff;
  border-radius: 4px; padding: 1px 6px; }
.sound-error { font-size: 11px; color: var(--error-color); margin-top: 2px; }
.danger-btn { color: var(--error-color); }

/* Section C — per-server */
.server-notif-row { display: flex; align-items: center; justify-content: space-between;
  padding: var(--spacing-sm) 0; border-bottom: 1px solid var(--border-color); gap: var(--spacing-sm); }
.server-notif-row:last-child { border-bottom: none; }
.srv-identity { display: flex; align-items: center; gap: var(--spacing-sm); min-width: 0; }
.srv-name { font-size: 13px; color: var(--text-primary); white-space: nowrap;
  overflow: hidden; text-overflow: ellipsis; }
.srv-controls { display: flex; align-items: center; gap: var(--spacing-sm); flex-shrink: 0; }
.notif-select { background: var(--bg-secondary); color: var(--text-primary);
  border: 1px solid var(--border-color); border-radius: 4px; padding: 3px 6px; font-size: 12px; }
.mute-badge { font-size: 11px; color: var(--text-secondary); display: flex; align-items: center; gap: 4px; }
.inline-clear { background: none; border: none; cursor: pointer; color: var(--text-secondary);
  font-size: 14px; padding: 0; line-height: 1; }
.empty-hint { font-size: 12px; color: var(--text-tertiary); }

/* Section D — keywords */
.keyword-add-row { display: flex; gap: var(--spacing-sm); margin-bottom: var(--spacing-md); flex-wrap: wrap; }
.keyword-input { flex: 1; min-width: 120px; background: var(--bg-secondary); color: var(--text-primary);
  border: 1px solid var(--border-color); border-radius: 4px; padding: 4px 8px; font-size: 13px; }
.keyword-scope-select { background: var(--bg-secondary); color: var(--text-primary);
  border: 1px solid var(--border-color); border-radius: 4px; padding: 4px 6px; font-size: 12px; }
.keyword-row { display: flex; align-items: center; gap: var(--spacing-sm);
  padding: var(--spacing-xs) 0; border-bottom: 1px solid var(--border-color); }
.keyword-row:last-child { border-bottom: none; }
.keyword-text { flex: 1; font-size: 13px; color: var(--text-primary); }
.keyword-scope { font-size: 11px; color: var(--text-tertiary); }

/* Mute picker */
.mute-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,0.5); z-index: 1000;
  display: flex; align-items: center; justify-content: center; }
.mute-picker-popup { background: var(--bg-secondary); border: 1px solid var(--border-color);
  border-radius: 8px; padding: var(--spacing-lg); min-width: 200px;
  display: flex; flex-direction: column; gap: var(--spacing-sm); }
.mute-picker-title { font-size: 13px; font-weight: 600; color: var(--text-primary);
  margin: 0 0 var(--spacing-xs); }
.mute-option-btn { background: var(--bg-tertiary); border: 1px solid var(--border-color);
  border-radius: 4px; padding: var(--spacing-sm) var(--spacing-md); font-size: 13px;
  color: var(--text-primary); cursor: pointer; text-align: left; }
.mute-option-btn:hover { background: var(--accent-color); color: #fff; }
.mute-option-forever { color: var(--error-color); }
</style>
```

- [ ] **Step 2: Verify build passes**

```
npm run build 2>&1 | Select-String "error TS"
```
Expected: no output.

- [ ] **Step 3: Commit**

```
git add src/components/settings/SettingsNotificationsTab.vue
git commit -m "feat(notif): rewrite SettingsNotificationsTab — sounds, per-server, keywords"
```

---

## Task 8: Per-channel notification popover

**Files:**
- Create: `src/components/layout/ChannelNotifPopover.vue`
- Modify: `src/components/layout/ChannelSidebar.vue`
- Modify: `src/utils/contextMenuResolver.ts`

This adds "Notification settings" to the channel right-click menu, which opens an inline popover.

- [ ] **Step 1: Create `ChannelNotifPopover.vue`**

Create `src/components/layout/ChannelNotifPopover.vue`:

```vue
<template>
  <Teleport to="body">
    <div class="notif-popover-backdrop" @click.self="emit('close')">
      <div class="notif-popover" :style="positionStyle">
        <p class="popover-title">Notifications: <strong>{{ channelName }}</strong></p>

        <label class="popover-label">Message level</label>
        <select class="popover-select" :value="currentLevel" @change="setLevel(($event.target as HTMLSelectElement).value as ChannelLevelOption)">
          <option value="inherit">Inherit from server</option>
          <option value="all">All Messages</option>
          <option value="mentions">Only Mentions</option>
          <option value="muted">Muted</option>
        </select>

        <div v-if="activeMute" class="popover-mute-active">
          Muted until {{ muteLabel }}
          <button class="inline-clear" @click="clearMute">×</button>
        </div>
        <div v-else class="popover-mute-row">
          <label class="popover-label">Timed mute</label>
          <div class="popover-mute-options">
            <button v-for="opt in muteOptions" :key="opt.hours"
              class="mute-chip" @click="applyMute(opt.hours)">
              {{ opt.label }}
            </button>
            <button class="mute-chip mute-chip-forever" @click="applyMute(0)">∞</button>
          </div>
        </div>

        <button class="popover-close-btn" @click="emit('close')">Done</button>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useSettingsStore } from '@/stores/settingsStore'
import type { NotificationLevel } from '@/types/core'

type ChannelLevelOption = NotificationLevel | 'inherit'

const props = defineProps<{
  channelId:   string
  channelName: string
  anchorX:     number
  anchorY:     number
}>()

const emit = defineEmits<{ close: [] }>()

const settingsStore = useSettingsStore()
const settings      = settingsStore.settings

const positionStyle = computed(() => ({
  position: 'fixed' as const,
  top:  `${Math.min(props.anchorY, window.innerHeight - 260)}px`,
  left: `${Math.min(props.anchorX, window.innerWidth  - 260)}px`,
}))

const currentLevel = computed<ChannelLevelOption>(() =>
  settings.channelNotificationPrefs[props.channelId]?.level ?? 'inherit'
)

function setLevel(level: ChannelLevelOption) {
  const existing = settings.channelNotificationPrefs[props.channelId] ?? {}
  settings.channelNotificationPrefs = {
    ...settings.channelNotificationPrefs,
    [props.channelId]: { ...existing, level },
  }
  settingsStore.updateSetting('channelNotificationPrefs', settings.channelNotificationPrefs)
}

const activeMute = computed(() => {
  const p = settings.channelNotificationPrefs[props.channelId]
  return !!(p?.muteUntil && p.muteUntil > Date.now())
})

const muteLabel = computed(() => {
  const p = settings.channelNotificationPrefs[props.channelId]
  if (!p?.muteUntil) return ''
  if (p.muteUntil > Date.now() + 365 * 24 * 3_600_000) return 'indefinitely'
  return new Date(p.muteUntil).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
})

function clearMute() {
  const existing = { ...settings.channelNotificationPrefs[props.channelId] }
  delete existing.muteUntil
  settings.channelNotificationPrefs = {
    ...settings.channelNotificationPrefs,
    [props.channelId]: existing,
  }
  settingsStore.updateSetting('channelNotificationPrefs', settings.channelNotificationPrefs)
}

const muteOptions = [
  { label: '1h',  hours: 1 },
  { label: '8h',  hours: 8 },
  { label: '24h', hours: 24 },
]

function applyMute(hours: number) {
  const muteUntil = hours === 0 ? Number.MAX_SAFE_INTEGER : Date.now() + hours * 3_600_000
  const existing  = settings.channelNotificationPrefs[props.channelId] ?? { level: 'inherit' as const }
  settings.channelNotificationPrefs = {
    ...settings.channelNotificationPrefs,
    [props.channelId]: { ...existing, muteUntil },
  }
  settingsStore.updateSetting('channelNotificationPrefs', settings.channelNotificationPrefs)
}
</script>

<style scoped>
.notif-popover-backdrop { position: fixed; inset: 0; z-index: 900; }
.notif-popover {
  position: fixed; z-index: 901; min-width: 230px;
  background: var(--bg-secondary); border: 1px solid var(--border-color);
  border-radius: 8px; padding: var(--spacing-md); box-shadow: 0 4px 20px rgba(0,0,0,0.4);
  display: flex; flex-direction: column; gap: var(--spacing-sm);
}
.popover-title { font-size: 13px; font-weight: 600; color: var(--text-primary); margin: 0; }
.popover-label { font-size: 11px; color: var(--text-secondary); text-transform: uppercase;
  letter-spacing: 0.05em; margin: 0; }
.popover-select { background: var(--bg-tertiary); color: var(--text-primary);
  border: 1px solid var(--border-color); border-radius: 4px; padding: 4px 8px;
  font-size: 13px; width: 100%; }
.popover-mute-active { font-size: 12px; color: var(--text-secondary);
  display: flex; align-items: center; gap: 4px; }
.inline-clear { background: none; border: none; cursor: pointer; color: var(--text-secondary);
  font-size: 14px; padding: 0; }
.popover-mute-row { display: flex; flex-direction: column; gap: 4px; }
.popover-mute-options { display: flex; gap: var(--spacing-xs); flex-wrap: wrap; }
.mute-chip { background: var(--bg-tertiary); border: 1px solid var(--border-color);
  border-radius: 12px; padding: 2px 10px; font-size: 11px; color: var(--text-primary);
  cursor: pointer; }
.mute-chip:hover { background: var(--accent-color); color: #fff; border-color: var(--accent-color); }
.mute-chip-forever { color: var(--error-color); }
.popover-close-btn { background: var(--accent-color); color: #fff; border: none;
  border-radius: 4px; padding: var(--spacing-xs) var(--spacing-md); font-size: 13px;
  cursor: pointer; align-self: flex-end; margin-top: var(--spacing-xs); }
.popover-close-btn:hover { background: var(--accent-hover); }
</style>
```

- [ ] **Step 2: Add state and handler to `ChannelSidebar.vue`**

In `src/components/layout/ChannelSidebar.vue`, find the `<script setup>` block. Add the import and reactive state for the popover.

Find the existing imports block (it has `mdiCog`, etc.) and add:
```ts
import ChannelNotifPopover from './ChannelNotifPopover.vue'
import { mdiNotificationsActive } from '@mdi/js'
```

Find the existing refs (like `const renameState = ref(...)`) and add:
```ts
const notifPopover = ref<{
  open: boolean; channelId: string; channelName: string; x: number; y: number
}>({ open: false, channelId: '', channelName: '', x: 0, y: 0 })
```

Find the existing `openChannelMenu` function (or wherever the channel context menu is opened) and add a new function after it:
```ts
function openChannelNotifPopover(e: MouseEvent, channelId: string, channelName: string) {
  notifPopover.value = { open: true, channelId, channelName, x: e.clientX, y: e.clientY }
}
```

- [ ] **Step 3: Wire the popover to the channel context menu**

In `ChannelSidebar.vue`, find `openChannelMenu(e, ch.id)` calls in the template. The existing `openChannelMenu` function dispatches via `contextMenuResolver`. We need to pass the channel name and the click position so "Notification settings" can be a menu item.

Find the existing `openChannelMenu` function in `<script setup>` and add a `'notif'` case. The function likely calls `uiStore.showContextMenu(items, e)`. Add one more item to the menu items array:

```ts
{
  type: 'action' as const,
  label: 'Notification settings',
  callback: () => openChannelNotifPopover(e, channelId, ch?.name ?? channelId),
},
```

(The exact location to inject this depends on how `openChannelMenu` is currently structured — read its current body first, then add the item at the end of the items array, before the `uiStore.showContextMenu(...)` call.)

- [ ] **Step 4: Add the popover to the template**

In the `<template>` of `ChannelSidebar.vue`, find the `<VoiceBar />` line and add the popover just before `</aside>`:

```html
    <ChannelNotifPopover
      v-if="notifPopover.open"
      :channelId="notifPopover.channelId"
      :channelName="notifPopover.channelName"
      :anchorX="notifPopover.x"
      :anchorY="notifPopover.y"
      @close="notifPopover.open = false"
    />
```

- [ ] **Step 5: Verify build passes**

```
npm run build 2>&1 | Select-String "error TS"
```
Expected: no output.

- [ ] **Step 6: Commit**

```
git add src/components/layout/ChannelNotifPopover.vue src/components/layout/ChannelSidebar.vue
git commit -m "feat(notif): per-channel notification popover via right-click"
```

---

## Task 9: Initialize soundService from settings on app start

**Files:**
- Modify: `src/App.vue` (or wherever `settingsStore` is first initialized)

On app start, `soundService.loadFromSettings()` must be called so any persisted custom sound data URLs are loaded into the service before the first notification fires.

- [ ] **Step 1: Find where app setup runs**

Look at `src/App.vue` or `src/main.ts` to find where stores are initialized. The pattern is likely `cryptoService.init()` or `identityStore.loadIdentity()` being called in `App.vue`'s `onMounted`.

- [ ] **Step 2: Add soundService init**

In `src/App.vue`, add the import at the top of `<script setup>`:
```ts
import { soundService } from '@/services/soundService'
```

In the `onMounted` (or wherever other init runs), add:
```ts
const { useSettingsStore } = await import('@/stores/settingsStore')
soundService.loadFromSettings(useSettingsStore().settings.customSounds)
```

(If `settingsStore` is already imported in `App.vue`, use the existing import — don't add a dynamic import.)

- [ ] **Step 3: Verify build passes**

```
npm run build 2>&1 | Select-String "error TS"
```
Expected: no output.

- [ ] **Step 4: Run full test suite**

```
npm run test -- --run 2>&1 | Select-String "Tests|passed|failed"
```
Expected: all tests passing.

- [ ] **Step 5: Commit**

```
git add src/App.vue
git commit -m "feat(notif): initialize soundService custom sounds from persisted settings on startup"
```

---

## Task 10: Final integration smoke test + update TODO

- [ ] **Step 1: Run full test suite to confirm no regressions**

```
npm run test -- --run 2>&1 | Select-String "Tests|passed|failed"
```
Expected: all tests passing (≥ previous count + new suites).

- [ ] **Step 2: Run full build**

```
npm run build 2>&1 | Select-String "error TS|error:"
```
Expected: no errors.

- [ ] **Step 3: Update `docs/TODO.md`**

Find the Phase 6 notification items and tick them:
- `[ ] OS notifications` → `[x] OS notifications (notificationStore, isFocused fix)`
- `[ ] Sound system` → `[x] Sound system (Web Audio synth + file overrides)`
- `[ ] Per-server / channel notification settings` → `[x] Per-server / channel / keyword notification settings`

- [ ] **Step 4: Final commit**

```
git add docs/TODO.md
git commit -m "docs: tick notification system items in TODO.md"
```

---

## Implementation Notes for the Agentic Worker

### Key TypeScript patterns in this codebase
- All stores use `defineStore('id', () => { ... })` Setup Store pattern
- Circular store deps avoided via dynamic `await import('./otherStore')` inside actions (never top-level imports between stores)
- `<script setup>` only — no Options API
- Icons: always `<AppIcon :path="mdiSomeName" :size="N" />` — never raw `<svg>`
- Unused parameters prefixed with `_`

### Tauri v2 specifics
- Window focus: `import { getCurrentWindow } from '@tauri-apps/api/window'` then `getCurrentWindow().isFocused()` — NOT `appWindow.isFocused()` (that was v1)
- Notifications: `@tauri-apps/plugin-notification` — must be in `capabilities/default.json` (already added)

### Test environment
- `AudioContext` not available in jsdom — mock it as shown in Task 3 tests
- Dynamic imports inside store actions must be mocked with separate `vi.mock()` calls before `await import('../notificationStore')`
- `vi.resetModules()` between tests ensures fresh module state for the singleton `soundService`

### `openChannelMenu` in ChannelSidebar.vue — current structure
Before editing in Task 8, read the full `openChannelMenu` function to understand how it builds the items array. The function takes `(e: MouseEvent, channelId: string)` and builds an array of `MenuItem` objects before calling `uiStore.showContextMenu(items, e)`. Add the notification item to that array.
