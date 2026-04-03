/**
 * webrtcService — manages WebRTC peer connections and data channels.
 *
 * Each peer gets one RTCPeerConnection with a reliable data channel
 * for messaging/sync, and optionally audio/video tracks for voice.
 */

import { signalingService } from './signalingService'

export type DataChannelMessageHandler = (userId: string, data: unknown) => void
export type RemoteTrackHandler        = (userId: string, stream: MediaStream, track: MediaStreamTrack) => void

const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
]

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
   * Generates an SDP offer and sends it via signaling.
   */
  async createOffer(userId: string): Promise<void> {
    const state = this.getOrCreatePeer(userId, true)
    state.makingOffer = true

    try {
      const offer = await state.pc.createOffer()
      await state.pc.setLocalDescription(offer)

      await signalingService.send({
        type: 'signal_offer',
        to: userId,
        from: this.localUserId,
        sdp: state.pc.localDescription!.sdp,
      })
    } finally {
      state.makingOffer = false
    }
  }

  /**
   * Handle an incoming SDP offer from a remote peer.
   */
  async handleOffer(userId: string, sdp: string): Promise<void> {
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
   */
  sendToPeer(userId: string, data: unknown): boolean {
    const state = this.peers.get(userId)
    if (!state?.dc || state.dc.readyState !== 'open') return false
    state.dc.send(JSON.stringify(data))
    return true
  }

  /**
   * Broadcast data to all connected peers.
   */
  broadcast(data: unknown): void {
    const json = JSON.stringify(data)
    for (const [, state] of this.peers) {
      if (state.dc?.readyState === 'open') {
        state.dc.send(json)
      }
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

    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS })

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

    // Connection state tracking
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') {
        this.onPeerConnected?.(userId)
      } else if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed' || pc.connectionState === 'closed') {
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
      const dc = pc.createDataChannel('gamechat', { ordered: true })
      this.setupDataChannel(userId, state, dc)
    }

    // If we're the answerer, wait for the remote data channel
    pc.ondatachannel = (event) => {
      this.setupDataChannel(userId, state!, event.channel)
    }

    // Negotiation needed (for renegotiation)
    pc.onnegotiationneeded = async () => {
      try {
        state!.makingOffer = true
        const offer = await pc.createOffer()
        await pc.setLocalDescription(offer)
        await signalingService.send({
          type: 'signal_offer',
          to: userId,
          from: this.localUserId,
          sdp: pc.localDescription!.sdp,
        })
      } finally {
        state!.makingOffer = false
      }
    }

    return state
  }

  private setupDataChannel(userId: string, state: PeerState, dc: RTCDataChannel): void {
    state.dc = dc

    dc.onopen = () => {
      console.debug(`[webrtc] Data channel open with ${userId}`)
    }

    dc.onclose = () => {
      console.debug(`[webrtc] Data channel closed with ${userId}`)
    }

    dc.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data)
        this.onDataMessage?.(userId, data)
      } catch (e) {
        console.error('[webrtc] Failed to parse data channel message:', e)
      }
    }
  }
}

export const webrtcService = new WebRTCService()
