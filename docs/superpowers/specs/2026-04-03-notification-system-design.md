# Notification System Design

**Date:** 2026-04-03  
**Status:** Approved  
**Scope:** OS notifications (fixed), per-server/channel/keyword settings, sound system (Web Audio synth + file overrides), MIDI architecture note  
**Out of scope:** DMs (separate spec), MIDI piano roll UI (future spec)

---

## 1. Problem Statement

Two current failures:
1. **OS notifications never fire in Tauri** — `document.visibilityState` is always `'visible'` in a Tauri WebView even when the window is behind other apps. Fix: use `appWindow.isFocused()` from `@tauri-apps/api/window`.
2. **No sounds exist** — `soundEnabled` is a setting with no implementation behind it.

Additional scope requested: per-server and per-channel notification levels, keyword filters, and a sound system with synthesized defaults and user-uploadable overrides.

---

## 2. Data Model

### 2.1 New types in `src/types/core.ts`

```ts
export type NotificationLevel = 'all' | 'mentions' | 'muted'

export interface ServerNotificationPrefs {
  level: NotificationLevel   // default 'mentions'
  muteUntil?: number         // epoch ms; absence or past = not muted
}

export interface ChannelNotificationPrefs {
  level: NotificationLevel | 'inherit'  // 'inherit' = defer to server setting
  muteUntil?: number
}

export interface KeywordFilter {
  id: string                 // UUID v7
  keyword: string            // case-insensitive substring match
  serverId?: string          // undefined = applies globally across all servers
}

export type SoundEvent = 'message' | 'mention' | 'join_self' | 'join_other' | 'leave'
```

### 2.2 Additions to `UserSettings` in `src/stores/settingsStore.ts`

```ts
// Notifications
serverNotificationPrefs:  Record<string, ServerNotificationPrefs>
channelNotificationPrefs: Record<string, ChannelNotificationPrefs>
keywordFilters:           KeywordFilter[]
// Sounds
customSounds:             Partial<Record<SoundEvent, string>>  // data: URLs
```

Default values:
```ts
serverNotificationPrefs:  {}   // empty = use global notificationsEnabled
channelNotificationPrefs: {}   // empty = inherit from server
keywordFilters:           []
customSounds:             {}
```

### 2.3 Rules hierarchy

Evaluated top-down; first matching rule wins. "Block" means no OS notification and no sound. "Pass" means evaluate sound/OS notification.

```
1. Channel muteUntil active?           → BLOCK
2. Server muteUntil active?            → BLOCK
3. Channel level = 'muted'?            → BLOCK
4. Channel level = 'all'?              → PASS
5. Channel level = 'mentions'?         → PASS only if mention or keyword match
6. Channel level = 'inherit' (or absent)?
   → use server level (steps 7–8)
7. Server level = 'muted'?             → BLOCK
8. Server level = 'all'?               → PASS
9. Server level = 'mentions' (default if absent)?
   → PASS only if mention or keyword match
10. Global notificationsEnabled = false? → BLOCK (no OS notification, but still play sound if soundEnabled)
```

**Sound** follows the same rules except it is not suppressed by the global `notificationsEnabled` toggle — only by `soundEnabled` and mute rules.

---

## 3. Sound System

### 3.1 Architecture

**File:** `src/services/soundService.ts`

`SoundEvent` is defined in `src/types/core.ts` and imported here — it is not redeclared.

```ts
import type { SoundEvent } from '@/types/core'

/** Extension seam — MIDI backend will implement this interface */
interface SoundBackend {
  play(event: SoundEvent): Promise<void>
}

/** Public API */
export const soundService = {
  play(event: SoundEvent): Promise<void>,
  setCustomSound(event: SoundEvent, dataUrl: string): void,
  clearCustomSound(event: SoundEvent): void,
  /** Architecture note: future hook for MIDI backend
   * setMidiSequence(event: SoundEvent, sequence: MidiSequence): void
   */
}
```

The service lazily creates a single shared `AudioContext` (Web Audio rules require a user gesture before creation; the first `play()` call re-creates it if suspended).

### 3.2 Synthesized defaults (`SynthBackend`)

Each event is a small Web Audio patch using the oscillator + gain envelope pattern:

| Event | Wave | Frequency | Shape |
|---|---|---|---|
| `message` | sine | 880 Hz | single ding, 80ms attack/80ms decay |
| `mention` | triangle | C5 (523 Hz) → E5 (659 Hz) | two-tone chime, 150ms each, 20ms gap |
| `join_self` | sine | E4→G4→B4 (330→392→494 Hz) | ascending 3-note arp, 100ms per note |
| `join_other` | triangle | 660 Hz | single soft blip, 60ms attack/100ms decay |
| `leave` | sine | B4→G4 (494→392 Hz) | descending two-tone, 120ms each, fade out |

All sounds respect `AudioContext.destination` volume. Gain peaks at 0.3 to avoid jarring volume.

### 3.3 File override

`customSounds[event]` is a data URL (stored in `settingsStore.settings.customSounds`).  
On `play(event)`:
1. If `customSounds[event]` is set, attempt `audioCtx.decodeAudioData(base64→ArrayBuffer)`
2. On success, play via `AudioBufferSourceNode`
3. On decode failure, log a warning and fall back to `SynthBackend`

Supported upload formats: `.mp3`, `.ogg`, `.wav`, `.flac` (whatever the browser's WebAudio implementation accepts — no server-side transcoding needed).

Max upload size enforced in UI: 2 MB per sound.

### 3.4 MIDI architecture note (future, not implemented)

The MIDI piano roll feature will implement `SoundBackend` and call `soundService.setBackend(midiBackend)`. The `play(event)` signature is intentionally simple so the MIDI backend can look up a stored sequence keyed by `SoundEvent`. No changes to `notificationStore` or callers will be required.

---

## 4. `notificationStore`

**File:** `src/stores/notificationStore.ts`

### 4.1 Event type

```ts
export interface NotificationEvent {
  type: SoundEvent
  serverId?: string
  channelId?: string
  authorId?: string
  content?: string      // raw plaintext for mention/keyword detection
  titleText: string     // formatted OS notification title
  bodyText?: string     // formatted OS notification body (truncated to 120 chars)
}
```

### 4.2 Public API

```ts
export const useNotificationStore = defineStore('notifications', () => {
  async function notify(event: NotificationEvent): Promise<void>
  return { notify }
})
```

### 4.3 `notify()` logic

```
1. Evaluate rules hierarchy (§2.3) → { shouldNotifyOS, shouldPlaySound, passLevel }
   where passLevel = 'all' | 'mention_or_keyword' | 'blocked'
2. If passLevel === 'blocked': return early
3. If passLevel === 'mention_or_keyword':
   a. Check if content contains @myDisplayName (case-insensitive)
   b. Check if content matches any keywordFilter applicable to this server
   c. If neither: return early (neither OS notification nor sound)
4. shouldNotifyOS:
   a. import { getCurrentWindow } from '@tauri-apps/api/window'
   b. const focused = await getCurrentWindow().isFocused()
   c. If focused: skip OS notification (window is in front — user sees it)
   d. If !focused: sendNotification({ title: event.titleText, body: event.bodyText })
5. shouldPlaySound:
   a. If settingsStore.settings.soundEnabled: await soundService.play(event.type)
```

### 4.4 Callers

Remove `maybeNotify()` from `messagesStore`. All callers use `notificationStore.notify()`:

| Store / location | Event type | When |
|---|---|---|
| `messagesStore.onReceiveMessage()` | `'message'` or `'mention'` | On decrypted inbound message |
| `voiceStore` peer join handler | `'join_other'` | Remote peer joins voice channel |
| `voiceStore` peer leave handler | `'leave'` | Remote peer leaves voice channel |
| `voiceStore` self-join handler | `'join_self'` | Local user joins a voice channel |

**Mention vs message detection** (in `messagesStore`): if `plaintext.toLowerCase().includes('@' + myDisplayName.toLowerCase())`, emit type `'mention'`; otherwise `'message'`.

---

## 5. Settings UI

### 5.1 `SettingsNotificationsTab.vue` — full rewrite

Four sub-sections using the existing settings layout CSS classes:

#### A. Global Toggles (existing, kept)
- Enable desktop notifications (checkbox → `notificationsEnabled`)
- Play notification sounds (checkbox → `soundEnabled`)

#### B. Sound Customization (new)
One row per `SoundEvent`. Each row:
- Event label ("New message", "Mention", "You joined", "Someone joined", "Someone left")
- **Preview** button → calls `soundService.play(event)` live
- **Upload** button → `<input type="file" accept=".mp3,.ogg,.wav,.flac">` → reads as data URL → stores in `customSounds[event]`
- If custom sound set: shows filename (derived from data URL mime type) + **Reset** button → calls `soundService.clearCustomSound(event)`

Max file size validation: 2 MB, shown as inline error.

#### C. Per-Server Notification Prefs (new)
Iterates `serversStore.joinedServerIds`. For each server:
- Server name + icon
- Level dropdown: All Messages / Only Mentions / Muted
- Timed Mute button (dropdown: 1 hour / 8 hours / 24 hours / Until I unmute)
- Active mute shown as badge: "Muted until HH:MM" with an X to clear

#### D. Keyword Filters (new)
- Add row: text input + optional server scope dropdown (All Servers, or specific server name) + Add button
- List of existing filters: keyword text, scope badge, remove button (trash icon via `<AppIcon>`)
- Empty state: "No keyword filters. Keywords will trigger notifications even in muted channels."

### 5.2 Per-channel overrides via context menu

**File:** `src/utils/contextMenuResolver.ts` (existing)  
**File:** `src/components/layout/ChannelSidebar.vue` (existing)

Add a "Notification settings" item to the channel right-click context menu. Opens a small inline popover (not a full modal):
- Level dropdown: Inherit from server / All Messages / Only Mentions / Muted
- Timed mute option
- Rendered via a new `ChannelNotifPopover.vue` component positioned near the context menu target

This keeps the Settings tab clean — per-channel prefs are set inline where channels are shown.

---

## 6. Files Affected

| File | Change |
|---|---|
| `src/types/core.ts` | Add `NotificationLevel`, `ServerNotificationPrefs`, `ChannelNotificationPrefs`, `KeywordFilter`, `SoundEvent` |
| `src/stores/settingsStore.ts` | Add 4 new UserSettings fields + defaults |
| `src/services/soundService.ts` | **NEW** — SoundBackend interface, SynthBackend, file override |
| `src/stores/notificationStore.ts` | **NEW** — notify(), rules hierarchy, OS + sound dispatch |
| `src/stores/messagesStore.ts` | Remove maybeNotify(); call notificationStore.notify() |
| `src/stores/voiceStore.ts` | Call notificationStore.notify() for join/leave events |
| `src/components/settings/SettingsNotificationsTab.vue` | Full rewrite — 4 sections |
| `src/components/layout/ChannelSidebar.vue` | Add "Notification settings" to channel context menu |
| `src/utils/contextMenuResolver.ts` | Add channel notification menu item |
| `src/components/layout/ChannelNotifPopover.vue` | **NEW** — inline per-channel prefs popover |
| `src/stores/__tests__/notificationStore.test.ts` | **NEW** — rules hierarchy tests |
| `src/services/__tests__/soundService.test.ts` | **NEW** — play/override/fallback tests |

---

## 7. Testing Targets

### `notificationStore`
- `level='muted'` at channel → no OS notification, no sound
- `muteUntil` in past → not muted (rule passes through)
- `muteUntil` in future → blocked
- `level='all'` at server, no channel override → plays for non-mention messages
- `level='mentions'` at server → only fires on @mention
- Keyword match in muted server → still passes (keyword overrides mute? No — keywords do NOT override mute. Mute always wins.)
- Keyword match when level='mentions' → passes
- Window focused → OS notification suppressed, sound still plays
- Window not focused → OS notification fires

### `soundService`
- `play('message')` creates AudioContext + runs without throwing
- Custom sound set → decode attempted
- Custom sound decode failure → falls back to synth (no throw)
- `clearCustomSound` → reverts to synth

---

## 8. Open Questions / Deferred

- **Keyword mute override?** — Decision above: mute always wins over keywords. Keywords only help elevate `'mentions'`-level to pass. Document this behavior in UI hint text.
- **DM notifications** — deferred to DM system spec; `notificationStore.notify()` will accept `serverId: undefined` for DMs when that system exists.
- **MIDI piano roll** — separate future spec; plugs in via `SoundBackend` interface.
- **Notification history / inbox** — not in scope.
