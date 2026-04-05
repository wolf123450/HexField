import { describe, it, expect, vi, afterEach } from 'vitest'

// We mock RTCPeerConnection to simulate different STUN probe results
// without actually making network requests.

function makeMockPC(srflxCandidates: Array<{ ip: string; port: number } | null>) {
  let probeCount = 0

  return class MockRTCPeerConnection {
    private myIndex: number
    iceGatheringState = 'new'
    onicecandidate: ((e: { candidate: RTCIceCandidate | null }) => void) | null = null
    onicegatheringstatechange: (() => void) | null = null

    constructor() {
      this.myIndex = probeCount++
    }

    createDataChannel() { return {} }

    async createOffer() { return { type: 'offer', sdp: '' } }

    async setLocalDescription() {
      // Simulate firing srflx candidate (or completing without one)
      const result = srflxCandidates[this.myIndex % srflxCandidates.length]
      setTimeout(() => {
        if (result) {
          const { ip, port } = result
          const mockCandidate = {
            type:      'srflx',
            candidate: `candidate:0 1 UDP 1 ${ip} ${port} typ srflx raddr 0.0.0.0 rport 0`,
          } as unknown as RTCIceCandidate
          this.onicecandidate?.({ candidate: mockCandidate })
        } else {
          this.iceGatheringState = 'complete'
          this.onicegatheringstatechange?.()
        }
      }, 0)
    }

    close() {}
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('detectNATType', () => {
  it('returns "open" when both STUN probes return the same IP and port', async () => {
    vi.stubGlobal('RTCPeerConnection', makeMockPC([
      { ip: '203.0.113.1', port: 54321 },
      { ip: '203.0.113.1', port: 54321 },
    ]))
    const { detectNATType } = await import('@/utils/natDetection')
    const type = await detectNATType()
    expect(type).toBe('open')
  })

  it('returns "restricted" when both probes return the same IP but different ports', async () => {
    vi.stubGlobal('RTCPeerConnection', makeMockPC([
      { ip: '203.0.113.1', port: 54321 },
      { ip: '203.0.113.1', port: 54999 },
    ]))
    const { detectNATType } = await import('@/utils/natDetection')
    const type = await detectNATType()
    expect(type).toBe('restricted')
  })

  it('returns "symmetric" when the two probes return different IPs', async () => {
    vi.stubGlobal('RTCPeerConnection', makeMockPC([
      { ip: '203.0.113.1', port: 54321 },
      { ip: '198.51.100.5', port: 54321 },
    ]))
    const { detectNATType } = await import('@/utils/natDetection')
    const type = await detectNATType()
    expect(type).toBe('symmetric')
  })

  it('returns "unknown" when a STUN probe fails to produce a srflx candidate', async () => {
    vi.stubGlobal('RTCPeerConnection', makeMockPC([
      { ip: '203.0.113.1', port: 54321 },
      null,
    ]))
    const { detectNATType } = await import('@/utils/natDetection')
    const type = await detectNATType()
    expect(type).toBe('unknown')
  })
})

describe('querySTUN', () => {
  it('parses IP and port from a srflx ICE candidate string', async () => {
    vi.stubGlobal('RTCPeerConnection', makeMockPC([
      { ip: '10.0.0.5', port: 9999 },
    ]))
    const { querySTUN } = await import('@/utils/natDetection')
    const result = await querySTUN('stun.l.google.com:19302')
    expect(result).toEqual({ ip: '10.0.0.5', port: 9999 })
  })

  it('returns null when gathering completes without a srflx candidate', async () => {
    vi.stubGlobal('RTCPeerConnection', makeMockPC([null]))
    const { querySTUN } = await import('@/utils/natDetection')
    const result = await querySTUN('stun.l.google.com:19302')
    expect(result).toBeNull()
  })
})
