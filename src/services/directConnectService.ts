/**
 * directConnectService.ts — "Direct connect" (plan step 1b, manual code exchange).
 *
 * Lets two peers establish a WebRTC data channel with no rendezvous server and
 * no shared LAN: one side generates an offer code, the other pastes it back as
 * an answer code. Both sides wait for full ICE gathering before the code is
 * produced (non-trickle), so the whole SDP — including candidates — fits in
 * one pasteable string.
 *
 * Codes are:
 *  - Signed with the sender's Ed25519 identity key (`cryptoService.signJson`),
 *    so a pasted code can't be forged as someone the recipient already knows.
 *  - Single use and short-lived (`CODE_TTL_MS`).
 *  - Compressed with gzip (`CompressionStream`) when available, since raw SDP
 *    text compresses well (repeated ICE/candidate boilerplate); falls back to
 *    uncompressed base64url on devices without it.
 *
 * The Rust side (`webrtc_manager.rs`) only ever sees a plain SDP string; all
 * encoding, signing and verification happens here.
 */

import { invoke } from '@tauri-apps/api/core'
import { cryptoService } from '@/services/cryptoService'
import { logger } from '@/utils/logger'

export type DirectConnectCodeKind = 'offer' | 'answer'

/** Unsigned payload carried inside a direct-connect code. */
export interface DirectConnectPayload {
  v: 1
  from: string
  displayName: string
  publicDHKey: string
  sdp: string
  exp: number // epoch ms
}

export interface DecodedDirectConnectCode {
  kind: DirectConnectCodeKind
  payload: DirectConnectPayload
  /** The sender's Ed25519 public key, verified against the code's signature. */
  publicSignKey: string
}

/** Whether a previously-seen identity's key matches, mismatches, or is unknown. */
export type IdentityCheck = 'match' | 'mismatch' | 'unknown'

export const CODE_TTL_MS = 10 * 60 * 1000 // 10 minutes

const OFFER_PREFIX = 'hexfield-offer:'
const ANSWER_PREFIX = 'hexfield-answer:'

// ── base64url helpers (binary-safe; matches the convention used by
//    hexfield://join/ links in InviteModal.vue / JoinModal.vue) ─────────────

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

function base64UrlToBytes(b64url: string): Uint8Array {
  const pad = (4 - (b64url.length % 4)) % 4
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat(pad)
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

// ── gzip compaction (best-effort; degrades gracefully) ─────────────────────

async function gzipCompress(text: string): Promise<Uint8Array | null> {
  if (typeof CompressionStream === 'undefined') return null
  try {
    const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'))
    return new Uint8Array(await new Response(stream).arrayBuffer())
  } catch (e) {
    logger.warn('directConnect', 'gzip compress failed, falling back to raw:', e)
    return null
  }
}

async function gzipDecompress(bytes: Uint8Array): Promise<string> {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('This code was compressed and this device cannot read it. Ask the sender to try again.')
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))
  const buf = await new Response(stream).arrayBuffer()
  return new TextDecoder().decode(buf)
}

// ── encode / decode ──────────────────────────────────────────────────────────

async function encodeCode(kind: DirectConnectCodeKind, payload: DirectConnectPayload): Promise<string> {
  const signed = cryptoService.signJson(payload as unknown as Record<string, unknown>)
  const json = JSON.stringify(signed)
  const prefix = kind === 'offer' ? OFFER_PREFIX : ANSWER_PREFIX

  const compressed = await gzipCompress(json)
  if (compressed) {
    return `${prefix}z${bytesToBase64Url(compressed)}`
  }
  return `${prefix}r${bytesToBase64Url(new TextEncoder().encode(json))}`
}

/** True if `raw` looks like a direct-connect code (cheap check, no parsing). */
export function isDirectConnectCode(raw: string): boolean {
  const s = raw.trim()
  return s.startsWith(OFFER_PREFIX) || s.startsWith(ANSWER_PREFIX)
}

export async function decodeCode(raw: string): Promise<DecodedDirectConnectCode> {
  const s = raw.trim()
  let kind: DirectConnectCodeKind
  let rest: string
  if (s.startsWith(OFFER_PREFIX)) {
    kind = 'offer'
    rest = s.slice(OFFER_PREFIX.length)
  } else if (s.startsWith(ANSWER_PREFIX)) {
    kind = 'answer'
    rest = s.slice(ANSWER_PREFIX.length)
  } else {
    throw new Error('That doesn’t look like a direct-connect code.')
  }

  if (rest.length < 2) throw new Error('Direct-connect code is incomplete.')
  const enc = rest[0]
  const body = rest.slice(1)

  let bytes: Uint8Array
  try {
    bytes = base64UrlToBytes(body)
  } catch {
    throw new Error('Direct-connect code is corrupted.')
  }

  let json: string
  if (enc === 'z') {
    try {
      json = await gzipDecompress(bytes)
    } catch (e) {
      if (e instanceof Error && e.message.includes('cannot read it')) throw e
      throw new Error('Direct-connect code is corrupted.')
    }
  } else if (enc === 'r') {
    json = new TextDecoder().decode(bytes)
  } else {
    throw new Error('Direct-connect code uses an unsupported encoding.')
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    throw new Error('Direct-connect code is corrupted.')
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('Direct-connect code is corrupted.')
  }
  const msg = parsed as Record<string, unknown>

  const publicSignKey = cryptoService.verifyJsonSignature(msg)
  if (!publicSignKey) {
    throw new Error('Direct-connect code has an invalid signature — it may have been tampered with.')
  }

  const payload = msg as unknown as DirectConnectPayload
  if (payload.v !== 1 || !payload.from || !payload.sdp || !payload.exp) {
    throw new Error('Direct-connect code is missing required fields.')
  }
  if (Date.now() > payload.exp) {
    throw new Error('This direct-connect code has expired. Ask for a new one.')
  }

  return { kind, payload, publicSignKey }
}

/**
 * Compares a code's verified identity key against any key already on record
 * for that userId (server members from every joined server). `'unknown'` when
 * we've never seen this userId before (first contact — nothing to compare).
 */
export async function checkKnownIdentity(userId: string, publicSignKey: string): Promise<IdentityCheck> {
  const { useServersStore } = await import('@/stores/serversStore')
  const serversStore = useServersStore()
  for (const members of Object.values(serversStore.members)) {
    const member = members[userId]
    if (member) {
      return member.publicSignKey === publicSignKey ? 'match' : 'mismatch'
    }
  }
  return 'unknown'
}

function identityMismatchError(displayName: string): Error {
  return new Error(
    `This code claims to be from ${displayName}, but its identity key doesn’t match the one you already know ` +
    'for that user. Refusing to connect — it may be an impersonation attempt.',
  )
}

// ── Rust orchestration ──────────────────────────────────────────────────────

export interface CreateOfferResult {
  sessionId: string
  code: string
  expiresAt: number
}

/** Offerer side: build a non-trickle offer and wrap it in a signed code. */
export async function createOfferCode(): Promise<CreateOfferResult> {
  const { useIdentityStore } = await import('@/stores/identityStore')
  const identityStore = useIdentityStore()
  if (!identityStore.userId) throw new Error('Identity not ready yet.')

  const sessionId = crypto.randomUUID()
  const sdp = await invoke<string>('webrtc_create_offer_code', { sessionId })
  const exp = Date.now() + CODE_TTL_MS
  const payload: DirectConnectPayload = {
    v: 1,
    from: identityStore.userId,
    displayName: identityStore.displayName || 'Anonymous',
    publicDHKey: identityStore.publicDHKey ?? '',
    sdp,
    exp,
  }
  const code = await encodeCode('offer', payload)
  return { sessionId, code, expiresAt: exp }
}

/** Discards a pending offer (modal closed or code expired before a reply arrived). */
export async function cancelOfferSession(sessionId: string): Promise<void> {
  try {
    await invoke('webrtc_cancel_offer_session', { sessionId })
  } catch (e) {
    logger.warn('directConnect', 'cancel_offer_session failed:', e)
  }
}

export interface AcceptOfferResult {
  code: string
  fromUserId: string
  fromDisplayName: string
}

/** Answerer side: verify a pasted offer code and return a signed answer code. */
export async function acceptOfferCode(raw: string): Promise<AcceptOfferResult> {
  const decoded = await decodeCode(raw)
  if (decoded.kind !== 'offer') {
    throw new Error('This is an answer code, not an offer code. Ask the other person for their offer code.')
  }
  const check = await checkKnownIdentity(decoded.payload.from, decoded.publicSignKey)
  if (check === 'mismatch') throw identityMismatchError(decoded.payload.displayName)

  const answerSdp = await invoke<string>('webrtc_accept_offer_code', {
    from: decoded.payload.from,
    sdp: decoded.payload.sdp,
  })

  const { useIdentityStore } = await import('@/stores/identityStore')
  const identityStore = useIdentityStore()
  if (!identityStore.userId) throw new Error('Identity not ready yet.')

  const answerPayload: DirectConnectPayload = {
    v: 1,
    from: identityStore.userId,
    displayName: identityStore.displayName || 'Anonymous',
    publicDHKey: identityStore.publicDHKey ?? '',
    sdp: answerSdp,
    exp: Date.now() + CODE_TTL_MS,
  }
  const code = await encodeCode('answer', answerPayload)
  return { code, fromUserId: decoded.payload.from, fromDisplayName: decoded.payload.displayName }
}

export interface ApplyAnswerResult {
  fromUserId: string
  fromDisplayName: string
}

/** Offerer side: apply a pasted-back answer code to the pending offer session. */
export async function applyAnswerCode(sessionId: string, raw: string): Promise<ApplyAnswerResult> {
  const decoded = await decodeCode(raw)
  if (decoded.kind !== 'answer') {
    throw new Error('This is an offer code, not an answer code. Paste the code the other person sent back to you.')
  }
  const check = await checkKnownIdentity(decoded.payload.from, decoded.publicSignKey)
  if (check === 'mismatch') throw identityMismatchError(decoded.payload.displayName)

  await invoke('webrtc_apply_answer_code', {
    sessionId,
    from: decoded.payload.from,
    sdp: decoded.payload.sdp,
  })
  return { fromUserId: decoded.payload.from, fromDisplayName: decoded.payload.displayName }
}
