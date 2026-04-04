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
