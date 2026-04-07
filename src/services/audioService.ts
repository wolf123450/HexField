/**
 * audioService — manages remote audio streams, VAD, and local mute/deafen.
 *
 * Hidden <audio> elements are appended to document.body for each remote peer.
 * Voice Activity Detection uses an AnalyserNode polling at 100 ms intervals,
 * with an RMS threshold of 0.01 and a 300 ms debounce before marking not-speaking.
 */

export type SpeakingChangeCallback = (userId: string, speaking: boolean) => void

interface PeerAudio {
  element:    HTMLAudioElement
  context:    AudioContext
  gainNode:   GainNode
  analyser:   AnalyserNode
  interval:   ReturnType<typeof setInterval>
  notSpeakingTimer: ReturnType<typeof setTimeout> | null
}

class AudioService {
  private peers    = new Map<string, PeerAudio>()
  private deafened = false
  private onSpeakingChange: SpeakingChangeCallback | null = null
  private localStream: MediaStream | null = null
  private loopbackCtx:     AudioContext | null = null
  private loopbackSource:  MediaStreamAudioSourceNode | null = null
  private loopbackDest:    MediaStreamAudioDestinationNode | null = null
  private loopbackElement: HTMLAudioElement | null = null
  // Local VAD
  private localVADCtx: AudioContext | null = null
  private localVADInterval: ReturnType<typeof setInterval> | null = null
  private localNotSpeakingTimer: ReturnType<typeof setTimeout> | null = null

  // ── Initialise ─────────────────────────────────────────────────────────────

  init(onSpeakingChange: SpeakingChangeCallback): void {
    this.onSpeakingChange = onSpeakingChange
  }

  // ── Local stream ───────────────────────────────────────────────────────────

  setLocalStream(stream: MediaStream): void {
    // Stop any existing local VAD
    this.stopLocalVAD()
    this.localStream = stream
    if (!stream) return
    // Start VAD for self-speaking indicator
    const ctx     = new AudioContext()
    const src     = ctx.createMediaStreamSource(stream)
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 512
    src.connect(analyser)
    this.localVADCtx = ctx
    const data = new Float32Array(analyser.fftSize)
    this.localVADInterval = setInterval(() => {
      const trackEnabled = stream.getAudioTracks().some(t => t.enabled)
      if (!trackEnabled) {
        this.scheduleLocalNotSpeaking()
        return
      }
      analyser.getFloatTimeDomainData(data)
      let sum = 0
      for (let i = 0; i < data.length; i++) sum += data[i] * data[i]
      const rms = Math.sqrt(sum / data.length)
      if (rms > 0.01) {
        if (this.localNotSpeakingTimer !== null) {
          clearTimeout(this.localNotSpeakingTimer)
          this.localNotSpeakingTimer = null
        }
        this.onSpeakingChange?.('self', true)
      } else {
        this.scheduleLocalNotSpeaking()
      }
    }, 100)
  }

  private scheduleLocalNotSpeaking() {
    if (this.localNotSpeakingTimer === null) {
      this.localNotSpeakingTimer = setTimeout(() => {
        this.onSpeakingChange?.('self', false)
        this.localNotSpeakingTimer = null
      }, 300)
    }
  }

  private stopLocalVAD() {
    if (this.localVADInterval !== null) {
      clearInterval(this.localVADInterval)
      this.localVADInterval = null
    }
    if (this.localNotSpeakingTimer !== null) {
      clearTimeout(this.localNotSpeakingTimer)
      this.localNotSpeakingTimer = null
    }
    this.localVADCtx?.close().catch(() => {})
    this.localVADCtx = null
    this.onSpeakingChange?.('self', false)
  }

  setLocalMuted(muted: boolean): void {
    this.localStream?.getAudioTracks().forEach(t => {
      t.enabled = !muted
    })
  }

  // ── Remote streams ─────────────────────────────────────────────────────────

  attachRemoteStream(userId: string, stream: MediaStream): void {
    // Detach any existing entry first
    this.detachRemoteStream(userId)

    const element = document.createElement('audio')
    element.autoplay = true
    element.muted    = this.deafened
    element.srcObject = stream
    // Required by some browsers so the audio element is connected to the DOM
    element.style.display = 'none'
    document.body.appendChild(element)

    const context  = new AudioContext()
    const src      = context.createMediaStreamSource(stream)
    const gainNode = context.createGain()
    const analyser = context.createAnalyser()
    analyser.fftSize = 512
    src.connect(gainNode)
    gainNode.connect(analyser)
    gainNode.connect(context.destination)

    const data: Float32Array = new Float32Array(analyser.fftSize)
    let notSpeakingTimer: ReturnType<typeof setTimeout> | null = null

    const interval = setInterval(() => {
      analyser.getFloatTimeDomainData(data)
      let sum = 0
      for (let i = 0; i < data.length; i++) sum += data[i] * data[i]
      const rms = Math.sqrt(sum / data.length)

      if (rms > 0.01) {
        if (notSpeakingTimer !== null) {
          clearTimeout(notSpeakingTimer)
          notSpeakingTimer = null
        }
        this.onSpeakingChange?.(userId, true)
      } else {
        if (notSpeakingTimer === null) {
          notSpeakingTimer = setTimeout(() => {
            this.onSpeakingChange?.(userId, false)
            notSpeakingTimer = null
          }, 300)
          // Store back so we can clear it on detach
          const entry = this.peers.get(userId)
          if (entry) entry.notSpeakingTimer = notSpeakingTimer
        }
      }
    }, 100)

    this.peers.set(userId, { element, context, gainNode, analyser, interval, notSpeakingTimer })

    // Re-apply personal mute if this peer was already personally muted before connecting
    import('@/stores/personalBlocksStore').then(({ usePersonalBlocksStore }) => {
      const store = usePersonalBlocksStore()
      if (store.isMuted(userId)) gainNode.gain.value = 0
    })
  }

  setPeerVolume(userId: string, volume: number): void {
    const entry = this.peers.get(userId)
    if (entry) entry.gainNode.gain.value = Math.max(0, volume)
  }

  /**
   * Silence (or restore) a specific peer's audio without detaching the stream.
   * Used for personal (client-side) voice mute. The peer is unaware.
   */
  setPersonallyMuted(userId: string, muted: boolean): void {
    const entry = this.peers.get(userId)
    if (entry) {
      entry.gainNode.gain.value = muted ? 0 : 1
    }
  }

  detachRemoteStream(userId: string): void {
    const entry = this.peers.get(userId)
    if (!entry) return
    clearInterval(entry.interval)
    if (entry.notSpeakingTimer !== null) clearTimeout(entry.notSpeakingTimer)
    entry.context.close().catch(() => {})
    entry.element.srcObject = null
    entry.element.remove()
    this.peers.delete(userId)
    this.onSpeakingChange?.(userId, false)
  }

  detachAll(): void {
    for (const userId of [...this.peers.keys()]) {
      this.detachRemoteStream(userId)
    }
    this.stopLocalVAD()
    this.setLoopback(false)
  }

  // ── Loopback ───────────────────────────────────────────────────────────────

  setLoopback(enabled: boolean): void {
    if (!enabled) {
      if (this.loopbackElement) {
        this.loopbackElement.srcObject = null
        this.loopbackElement.remove()
        this.loopbackElement = null
      }
      this.loopbackSource?.disconnect()
      this.loopbackDest = null
      this.loopbackSource = null
      this.loopbackCtx?.close().catch(() => {})
      this.loopbackCtx = null
      return
    }
    if (!this.localStream) return
    // Create a short-delay AudioContext route: mic → delay(50ms) → audio element
    this.loopbackCtx    = new AudioContext()
    this.loopbackSource = this.loopbackCtx.createMediaStreamSource(this.localStream)
    const delay         = this.loopbackCtx.createDelay(0.1)
    delay.delayTime.value = 0.05
    this.loopbackDest   = this.loopbackCtx.createMediaStreamDestination()
    this.loopbackSource.connect(delay)
    delay.connect(this.loopbackDest)
    this.loopbackElement = document.createElement('audio')
    this.loopbackElement.srcObject = this.loopbackDest.stream
    this.loopbackElement.autoplay  = true
    this.loopbackElement.style.display = 'none'
    document.body.appendChild(this.loopbackElement)
  }

  // ── Deafen ─────────────────────────────────────────────────────────────────

  setDeafened(deafened: boolean): void {
    this.deafened = deafened
    for (const { element } of this.peers.values()) {
      element.muted = deafened
    }
  }

  // ── Input device change ────────────────────────────────────────────────────

  async setInputDevice(deviceId: string): Promise<MediaStream> {
    const constraints: MediaStreamConstraints = {
      audio: deviceId ? { deviceId: { exact: deviceId } } : true,
      video: false,
    }
    const stream = await navigator.mediaDevices.getUserMedia(constraints)
    this.setLocalStream(stream)
    return stream
  }
}

export const audioService = new AudioService()
