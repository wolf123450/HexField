/**
 * webrtcService — manages WebRTC peer connections and data channels.
 *
 * Each peer gets one RTCPeerConnection with a reliable data channel
 * for messaging/sync, and optionally audio/video tracks for voice.
 */

import { signalingService } from './signalingService'

export type DataChannelMessageHandler = (userId: string, data: unknown) => void
export type RemoteTrackHandler        = (userId: string, stream: MediaStream, track: MediaStreamTrack) => void

const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
]

// ── Chunking constants ──────────────────────────────────────────────────────
// Chromium SCTP max message size is 256 KiB.  We chunk conservatively below
// that to avoid RTCError events that kill the data channel.
const MAX_SAFE_MSG_LEN = 200_000 // characters — messages under this are sent as-is
const CHUNK_RAW_BYTES  = 48_000  // raw UTF-8 bytes per chunk payload

// Helpers to convert between Uint8Array and base64 without stack overflow
function uint8ToBase64(bytes: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin)
}
function base64ToUint8(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

interface ChunkFrame {
  _c: string  // chunk group ID
  _i: number  // chunk index (0-based)
  _n: number  // total chunk count
  _d: string  // base64 payload slice
}

interface PeerState {
  pc: RTCPeerConnection
  dc: RTCDataChannel | null
  makingOffer: boolean
  localStream: MediaStream | null
}

class WebRTCService {
  private peers = new Map<string, PeerState>()
  private onDataMessage: DataChannelMessageHandler | null = null
  private onPeerConnected: ((userId: string) => void) | null = null
  private onPeerDisconnected: ((userId: string) => void) | null = null
  private onRemoteTrack: RemoteTrackHandler | null = null
  private localUserId = ''
  /** Per-peer chunk reassembly buffers: chunkId → { parts[], received, total } */
  private chunkBuffers = new Map<string, { parts: string[]; received: number; total: number }>()
  /** Pluggable ICE config builder — injected by networkStore after NAT detection. */
  private iceConfigBuilder: (userId: string) => RTCIceServer[] = () => DEFAULT_ICE_SERVERS

  /**
   * Override the ICE server list on a per-peer basis.
   * networkStore calls this once during init to inject relay peers + custom TURN.
   */
  setICEConfigBuilder(fn: (userId: string) => RTCIceServer[]): void {
    this.iceConfigBuilder = fn
  }

  /**
   * Set the local user ID and register handlers.
   */
  init(
    localUserId: string,
    onDataMessage: DataChannelMessageHandler,
    onPeerConnected?: (userId: string) => void,
    onPeerDisconnected?: (userId: string) => void,
    onRemoteTrack?: RemoteTrackHandler,
  ): void {
    this.localUserId = localUserId
    this.onDataMessage = onDataMessage
    this.onPeerConnected = onPeerConnected ?? null
    this.onPeerDisconnected = onPeerDisconnected ?? null
    this.onRemoteTrack = onRemoteTrack ?? null
  }

  /**
   * Create an outgoing connection to a peer.
   * Sets up the RTCPeerConnection and data channel; onnegotiationneeded fires
   * automatically and sends the actual SDP offer. If a connection already exists
   * we do nothing — further renegotiation (e.g. adding voice tracks) is handled
   * entirely by onnegotiationneeded to avoid m-line ordering violations.
   */
  async createOffer(userId: string): Promise<void> {
    if (this.peers.has(userId)) return
    this.getOrCreatePeer(userId, true)
    // onnegotiationneeded fires when the data channel is created and sends the offer.
  }

  /**
   * Handle an incoming SDP offer from a remote peer.
   */
  async handleOffer(userId: string, sdp: string): Promise<void> {
    // Safety net: if the existing peer connection is already dead (disconnected /
    // failed / closed — e.g. the remote restarted before onPeerDisconnected fired
    // locally) destroy it so we negotiate a completely fresh session.  Without
    // this, setRemoteDescription can throw an m-line ordering error when the new
    // offer has a different SDP history from the stale connection.
    const existing = this.peers.get(userId)
    if (existing) {
      const cs = existing.pc.connectionState
      if (cs === 'disconnected' || cs === 'failed' || cs === 'closed') {
        this.destroyPeer(userId)
      }
    }

    const state = this.getOrCreatePeer(userId, false)

    // Perfect negotiation: if we're making an offer too, the "polite" peer
    // (higher userId) rolls back. The "impolite" peer (lower userId) ignores.
    const isPolite = this.localUserId > userId
    const offerCollision = state.makingOffer || state.pc.signalingState !== 'stable'

    if (offerCollision && !isPolite) {
      // We're impolite — ignore the incoming offer
      return
    }

    if (offerCollision && isPolite) {
      // We're polite — rollback our offer
      await state.pc.setLocalDescription({ type: 'rollback' })
    }

    await state.pc.setRemoteDescription({ type: 'offer', sdp })
    const answer = await state.pc.createAnswer()
    await state.pc.setLocalDescription(answer)

    console.debug(`[webrtc] sending answer to ${userId.slice(0,8)}`)
    await signalingService.send({
      type: 'signal_answer',
      to: userId,
      from: this.localUserId,
      sdp: state.pc.localDescription!.sdp,
    })
  }

  /**
   * Handle an incoming SDP answer from a remote peer.
   */
  async handleAnswer(userId: string, sdp: string): Promise<void> {
    const state = this.peers.get(userId)
    if (!state) return
    await state.pc.setRemoteDescription({ type: 'answer', sdp })
  }

  /**
   * Handle an incoming ICE candidate from a remote peer.
   */
  async handleIceCandidate(userId: string, candidate: RTCIceCandidateInit): Promise<void> {
    const state = this.peers.get(userId)
    if (!state) return
    try {
      await state.pc.addIceCandidate(candidate)
    } catch (e) {
      // Ignore candidates that arrive before remote description is set
      if (state.pc.remoteDescription) {
        console.error('[webrtc] Failed to add ICE candidate:', e)
      }
    }
  }

  /**
   * Add a local audio track to all existing peer connections.
   * Triggers ICE renegotiation on each connection automatically.
   */
  addAudioTrack(track: MediaStreamTrack, stream: MediaStream): void {
    for (const [, state] of this.peers) {
      state.pc.addTrack(track, stream)
    }
  }

  /**
   * Add or replace the video (screen-share) track on all existing peer connections,
   * then optionally cap the outgoing bitrate.
   */
  addScreenShareTrack(track: MediaStreamTrack, maxBitrateKbps?: number): void {
    for (const [, state] of this.peers) {
      const sender = state.pc.getSenders().find(s => s.track?.kind === 'video')
      if (sender) {
        sender.replaceTrack(track).catch(e => console.error('[webrtc] replaceTrack error:', e))
        if (maxBitrateKbps != null) this._applyBitrateCap(sender, maxBitrateKbps)
      } else {
        const newSender = state.pc.addTrack(track)
        if (maxBitrateKbps != null) this._applyBitrateCap(newSender, maxBitrateKbps)
      }
    }
  }

  private _applyBitrateCap(sender: RTCRtpSender, maxBitrateKbps: number): void {
    const params = sender.getParameters()
    if (!params.encodings) params.encodings = [{}]
    params.encodings[0].maxBitrate = maxBitrateKbps * 1000
    sender.setParameters(params).catch(e => console.warn('[webrtc] setParameters error:', e))
  }

  /**
   * Remove the video (screen-share) track from all peer connections.
   */
  removeScreenShareTrack(): void {
    for (const [, state] of this.peers) {
      const sender = state.pc.getSenders().find(s => s.track?.kind === 'video')
      if (sender) {
        sender.replaceTrack(null).catch(e => console.error('[webrtc] removeTrack error:', e))
      }
    }
  }

  /**
   * Remove the audio track(s) from all peer connections (on voice leave).
   */
  removeAudioTracks(): void {
    for (const [, state] of this.peers) {
      const senders = state.pc.getSenders().filter(s => s.track?.kind === 'audio')
      for (const sender of senders) {
        state.pc.removeTrack(sender)
      }
    }
  }

  /**
   * Send data over the data channel to a specific peer.
   * Automatically chunks messages that exceed the SCTP safe limit.
   */
  sendToPeer(userId: string, data: unknown): boolean {
    const state = this.peers.get(userId)

    if (!state?.dc || state.dc.readyState !== 'open') return false
    this.sendViaChannel(state.dc, JSON.stringify(data))
    return true
  }

  /**
   * Broadcast data to all connected peers.
   * Automatically chunks messages that exceed the SCTP safe limit.
   */
  broadcast(data: unknown): void {
    const json = JSON.stringify(data)
    for (const [, state] of this.peers) {
      if (state.dc?.readyState === 'open') {
        this.sendViaChannel(state.dc, json)
      }
    }
  }

  /**
   * Send a JSON string through a data channel, chunking if necessary.
   * Messages under MAX_SAFE_MSG_LEN are sent as-is.
   * Larger messages are split into base64-encoded chunks that the receiver
   * reassembles transparently.
   */
  private sendViaChannel(dc: RTCDataChannel, json: string): void {
    if (json.length <= MAX_SAFE_MSG_LEN) {
      dc.send(json)
      return
    }
    const raw = new TextEncoder().encode(json)
    const id = Math.random().toString(36).slice(2, 8)
    const n = Math.ceil(raw.byteLength / CHUNK_RAW_BYTES)
    for (let i = 0; i < n; i++) {
      const slice = raw.subarray(i * CHUNK_RAW_BYTES, (i + 1) * CHUNK_RAW_BYTES)
      const frame: ChunkFrame = { _c: id, _i: i, _n: n, _d: uint8ToBase64(slice) }
      dc.send(JSON.stringify(frame))
    }
  }

  /**
   * Get list of connected peer user IDs.
   */
  getConnectedPeers(): string[] {
    const result: string[] = []
    for (const [userId, state] of this.peers) {
      if (state.dc?.readyState === 'open') {
        result.push(userId)
      }
    }
    return result
  }

  /**
   * Destroy a single peer connection.
   */
  destroyPeer(userId: string): void {
    const state = this.peers.get(userId)
    if (!state) return
    state.dc?.close()
    state.pc.close()
    this.peers.delete(userId)
  }

  /**
   * Destroy all peer connections.
   */
  destroyAll(): void {
    for (const [userId] of this.peers) {
      this.destroyPeer(userId)
    }
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  private getOrCreatePeer(userId: string, createDataChannel: boolean): PeerState {
    let state = this.peers.get(userId)
    if (state) return state

    const pc = new RTCPeerConnection({ iceServers: this.iceConfigBuilder(userId) })

    state = { pc, dc: null, makingOffer: false, localStream: null }
    this.peers.set(userId, state)

    // ICE candidate → send via signaling
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        signalingService.send({
          type: 'signal_ice',
          to: userId,
          from: this.localUserId,
          candidate: event.candidate.toJSON(),
        })
      }
    }

    // Connection state tracking — disconnection only.
    // onPeerConnected is fired from dc.onopen so the data channel
    // is guaranteed open before gossip/sync sends anything.
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        this.onPeerDisconnected?.(userId)
      }
    }

    // Remote media track handler (audio/video)
    pc.ontrack = (event) => {
      const stream = event.streams[0] ?? new MediaStream([event.track])
      this.onRemoteTrack?.(userId, stream, event.track)
    }

    // If we're the offerer, create the data channel
    if (createDataChannel) {
      const dc = pc.createDataChannel('hexfield', { ordered: true })
      this.setupDataChannel(userId, state, dc)
    }

    // If we're the answerer, wait for the remote data channel
    pc.ondatachannel = (event) => {
      this.setupDataChannel(userId, state!, event.channel)
    }

    // Negotiation needed (for renegotiation — fires when tracks are added/removed)
    pc.onnegotiationneeded = async () => {
      // Guard: only create an offer when signaling state is stable to avoid
      // m-line ordering violations that occur after perfect-negotiation rollbacks.
      if (pc.signalingState !== 'stable') return
      try {
        state!.makingOffer = true
        // Use implicit setLocalDescription() — browser handles offer creation
        // internally, preserving existing m-line indices correctly.
        await pc.setLocalDescription()
        await signalingService.send({
          type: 'signal_offer',
          to: userId,
          from: this.localUserId,
          sdp: pc.localDescription!.sdp,
        })
      } catch (e) {
        console.warn('[webrtc] onnegotiationneeded error:', e)
      } finally {
        state!.makingOffer = false
      }
    }

    return state
  }

  private setupDataChannel(userId: string, state: PeerState, dc: RTCDataChannel): void {
    state.dc = dc

    dc.onerror = (event) => {
      console.error(`[webrtc] DC error ${userId.slice(0,8)}:`, event)
    }

    dc.onopen = () => {
      console.debug(`[webrtc] Data channel open with ${userId}`)
      // Fire connected callback now that the DC is actually open and sendToPeer works.
      this.onPeerConnected?.(userId)
    }

    dc.onclose = () => {
      console.debug(`[webrtc] Data channel closed with ${userId}`)
    }

    dc.onmessage = (event) => {
      try {
        const parsed = JSON.parse(event.data)
        // Chunk frame — accumulate and reassemble
        if (parsed._c && typeof parsed._i === 'number' && typeof parsed._n === 'number') {
          this.handleChunkFrame(userId, parsed as ChunkFrame)
          return
        }
        this.onDataMessage?.(userId, parsed)
      } catch (e) {
        console.error('[webrtc] Failed to parse data channel message:', e)
      }
    }
  }

  /**
   * Reassemble a chunked message.  Chunks share a `_c` (chunk-group ID);
   * each carries a base64 slice of the original UTF-8 JSON bytes.
   * When all `_n` chunks have arrived they are concatenated, decoded,
   * parsed, and delivered as a single logical message.
   */
  private handleChunkFrame(userId: string, frame: ChunkFrame): void {
    let buf = this.chunkBuffers.get(frame._c)
    if (!buf) {
      buf = { parts: new Array<string>(frame._n), received: 0, total: frame._n }
      this.chunkBuffers.set(frame._c, buf)
    }
    buf.parts[frame._i] = frame._d
    buf.received++
    if (buf.received === buf.total) {
      this.chunkBuffers.delete(frame._c)
      try {
        const fullB64 = buf.parts.join('')
        const bytes = base64ToUint8(fullB64)
        const json = new TextDecoder().decode(bytes)
        const data = JSON.parse(json)
        this.onDataMessage?.(userId, data)
      } catch (e) {
        console.error('[webrtc] chunk reassembly failed:', e)
      }
    }
  }
}

export const webrtcService = new WebRTCService()
