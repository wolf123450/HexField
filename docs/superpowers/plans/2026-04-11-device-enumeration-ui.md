# Device Enumeration UI (Phase C) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Testing approach:** TDD — write failing tests first, then implement. After every 2–3 tasks, run the E2E smoke tests (`npm run test:e2e` or manually via `scripts/e2e-integration.mjs`) to verify nothing regressed.
>
> **Prerequisite:** Phase A (Rust-Native Audio) must be completed first. Phase A provides the `MediaManager` struct, `media_enumerate_devices` / `media_set_input_device` / `media_set_output_device` Tauri commands, and the Rust audio pipeline that this plan's UI wraps. Phase B (Screen Share) is NOT required — Phase C is purely about audio device management.

**Goal:** Replace the browser-based `navigator.mediaDevices.enumerateDevices()` UI with a Rust-backed audio device management system. Settings shows devices from `invoke('media_enumerate_devices')`, supports mid-call device hot-swap, detects device plug/unplug events, validates stored device IDs, provides per-peer volume sliders, and gracefully falls back to defaults when a saved device is unavailable.

**Architecture:** The `MediaManager` (Phase A) already exposes `enumerate_devices()`, `set_input_device()`, and `set_output_device()` via Tauri commands. Phase C adds:
1. A `media_devices_changed` Tauri event emitted when cpal detects device list changes (polled every 3 seconds since cpal lacks native hot-plug callbacks).
2. A device selector dropdown in `VoiceBar.vue` for quick mid-call switching.
3. Updated `SettingsVoiceTab.vue` that reads device lists from Rust instead of the browser.
4. Per-peer volume sliders in the voice peer tiles.
5. Device validation on voice join — if the saved device is missing, fall back to default and notify the user.

**Key design decisions:**
- **No browser audio API usage.** All device enumeration, selection, and audio I/O goes through Rust/cpal. The browser's `navigator.mediaDevices` is no longer called anywhere in the app.
- **Device IDs = device names.** cpal identifies devices by name (string). This is stored in `settingsStore.settings.inputDeviceId` / `outputDeviceId`. Empty string = system default.
- **Hot-plug polling.** cpal doesn't provide a native `ondevicechange` callback on all platforms. We poll `enumerate_devices()` every 3 seconds in a background Rust task and emit `media_devices_changed` only when the list actually changes.
- **Graceful fallback.** If a saved device name is not found in the current device list, the system default is used and a notification is shown.

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `src-tauri/src/media_manager.rs` | Modify | Add device change polling task, device validation helper |
| `src-tauri/src/commands/media_commands.rs` | Modify | Add `media_start_device_watcher` / `media_stop_device_watcher` commands (if not auto-started) |
| `src-tauri/src/lib.rs` | Modify | Start device watcher on app setup (or on first voice join) |
| `src/components/settings/SettingsVoiceTab.vue` | Modify | Replace `navigator.mediaDevices.enumerateDevices()` with `invoke('media_enumerate_devices')`, listen for `media_devices_changed` |
| `src/components/chat/VoiceBar.vue` | Modify | Add device quick-switch dropdown (input + output) |
| `src/components/chat/VoiceContentPane.vue` | Modify | Add per-peer volume slider to peer tiles |
| `src/stores/voiceStore.ts` | Modify | Add device validation on join, mid-call device swap via `invoke('media_set_input_device')` |
| `src/stores/settingsStore.ts` | Modify | No structural changes — just ensure `inputDeviceId` / `outputDeviceId` store device names (already strings) |
| `src/services/audioService.ts` | Modify | Remove remaining browser `enumerateDevices` / `getUserMedia` / `setSinkId` calls if any survive Phase A |

---

## Event Contract

New Tauri events (**Rust → frontend**):

| Event name | Payload | When |
|---|---|---|
| `media_devices_changed` | `{ inputs: AudioDeviceInfo[], outputs: AudioDeviceInfo[] }` | Device list changed (new device plugged in, device removed, etc.) |

Existing events used:

| Event name | From | Usage |
|---|---|---|
| `media_mic_started` | Phase A | Shows current device name in UI |
| `media_error` | Phase A | Shows notification when device fails (e.g., unplugged mid-call) |

---

## Task 1: Device Change Polling in MediaManager

**Files:**
- Modify: `src-tauri/src/media_manager.rs`

Add a background task that polls `cpal::default_host()` for device list changes every 3 seconds and emits a Tauri event when a change is detected.

- [ ] **Step 1: Write the device list comparison test**

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_device_list_diff_detects_changes() {
        let list_a = AudioDeviceList {
            inputs: vec![
                AudioDeviceInfo { id: "Mic 1".into(), name: "Mic 1".into() },
                AudioDeviceInfo { id: "Mic 2".into(), name: "Mic 2".into() },
            ],
            outputs: vec![
                AudioDeviceInfo { id: "Speaker 1".into(), name: "Speaker 1".into() },
            ],
        };
        let list_b = AudioDeviceList {
            inputs: vec![
                AudioDeviceInfo { id: "Mic 1".into(), name: "Mic 1".into() },
                // Mic 2 removed
            ],
            outputs: vec![
                AudioDeviceInfo { id: "Speaker 1".into(), name: "Speaker 1".into() },
                AudioDeviceInfo { id: "Speaker 2".into(), name: "Speaker 2".into() }, // added
            ],
        };

        assert!(!device_lists_equal(&list_a, &list_a)); // equal
        assert!(device_lists_equal(&list_a, &list_b));   // different
    }
}
```

Note: The test name for the equality check helper — the exact assertion direction will match the implementation.

- [ ] **Step 2: Run test to verify it fails**

```bash
cd src-tauri && cargo test test_device_list_diff_detects_changes
```

- [ ] **Step 3: Implement the comparison helper**

```rust
/// Compare two device lists by ID sets. Returns true if they differ.
fn device_lists_differ(a: &AudioDeviceList, b: &AudioDeviceList) -> bool {
    if a.inputs.len() != b.inputs.len() || a.outputs.len() != b.outputs.len() {
        return true;
    }
    let a_input_ids: std::collections::HashSet<&str> =
        a.inputs.iter().map(|d| d.id.as_str()).collect();
    let b_input_ids: std::collections::HashSet<&str> =
        b.inputs.iter().map(|d| d.id.as_str()).collect();
    if a_input_ids != b_input_ids {
        return true;
    }
    let a_output_ids: std::collections::HashSet<&str> =
        a.outputs.iter().map(|d| d.id.as_str()).collect();
    let b_output_ids: std::collections::HashSet<&str> =
        b.outputs.iter().map(|d| d.id.as_str()).collect();
    a_output_ids != b_output_ids
}
```

- [ ] **Step 4: Implement the device watcher task**

Add to `MediaManager`:

```rust
/// Handle to the device watcher background task
device_watcher: Arc<Mutex<Option<tokio::task::JoinHandle<()>>>>,
```

```rust
impl MediaManager {
    /// Start polling for device changes. Emits `media_devices_changed` when
    /// the device list changes. Polling interval: 3 seconds.
    pub fn start_device_watcher(&self, app: tauri::AppHandle) {
        let watcher = self.device_watcher.clone();
        let task = tokio::spawn(async move {
            let mut last_list: Option<AudioDeviceList> = None;
            loop {
                tokio::time::sleep(std::time::Duration::from_secs(3)).await;

                // enumerate_devices is sync (cpal) — run in blocking context
                let current = tokio::task::spawn_blocking(|| {
                    let host = cpal::default_host();
                    // ... same enumeration logic as enumerate_devices()
                    // Factor into a static helper to avoid duplication
                    Self::enumerate_devices_inner()
                })
                .await
                .unwrap_or_else(|_| AudioDeviceList {
                    inputs: vec![],
                    outputs: vec![],
                });

                let changed = match &last_list {
                    None => true, // First run — always emit
                    Some(prev) => device_lists_differ(prev, &current),
                };

                if changed {
                    let _ = app.emit("media_devices_changed", &current);
                    last_list = Some(current);
                }
            }
        });

        // Store task handle so we can cancel it later
        let watcher2 = self.device_watcher.clone();
        tokio::spawn(async move {
            *watcher2.lock().await = Some(task);
        });
    }

    /// Stop the device watcher.
    pub async fn stop_device_watcher(&self) {
        if let Some(task) = self.device_watcher.lock().await.take() {
            task.abort();
        }
    }
}
```

- [ ] **Step 5: Auto-start watcher on app setup**

In `lib.rs` setup, after creating `AppState`, call:

```rust
state.media_manager.start_device_watcher(app.handle().clone());
```

- [ ] **Step 6: Run test + verify compile**

```bash
cd src-tauri && cargo test test_device_list_diff
cd src-tauri && cargo check
```

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat(media): device change polling with Tauri event emission"
```

---

## Task 2: Update SettingsVoiceTab to Use Rust Device Enumeration

**Files:**
- Modify: `src/components/settings/SettingsVoiceTab.vue`

Replace `navigator.mediaDevices.enumerateDevices()` with Rust-backed enumeration.

- [ ] **Step 1: Write component test**

In `src/components/settings/__tests__/SettingsVoiceTab.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { createTestingPinia } from '@pinia/testing'
import { invoke } from '@tauri-apps/api/core'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}))

describe('SettingsVoiceTab', () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset()
  })

  it('calls media_enumerate_devices on mount', async () => {
    vi.mocked(invoke).mockResolvedValueOnce({
      inputs: [{ id: 'Mic 1', name: 'Mic 1' }],
      outputs: [{ id: 'Speakers', name: 'Speakers' }],
    })

    // mount component...
    // expect(invoke).toHaveBeenCalledWith('media_enumerate_devices')
  })

  it('updates dropdown when media_devices_changed fires', async () => {
    // Simulate event and verify dropdown options update
  })
})
```

- [ ] **Step 2: Replace browser enumeration with Rust invoke**

In the `<script setup>` block, replace:

```ts
// OLD:
const devices = await navigator.mediaDevices.enumerateDevices()
audioInputs.value = devices.filter(d => d.kind === 'audioinput')
audioOutputs.value = devices.filter(d => d.kind === 'audiooutput')
```

With:

```ts
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'

interface AudioDeviceInfo {
  id: string
  name: string
}

interface AudioDeviceList {
  inputs: AudioDeviceInfo[]
  outputs: AudioDeviceInfo[]
}

const audioInputs = ref<AudioDeviceInfo[]>([])
const audioOutputs = ref<AudioDeviceInfo[]>([])

async function refreshDevices() {
  try {
    const list = await invoke<AudioDeviceList>('media_enumerate_devices')
    audioInputs.value = list.inputs
    audioOutputs.value = list.outputs
  } catch (e) {
    console.error('[Settings] device enumeration failed:', e)
  }
}

onMounted(async () => {
  await refreshDevices()

  // Listen for hot-plug/unplug events
  const unlisten = await listen<AudioDeviceList>('media_devices_changed', (event) => {
    audioInputs.value = event.payload.inputs
    audioOutputs.value = event.payload.outputs
  })

  onUnmounted(() => unlisten())
})
```

- [ ] **Step 3: Update the dropdown `<select>` elements**

The `<option>` elements now iterate over `AudioDeviceInfo` (which has `id` and `name`) instead of `MediaDeviceInfo` (which has `deviceId` and `label`):

```html
<select v-model="inputDevice" class="form-select" @change="saveInputDevice">
  <option value="">Default</option>
  <option v-for="d in audioInputs" :key="d.id" :value="d.id">
    {{ d.name }}
  </option>
</select>
```

Same for output device.

- [ ] **Step 4: Wire device selection to Rust**

Update the save handlers to call Rust:

```ts
async function saveInputDevice() {
  settingsStore.updateSetting('inputDeviceId', inputDevice.value)
  try {
    await invoke('media_set_input_device', {
      deviceId: inputDevice.value || null,
    })
  } catch (e) {
    console.error('[Settings] set input device failed:', e)
  }
}

async function saveOutputDevice() {
  settingsStore.updateSetting('outputDeviceId', outputDevice.value)
  try {
    await invoke('media_set_output_device', {
      deviceId: outputDevice.value || null,
    })
  } catch (e) {
    console.error('[Settings] set output device failed:', e)
  }
}
```

- [ ] **Step 5: Add "device missing" warning**

Show a warning badge next to the dropdown if the saved device ID doesn't appear in the current device list:

```ts
const inputDeviceMissing = computed(() =>
  inputDevice.value !== '' &&
  !audioInputs.value.some(d => d.id === inputDevice.value)
)

const outputDeviceMissing = computed(() =>
  outputDevice.value !== '' &&
  !audioOutputs.value.some(d => d.id === outputDevice.value)
)
```

```html
<div v-if="inputDeviceMissing" class="device-warning">
  ⚠ Selected device not found — Default will be used
</div>
```

- [ ] **Step 6: Verify frontend build**

```bash
npm run build
```

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat(settings): replace browser device enum with Rust-backed enumeration"
```

---

## Task 3: Device Validation on Voice Join

**Files:**
- Modify: `src/stores/voiceStore.ts`

When the user joins a voice channel, validate that the configured input device still exists. If not, fall back to default and show a notification.

- [ ] **Step 1: Write the validation test**

In `src/stores/__tests__/voiceStore.test.ts`, add:

```ts
it('falls back to default if saved input device is missing', async () => {
  vi.mocked(invoke).mockImplementation(async (cmd: string) => {
    if (cmd === 'media_enumerate_devices') {
      return { inputs: [{ id: 'Other Mic', name: 'Other Mic' }], outputs: [] }
    }
    if (cmd === 'media_start_mic') return undefined
    // ... other mocks
  })

  settingsStore.settings.inputDeviceId = 'Missing Mic'
  await voiceStore.joinVoiceChannel('ch1', 'srv1')
  // Should have called media_start_mic without specifying the missing device
  expect(invoke).toHaveBeenCalledWith('media_start_mic', expect.objectContaining({
    deviceId: null, // null = use default
  }))
})
```

- [ ] **Step 2: Add validation logic to joinVoiceChannel**

In `voiceStore.ts`, before calling `invoke('media_start_mic')`:

```ts
async function joinVoiceChannel(channelId: string, serverId: string): Promise<void> {
  // ... existing session checks ...

  const { useSettingsStore } = await import('./settingsStore')
  const settingsStore = useSettingsStore()
  let inputDeviceId: string | null = settingsStore.settings.inputDeviceId || null

  // Validate that the configured device still exists
  if (inputDeviceId) {
    try {
      const devices = await invoke<{ inputs: { id: string }[] }>('media_enumerate_devices')
      const found = devices.inputs.some(d => d.id === inputDeviceId)
      if (!found) {
        const { useUIStore } = await import('./uiStore')
        useUIStore().showNotification({
          type: 'warning',
          title: 'Audio Device Missing',
          message: `"${inputDeviceId}" not found. Using default device.`,
        })
        inputDeviceId = null
      }
    } catch {
      // Enumeration failed — proceed with default
      inputDeviceId = null
    }
  }

  // Start mic capture via Rust
  await invoke('media_start_mic', { deviceId: inputDeviceId })

  // ... rest of join flow (session setup, broadcast, etc.)
}
```

- [ ] **Step 3: Run test**

```bash
npm run test -- --grep "falls back to default"
```

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat(voice): validate audio device on join with graceful fallback"
```

---

## Task 4: Mid-Call Device Quick-Switch in VoiceBar

**Files:**
- Modify: `src/components/chat/VoiceBar.vue`
- Modify: `src/stores/voiceStore.ts`

Add a dropdown button near the mute button that shows available input/output devices for quick switching during an active voice session.

- [ ] **Step 1: Add `switchDevice` action to voiceStore**

```ts
async function switchInputDevice(deviceId: string | null): Promise<void> {
  try {
    await invoke('media_set_input_device', { deviceId })
    // If mic is active, restart it with the new device
    if (session.value) {
      await invoke('media_stop_mic')
      await invoke('media_start_mic', { deviceId })
    }
    // Persist the choice
    const { useSettingsStore } = await import('./settingsStore')
    useSettingsStore().updateSetting('inputDeviceId', deviceId ?? '')
  } catch (e) {
    const { useUIStore } = await import('./uiStore')
    useUIStore().showNotification({
      type: 'error',
      title: 'Device Switch Failed',
      message: String(e),
    })
  }
}

async function switchOutputDevice(deviceId: string | null): Promise<void> {
  try {
    await invoke('media_set_output_device', { deviceId })
    const { useSettingsStore } = await import('./settingsStore')
    useSettingsStore().updateSetting('outputDeviceId', deviceId ?? '')
  } catch (e) {
    const { useUIStore } = await import('./uiStore')
    useUIStore().showNotification({
      type: 'error',
      title: 'Output Device Switch Failed',
      message: String(e),
    })
  }
}
```

- [ ] **Step 2: Add device menu UI to VoiceBar**

Add a small dropdown/popover attached to a button next to the mute button:

```vue
<script setup>
import { ref, onMounted, onUnmounted } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { mdiChevronUp, mdiMicrophone, mdiVolumeHigh } from '@mdi/js'

const showDeviceMenu = ref(false)
const audioInputs = ref<{ id: string; name: string }[]>([])
const audioOutputs = ref<{ id: string; name: string }[]>([])

async function refreshDeviceList() {
  const list = await invoke<{ inputs: typeof audioInputs.value; outputs: typeof audioOutputs.value }>('media_enumerate_devices')
  audioInputs.value = list.inputs
  audioOutputs.value = list.outputs
}

// Refresh when menu opens
async function toggleDeviceMenu() {
  showDeviceMenu.value = !showDeviceMenu.value
  if (showDeviceMenu.value) await refreshDeviceList()
}

// Also update on hot-plug
let unlisten: (() => void) | null = null
onMounted(async () => {
  unlisten = await listen('media_devices_changed', (event) => {
    audioInputs.value = event.payload.inputs
    audioOutputs.value = event.payload.outputs
  })
})
onUnmounted(() => unlisten?.())
</script>
```

```html
<!-- Next to the mute button, a small chevron opens device picker -->
<div class="device-menu-anchor">
  <button class="device-menu-btn" @click="toggleDeviceMenu" title="Change audio device">
    <AppIcon :path="mdiChevronUp" :size="14" />
  </button>

  <div v-if="showDeviceMenu" class="device-menu" @click.stop>
    <div class="device-section">
      <div class="device-section-label">
        <AppIcon :path="mdiMicrophone" :size="14" /> Input
      </div>
      <button
        v-for="d in audioInputs"
        :key="d.id"
        class="device-option"
        :class="{ active: d.id === settingsStore.settings.inputDeviceId }"
        @click="voiceStore.switchInputDevice(d.id); showDeviceMenu = false"
      >
        {{ d.name }}
      </button>
      <button
        class="device-option"
        :class="{ active: !settingsStore.settings.inputDeviceId }"
        @click="voiceStore.switchInputDevice(null); showDeviceMenu = false"
      >
        Default
      </button>
    </div>

    <div class="device-section">
      <div class="device-section-label">
        <AppIcon :path="mdiVolumeHigh" :size="14" /> Output
      </div>
      <button
        v-for="d in audioOutputs"
        :key="d.id"
        class="device-option"
        :class="{ active: d.id === settingsStore.settings.outputDeviceId }"
        @click="voiceStore.switchOutputDevice(d.id); showDeviceMenu = false"
      >
        {{ d.name }}
      </button>
      <button
        class="device-option"
        :class="{ active: !settingsStore.settings.outputDeviceId }"
        @click="voiceStore.switchOutputDevice(null); showDeviceMenu = false"
      >
        Default
      </button>
    </div>
  </div>
</div>
```

- [ ] **Step 3: Style the device menu**

```css
.device-menu-anchor {
  position: relative;
}

.device-menu-btn {
  padding: 0;
  transform: none;
  background: none;
  border: none;
  color: var(--text-secondary);
  cursor: pointer;
  width: 20px;
  height: 20px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-sm);
}

.device-menu-btn:hover {
  background: var(--bg-tertiary);
  color: var(--text-primary);
}

.device-menu {
  position: absolute;
  bottom: 100%;
  left: 50%;
  transform: translateX(-50%);
  margin-bottom: var(--spacing-sm);
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  min-width: 240px;
  max-height: 300px;
  overflow-y: auto;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);
  z-index: 100;
}

.device-section {
  padding: var(--spacing-sm);
}

.device-section + .device-section {
  border-top: 1px solid var(--border-color);
}

.device-section-label {
  display: flex;
  align-items: center;
  gap: var(--spacing-xs);
  font-size: 0.6875rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-tertiary);
  padding: var(--spacing-xs) var(--spacing-sm);
}

.device-option {
  display: block;
  width: 100%;
  text-align: left;
  padding: var(--spacing-xs) var(--spacing-sm);
  transform: none;
  background: none;
  border: none;
  border-radius: var(--radius-sm);
  color: var(--text-secondary);
  font-size: 0.8125rem;
  cursor: pointer;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.device-option:hover {
  background: var(--bg-tertiary);
  color: var(--text-primary);
}

.device-option.active {
  color: var(--accent-color);
}
```

- [ ] **Step 4: Close menu on outside click**

Add a click-outside handler (use existing `v-click-outside` directive if available, or a simple document listener):

```ts
function onDocClick(e: MouseEvent) {
  if (showDeviceMenu.value) showDeviceMenu.value = false
}
onMounted(() => document.addEventListener('click', onDocClick))
onUnmounted(() => document.removeEventListener('click', onDocClick))
```

- [ ] **Step 5: Verify frontend build**

```bash
npm run build
```

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(voice): mid-call device quick-switch dropdown in VoiceBar"
```

---

## Task 5: Per-Peer Volume Slider in Voice Tiles

**Files:**
- Modify: `src/components/chat/VoiceContentPane.vue`
- Modify: `src/stores/voiceStore.ts`

Add a volume slider to each remote peer's voice tile so users can adjust individual volumes.

- [ ] **Step 1: Add per-peer volume state to voiceStore**

```ts
const peerVolumes = ref<Record<string, number>>({})  // 0.0 – 2.0, default 1.0

function getPeerVolume(userId: string): number {
  return peerVolumes.value[userId] ?? 1.0
}

async function setPeerVolume(userId: string, volume: number): Promise<void> {
  peerVolumes.value[userId] = volume
  try {
    await invoke('media_set_peer_volume', {
      peerId: userId,
      volume: Math.max(0, Math.min(2, volume)),
    })
  } catch (e) {
    console.warn('[voice] setPeerVolume failed:', e)
  }
}
```

- [ ] **Step 2: Add volume slider to peer tile in VoiceContentPane**

For each remote peer tile (non-self, non-screen-share), add a volume slider that appears on hover or click:

```html
<div class="peer-tile" @mouseenter="hoveredPeer = userId" @mouseleave="hoveredPeer = null">
  <!-- existing avatar / speaking ring / name -->

  <div v-if="hoveredPeer === userId" class="volume-control">
    <AppIcon :path="mdiVolumeHigh" :size="14" />
    <input
      type="range"
      min="0"
      max="200"
      :value="voiceStore.getPeerVolume(userId) * 100"
      @input="voiceStore.setPeerVolume(userId, Number(($event.target as HTMLInputElement).value) / 100)"
      class="volume-slider"
    />
    <span class="volume-label">{{ Math.round(voiceStore.getPeerVolume(userId) * 100) }}%</span>
  </div>
</div>
```

- [ ] **Step 3: Style the volume slider**

```css
.volume-control {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  display: flex;
  align-items: center;
  gap: var(--spacing-xs);
  padding: var(--spacing-xs) var(--spacing-sm);
  background: rgba(0, 0, 0, 0.7);
  border-radius: 0 0 var(--radius-md) var(--radius-md);
  color: var(--text-secondary);
}

.volume-slider {
  flex: 1;
  height: 4px;
  -webkit-appearance: none;
  appearance: none;
  background: var(--bg-tertiary);
  border-radius: 2px;
  outline: none;
}

.volume-slider::-webkit-slider-thumb {
  -webkit-appearance: none;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: var(--accent-color);
  cursor: pointer;
}

.volume-label {
  font-size: 0.6875rem;
  min-width: 32px;
  text-align: right;
  color: var(--text-tertiary);
}
```

- [ ] **Step 4: Verify frontend build**

```bash
npm run build
```

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(voice): per-peer volume slider in voice tiles"
```

---

## Task 6: Remove All Browser Audio API Usage

**Files:**
- Modify: `src/services/audioService.ts`
- Modify: `src/components/settings/SettingsVoiceTab.vue`
- Modify: `src/stores/voiceStore.ts`

Final cleanup pass — ensure no `navigator.mediaDevices`, `getUserMedia`, `enumerateDevices`, or `AudioContext` usage remains. All audio goes through Rust.

- [ ] **Step 1: Audit for remaining browser audio API calls**

Search the codebase for:
- `navigator.mediaDevices`
- `getUserMedia`
- `enumerateDevices`
- `AudioContext`
- `new Audio(`
- `setSinkId`
- `MediaStream`

List every remaining occurrence per file.

- [ ] **Step 2: Remove or replace each occurrence**

For each remaining browser audio API call:
- If it's in `audioService.ts`: remove the method or replace with Rust-backed alternative (Phase A should have done most of this; clean up any stragglers)
- If it's in `voiceStore.ts`: should already be replaced by Phase A `invoke('media_start_mic')`; verify
- If it's in `SettingsVoiceTab.vue`: already replaced in Task 2; verify
- If it's in test mocks: update mocks to mock `invoke` instead

- [ ] **Step 3: Remove browser audio API type imports if no longer used**

Check for `MediaDeviceInfo`, `MediaStream`, `MediaStreamTrack` type references that are no longer needed.

- [ ] **Step 4: Verify build**

```bash
npm run build
cd src-tauri && cargo check
```

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "refactor: remove all browser audio API usage"
```

---

## Task 7: E2E Integration Verification

**Files:** None (testing only)

- [ ] **Step 1: Build everything**

```bash
npm run build
cd src-tauri && cargo check
```

- [ ] **Step 2: Run unit tests**

```bash
npm run test
cd src-tauri && cargo test
```

- [ ] **Step 3: Manual E2E verification**

Run two instances:
```bash
npm run dev:tauri
# In another terminal:
npm run dev:tauri -- bob
```

Verify:
1. Settings > Voice tab shows device list from Rust (not browser)
2. Changing input/output device in settings takes effect
3. Join voice channel — verify mic uses selected device
4. Mid-call: open device menu in VoiceBar, switch input — audio switches seamlessly
5. Mid-call: switch output — remote audio plays on new output
6. Unplug/replug a USB mic/headset — dropdown updates within ~3 seconds
7. Saved device is unplugged → join voice → notification shows fallback message, default device used
8. Per-peer volume slider works (adjust one peer's volume, others unaffected)

- [ ] **Step 4: Fix any issues found**

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "test: verify device enumeration UI E2E"
```

---

## Known Risks and Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| cpal device enumeration is slow on some platforms (>500ms) | UI freezes if called on main thread | Already async via `invoke` + Rust; the 3-second poll runs in background task |
| cpal device names change between sessions on ALSA (Linux) | Saved device ID won't match | May need platform-specific normalization; ALSA `hw:X,Y` → stable names |
| cpal has no native hot-plug event on Linux ALSA | Polling is the only option | 3-second poll is adequate; could reduce to 1 second if needed |
| Per-peer volume slider at 200% may clip/distort | Audio quality issues | Document that >100% amplifies; add clipping indicator or cap at 150% |
| Device menu in VoiceBar overlapping with edge of window | Popover position bug | Use dynamic positioning or flip direction based on available space |

---

## Implementation Order Dependencies

```
Task 1 (device watcher) ──────────────┐
                                       │
                    ┌──────────────────┤
                    ▼                  ▼
Task 2 (settings UI)     Task 3 (join validation)
                    │                  │
                    ▼                  ▼
            Task 4 (mid-call switch) ◄─┘
                    │
                    ▼
            Task 5 (per-peer volume)
                    │
                    ▼
            Task 6 (browser API cleanup)
                    │
                    ▼
            Task 7 (E2E verification)
```

**Parallelizable pairs:**
- Tasks 2 + 3 (settings UI + join validation — independent frontend work)
- Task 5 can start in parallel with Task 4 (different components)
