/**
 * signalingService — abstracts the signaling transport layer.
 *
 * Routes through the Rust WS actor (rendezvous server) or directly
 * via WebRTC data channels (peer-relay). The WebRTC layer and
 * networkStore don't need to know which transport is active.
 */

import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

export type SignalPayload = {
  type: string
  [key: string]: unknown
}

export type SignalMessageHandler = (payload: SignalPayload) => void
export type SignalStateHandler = (state: string) => void

class SignalingService {
  private messageHandler: SignalMessageHandler | null = null
  private stateHandler: SignalStateHandler | null = null
  private unlistenMessage: UnlistenFn | null = null
  private unlistenState: UnlistenFn | null = null

  /**
   * Register handlers for incoming signals and state changes.
   * Must be called before connect().
   */
  async init(
    onMessage: SignalMessageHandler,
    onState: SignalStateHandler,
  ): Promise<void> {
    this.messageHandler = onMessage
    this.stateHandler = onState

    // Listen to Tauri events emitted by the Rust WS actor
    this.unlistenMessage = await listen<SignalPayload>('signal_message', (event) => {
      this.messageHandler?.(event.payload)
    })

    this.unlistenState = await listen<string>('signal_state', (event) => {
      this.stateHandler?.(event.payload)
    })
  }

  /**
   * Connect to a signaling server via WebSocket (Rust backend).
   */
  async connect(url: string): Promise<void> {
    await invoke('signal_connect', { url })
  }

  /**
   * Disconnect from the signaling server.
   */
  async disconnect(): Promise<void> {
    await invoke('signal_disconnect')
  }

  /**
   * Send a signaling payload through the active connection.
   */
  async send(payload: SignalPayload): Promise<void> {
    await invoke('signal_send', { payload })
  }

  /**
   * Clean up event listeners.
   */
  destroy(): void {
    this.unlistenMessage?.()
    this.unlistenState?.()
    this.unlistenMessage = null
    this.unlistenState = null
    this.messageHandler = null
    this.stateHandler = null
  }
}

export const signalingService = new SignalingService()
