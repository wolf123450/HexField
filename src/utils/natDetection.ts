/**
 * NAT type detection via dual-STUN comparison.
 *
 * Two independent STUN probes are sent to different Google STUN servers.
 * - Same external IP:port on both probes → 'open' (full-cone or port-restricted)
 * - Same IP, different port           → 'restricted'
 * - Different IP or port-pair change  → 'symmetric' (needs relay)
 * - Either probe fails                → 'unknown'
 */

export type NATType = 'open' | 'restricted' | 'symmetric' | 'unknown' | 'pending'

export interface STUNResult {
  ip:   string
  port: number
}

/**
 * Resolve the external (server-reflexive) IP:port by gathering a single
 * `srflx` ICE candidate through the given STUN server.  Returns null on
 * timeout (5 s) or if no srflx candidate is produced.
 */
export async function querySTUN(server: string): Promise<STUNResult | null> {
  return new Promise((resolve) => {
    let settled = false
    let pc: RTCPeerConnection | null = null

    function finish(result: STUNResult | null) {
      if (settled) return
      settled = true
      try { pc?.close() } catch { /* ignore */ }
      resolve(result)
    }

    const timer = setTimeout(() => finish(null), 5000)

    try {
      pc = new RTCPeerConnection({ iceServers: [{ urls: `stun:${server}` }] })
      // A data channel is required to trigger ICE gathering.
      pc.createDataChannel('')

      pc.onicecandidate = ({ candidate }) => {
        if (!candidate) return
        if (candidate.type !== 'srflx') return
        // Candidate SDP grammar:
        //   candidate:<foundation> <component> <protocol> <priority> <ip> <port> typ srflx ...
        const parts = candidate.candidate.split(' ')
        if (parts.length < 6) return
        const ip   = parts[4]
        const port = parseInt(parts[5], 10)
        if (!ip || isNaN(port)) return
        clearTimeout(timer)
        finish({ ip, port })
      }

      pc.onicegatheringstatechange = () => {
        if (pc?.iceGatheringState === 'complete') {
          clearTimeout(timer)
          finish(null)
        }
      }

      pc.createOffer()
        .then(offer => pc!.setLocalDescription(offer))
        .catch(() => { clearTimeout(timer); finish(null) })
    } catch {
      clearTimeout(timer)
      finish(null)
    }
  })
}

/**
 * Detect the local device's NAT type by comparing two independent STUN
 * probe results.  Results are cached for the lifetime of the call — call
 * again after a network change if a fresh reading is needed.
 */
export async function detectNATType(): Promise<NATType> {
  try {
    const [r1, r2] = await Promise.all([
      querySTUN('stun.l.google.com:19302'),
      querySTUN('stun1.l.google.com:19302'),
    ])

    if (!r1 || !r2) return 'unknown'

    if (r1.ip === r2.ip && r1.port === r2.port) return 'open'
    if (r1.ip === r2.ip) return 'restricted'
    return 'symmetric'
  } catch {
    return 'unknown'
  }
}
