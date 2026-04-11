/**
 * audioService — event-driven VAD layer.
 *
 * All audio processing (capture, encode, decode, playback, VAD) is now
 * handled in Rust via MediaManager. This service just:
 * 1. Subscribes to Rust `media_vad` events
 * 2. Forwards speaking-state changes to voiceStore
 *
 * Legacy method signatures are kept as no-ops for backward compatibility
 * during the transition.
 */

import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { invoke } from '@tauri-apps/api/core'

export type SpeakingChangeCallback = (userId: string, speaking: boolean) => void

class AudioServiceUI {
  private onSpeakingChange: SpeakingChangeCallback | null = null
  private unlistenVad: UnlistenFn | null = null

  init(onSpeakingChange: SpeakingChangeCallback): void {
    this.onSpeakingChange = onSpeakingChange
    this._subscribe()
  }

  private async _subscribe(): Promise<void> {
    this.unlistenVad = await listen<{ userId: string; speaking: boolean }>(
      'media_vad',
      ({ payload }) => this._handleVadEvent(payload),
    )
  }

  /** Exposed for testing — called by the Tauri event listener. */
  _handleVadEvent(payload: { userId: string; speaking: boolean }): void {
    this.onSpeakingChange?.(payload.userId, payload.speaking)
  }

  destroy(): void {
    this.unlistenVad?.()
    this.unlistenVad = null
  }

  // ── Legacy API — no-ops (Rust handles everything) ────────────────────────

  setLocalStream(_stream: MediaStream): void { /* no-op */ }
  setLocalMuted(_muted: boolean): void { /* Rust: media_set_muted */ }
  setDeafened(_deafened: boolean): void { /* Rust: media_set_deafened */ }
  attachRemoteStream(_userId: string, _stream: MediaStream): void { /* Rust handles */ }
  detachRemoteStream(_userId: string): void { /* Rust handles */ }
  detachAll(): void { /* Rust: stop_all_remote_playback */ }
  setLoopback(_enabled: boolean): void { /* Rust: media_set_loopback */ }

  setPeerVolume(userId: string, volume: number): void {
    invoke('media_set_peer_volume', { peerId: userId, volume: Math.max(0, volume) }).catch(() => {})
  }

  setPersonallyMuted(userId: string, muted: boolean): void {
    invoke('media_set_peer_volume', { peerId: userId, volume: muted ? 0 : 1 }).catch(() => {})
  }

  async setInputDevice(deviceId: string): Promise<void> {
    await invoke('media_set_input_device', { deviceName: deviceId || null })
  }
}

export const audioService = new AudioServiceUI()
