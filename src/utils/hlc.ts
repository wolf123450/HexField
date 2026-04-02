// Hybrid Logical Clock — canonical message ordering across peers
//
// Format: "{wallMs}-{seq:06}" — lexicographically sortable because:
//   - wallMs is always 13 digits for current Unix timestamps (ms)
//   - seq is zero-padded to 6 digits
//
// On send (generateHLC):
//   wallMs = max(Date.now(), state.wallMs)
//   seq    = wallMs === state.wallMs ? state.seq + 1 : 0
//
// On receive (advanceHLC):
//   wallMs = max(Date.now(), state.wallMs, remote.wallMs)
//   seq    = bump the sequence to stay monotone relative to all sources

let _wallMs = 0
let _seq    = 0

export function generateHLC(): string {
  const now = Date.now()
  if (now > _wallMs) {
    _wallMs = now
    _seq    = 0
  } else {
    _seq++
  }
  return `${_wallMs}-${String(_seq).padStart(6, '0')}`
}

export function advanceHLC(remoteTs: string): string {
  const dash = remoteTs.lastIndexOf('-')
  const remoteWall = parseInt(remoteTs.slice(0, dash), 10)
  const remoteSeq  = parseInt(remoteTs.slice(dash + 1), 10)

  const now    = Date.now()
  const wallMs = Math.max(now, _wallMs, remoteWall)

  let seq: number
  if (wallMs === _wallMs && wallMs === remoteWall) {
    seq = Math.max(_seq, remoteSeq) + 1
  } else if (wallMs === _wallMs) {
    seq = _seq + 1
  } else if (wallMs === remoteWall) {
    seq = remoteSeq + 1
  } else {
    seq = 0
  }

  _wallMs = wallMs
  _seq    = seq
  return `${wallMs}-${String(seq).padStart(6, '0')}`
}

export function compareHLC(a: string, b: string): number {
  if (a < b) return -1
  if (a > b) return 1
  return 0
}
