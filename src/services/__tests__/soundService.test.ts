import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock Web Audio API (not available in jsdom)
const mockDisconnect  = vi.fn()
const mockStart       = vi.fn()
const mockStop        = vi.fn()
const mockConnect     = vi.fn()
const mockSetValueAtTime = vi.fn()
const mockLinearRampToValueAtTime = vi.fn()
const mockExponentialRampToValueAtTime = vi.fn()

const createOscillator = () => ({
  type: 'sine' as OscillatorType,
  frequency: { value: 0, setValueAtTime: mockSetValueAtTime },
  connect:    mockConnect,
  disconnect: mockDisconnect,
  start:      mockStart,
  stop:       mockStop,
})

const createGain = () => ({
  gain: {
    value: 0,
    setValueAtTime:                mockSetValueAtTime,
    linearRampToValueAtTime:       mockLinearRampToValueAtTime,
    exponentialRampToValueAtTime:  mockExponentialRampToValueAtTime,
  },
  connect:    mockConnect,
  disconnect: mockDisconnect,
})

const mockDecodeAudioData = vi.fn()
const mockCreateBufferSource = vi.fn(() => ({
  buffer: null,
  connect:    mockConnect,
  disconnect: mockDisconnect,
  start:      mockStart,
}))

const mockAudioContext = {
  currentTime: 0,
  destination: {},
  state: 'running' as AudioContextState,
  resume: vi.fn().mockResolvedValue(undefined),
  createOscillator,
  createGain,
  decodeAudioData: mockDecodeAudioData,
  createBufferSource: mockCreateBufferSource,
}

vi.stubGlobal('AudioContext', vi.fn().mockImplementation(function() { return mockAudioContext }))

describe('soundService', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockAudioContext.state = 'running'
    // Re-import fresh instance each test to reset module state
    vi.resetModules()
  })

  it('play("message") calls start on an oscillator without throwing', async () => {
    const { soundService } = await import('../soundService')
    await expect(soundService.play('message')).resolves.not.toThrow()
    expect(mockStart).toHaveBeenCalled()
  })

  it('play("mention") calls start at least twice (two-tone chime)', async () => {
    const { soundService } = await import('../soundService')
    await soundService.play('mention')
    expect(mockStart.mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  it('setCustomSound stores the data URL and play() attempts decodeAudioData', async () => {
    mockDecodeAudioData.mockResolvedValue({} as AudioBuffer)
    mockCreateBufferSource.mockReturnValue({ buffer: null, connect: mockConnect, start: mockStart, disconnect: mockDisconnect })
    const { soundService } = await import('../soundService')
    soundService.setCustomSound('message', 'data:audio/ogg;base64,abc')
    await soundService.play('message')
    expect(mockDecodeAudioData).toHaveBeenCalled()
  })

  it('falls back to synth if decodeAudioData rejects', async () => {
    mockDecodeAudioData.mockRejectedValue(new Error('decode error'))
    const { soundService } = await import('../soundService')
    soundService.setCustomSound('message', 'data:audio/ogg;base64,bad')
    // Should not throw — falls back silently
    await expect(soundService.play('message')).resolves.not.toThrow()
    // Synth oscillator should fire instead
    expect(mockStart).toHaveBeenCalled()
  })

  it('clearCustomSound removes the override so synth is used', async () => {
    mockDecodeAudioData.mockResolvedValue({} as AudioBuffer)
    const { soundService } = await import('../soundService')
    soundService.setCustomSound('mention', 'data:audio/ogg;base64,abc')
    soundService.clearCustomSound('mention')
    await soundService.play('mention')
    // decodeAudioData should NOT be called after clear
    expect(mockDecodeAudioData).not.toHaveBeenCalled()
  })
})
