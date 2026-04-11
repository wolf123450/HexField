/**
 * webrtcService.ts — Tauri IPC wrapper for the Rust WebRTC manager.
 *
 * The public API preserves the original browser-RTCPeerConnection implementation
 * so existing call sites (networkStore, voiceStore, syncService) need no changes
 * for Phase 1 (data channels only).
 *
 * Phase 2 (voice/screen tracks) will be implemented when the Rust manager gains
 * media track support; the stub methods below will be filled in then.
 */

import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { logger } from '@/utils/logger'

export type DataChannelMessageHandler = (userId: string, data: unknown) => void
export type RemoteTrackHandler = (userId: string, stream: MediaStream, track: MediaStreamTrack) => void

interface WebRtcConnEvent    { userId: string }
interface WebRtcDataEvent    { from: string; payload: string }

export class WebRTCService {
  private _onDataMessage: DataChannelMessageHandler | null = null
  private _onPeerConnected: ((userId: string) => void) | null = null
  private _onPeerDisconnected: ((userId: string) => void) | null = null
  private _unlisteners: UnlistenFn[] = []
  /** Cache of connected peer IDs, kept in sync via events. */
  private _connected = new Set<string>()

  /** Rust WebRTC is always available — the whole point of this rewrite. */
  static isAvailable(): boolean {
    return true
  }

  /**
   * Set the local user ID and register event handlers.
   * Synchronous wrapper — internal async work fires in the background.
   */
  init(
    localUserId: string,
    onDataMessage: DataChannelMessageHandler,
    onPeerConnected?: (userId: string) => void,
    onPeerDisconnected?: (userId: string) => void,
    _onRemoteTrack?: RemoteTrackHandler,
  ): void {
    this._onDataMessage = onDataMessage
    this._onPeerConnected = onPeerConnected ?? null
    this._onPeerDisconnected = onPeerDisconnected ?? null
    this._doInit(localUserId).catch(e => logger.warn('webrtc', 'init error:', e))
  }

  private async _doInit(localUserId: string): Promise<void> {
    // Remove any stale listeners from a previous init call
    for (const fn of this._unlisteners) fn()
    this._unlisteners = []
    this._connected.clear()

    await invoke('webrtc_init', { localUserId })

    // webrtc_connected — peer data channel open
    this._unlisteners.push(
      await listen<WebRtcConnEvent>('webrtc_connected', ({ payload }) => {
        this._connected.add(payload.userId)
        this._onPeerConnected?.(payload.userId)
      }),
    )

    // webrtc_disconnected — peer gone
    this._unlisteners.push(
      await listen<WebRtcConnEvent>('webrtc_disconnected', ({ payload }) => {
        this._connected.delete(payload.userId)
        this._onPeerDisconnected?.(payload.userId)
      }),
    )

    // webrtc_data — incoming message from peer (Rust sends JSON string)
    this._unlisteners.push(
      await listen<WebRtcDataEvent>('webrtc_data', ({ payload }) => {
        try {
          const parsed: unknown = JSON.parse(payload.payload)
          this._onDataMessage?.(payload.from, parsed)
        } catch (e) {
          logger.warn('webrtc', 'failed to parse incoming data:', e)
        }
      }),
    )
  }

  async createOffer(userId: string): Promise<void> {
    await invoke('webrtc_create_offer', { peerId: userId })
  }

  async handleOffer(userId: string, sdp: string): Promise<void> {
    await invoke('webrtc_handle_offer', { from: userId, sdp })
  }

  async handleAnswer(userId: string, sdp: string): Promise<void> {
    await invoke('webrtc_handle_answer', { from: userId, sdp })
  }

  async handleIceCandidate(userId: string, candidate: RTCIceCandidateInit): Promise<void> {
    await invoke('webrtc_add_ice', {
      from: userId,
      candidate: candidate.candidate ?? '',
      sdpMid: candidate.sdpMid ?? null,
      sdpMlineIndex: candidate.sdpMLineIndex ?? null,
    })
  }

  /**
   * Send data to a single peer. Returns false if the peer is not yet connected.
   * Data is JSON-serialized before passing to Rust.
   */
  sendToPeer(userId: string, data: unknown): boolean {
    if (!this._connected.has(userId)) return false
    const payload = JSON.stringify(data)
    invoke<boolean>('webrtc_send', { peerId: userId, data: payload }).catch(e =>
      logger.warn('webrtc', 'send failed:', e),
    )
    return true
  }

  broadcast(data: unknown): void {
    const payload = JSON.stringify(data)
    for (const id of this._connected) {
      invoke('webrtc_send', { peerId: id, data: payload }).catch(e =>
        logger.warn('webrtc', 'broadcast to', id, 'failed:', e),
      )
    }
  }

  destroyPeer(userId: string): void {
    this._connected.delete(userId)
    invoke('webrtc_close_peer', { peerId: userId }).catch(e =>
      logger.warn('webrtc', 'close_peer failed:', e),
    )
  }

  destroyAll(): void {
    this._connected.clear()
    invoke('webrtc_destroy_all').catch(e => logger.warn('webrtc', 'destroy_all failed:', e))
  }

  getConnectedPeers(): string[] {
    return Array.from(this._connected)
  }

  /**
   * No-op stub — ICE servers are now configured in the Rust WebRTCManager.
   * Kept for API compatibility with existing networkStore call sites.
   */
  setICEConfigBuilder(_fn: (userId: string) => RTCIceServer[]): void {
    // ICE configuration is handled in Rust (webrtc_manager.rs).
  }

  // ── Media control (Rust-native audio pipeline) ─────────────────────────────

  /**
   * Start mic capture in Rust. Audio flows entirely in Rust:
   * cpal → Opus encode → WebRTC track. No MediaStream crosses IPC.
   */
  async addAudioTrack(deviceId?: string): Promise<void> {
    await invoke('media_start_mic', { deviceId: deviceId ?? null })
  }

  /**
   * Stop mic capture and remove audio tracks from all peers.
   */
  async removeAudioTracks(): Promise<void> {
    await invoke('media_stop_mic')
  }

  /**
   * Start screen share via Rust xcap capture + openh264 encode + WebRTC video track.
   */
  async addScreenShareTrack(sourceId: string, fps?: number, bitrateKbps?: number): Promise<void> {
    await invoke('media_start_screen_share', {
      sourceId,
      fps: fps ?? 30,
      bitrateKbps: bitrateKbps ?? 0,
    })
  }

  async removeScreenShareTrack(): Promise<void> {
    await invoke('media_stop_screen_share')
  }
}

export const webrtcService = new WebRTCService()
