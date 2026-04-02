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
  analyser:   AnalyserNode
  interval:   ReturnType<typeof setInterval>
  notSpeakingTimer: ReturnType<typeof setTimeout> | null
}

class AudioService {
  private peers    = new Map<string, PeerAudio>()
  private deafened = false
  private onSpeakingChange: SpeakingChangeCallback | null = null
  private localStream: MediaStream | null = null

  // ── Initialise ─────────────────────────────────────────────────────────────

  init(onSpeakingChange: SpeakingChangeCallback): void {
    this.onSpeakingChange = onSpeakingChange
  }

  // ── Local stream ───────────────────────────────────────────────────────────

  setLocalStream(stream: MediaStream): void {
    this.localStream = stream
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
    const analyser = context.createAnalyser()
    analyser.fftSize = 512
    src.connect(analyser)

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

    this.peers.set(userId, { element, context, analyser, interval, notSpeakingTimer })
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
  }

  // ── Deafen ─────────────────────────────────────────────────────────────────

  setDeafened(deafened: boolean): void {
    this.deafened = deafened
    for (const { element } of this.peers.values()) {
      element.muted = deafened
    }
  }

  // ── Per-peer volume ────────────────────────────────────────────────────────

  setPeerVolume(userId: string, volume: number): void {
    const entry = this.peers.get(userId)
    if (entry) entry.element.volume = Math.max(0, Math.min(1, volume))
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
