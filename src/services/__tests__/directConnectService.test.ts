// @vitest-environment node
//
// cryptoService (libsodium-wrappers-sumo, WASM) hits cross-realm TypedArray
// mismatches under jsdom's global scope ("unsupported input type for
// message") — see src/services/__tests__/cryptoService.test.ts for the same
// convention.
/**
 * Tests for directConnectService.ts (plan step 1b, manual code exchange):
 *  - encode → decode round-trip preserves the payload
 *  - signature verification rejects tampering
 *  - expiry is enforced
 *  - malformed / foreign-prefix input is rejected with a clear error
 *  - known-identity mismatch is refused (anti-impersonation)
 *  - the Rust orchestration calls (createOfferCode / acceptOfferCode / applyAnswerCode)
 *    invoke the right commands in the right order
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { cryptoService } from '@/services/cryptoService'

const invokeImpl = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invokeImpl(...args) }))

import * as directConnect from '@/services/directConnectService'

describe('directConnectService', () => {
  beforeAll(async () => {
    await cryptoService.init()
    await cryptoService.generateKeys()
  })

  beforeEach(() => {
    setActivePinia(createPinia())
    invokeImpl.mockReset()
  })

  // ── encode / decode round-trip ──────────────────────────────────────────

  it('round-trips a hand-built signed offer payload through decodeCode', async () => {
    const payload = {
      v: 1 as const,
      from: 'user-1',
      displayName: 'Alice',
      publicDHKey: cryptoService.getPublicDHKey(),
      sdp: 'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n',
      exp: Date.now() + 60_000,
    }
    const signed = cryptoService.signJson(payload)
    // Encode the way the service does internally: prefix + encoding marker + base64url(JSON).
    const json = JSON.stringify(signed)
    const b64 = Buffer.from(json, 'utf-8').toString('base64url')
    const raw = `hexfield-offer:r${b64}`

    const decoded = await directConnect.decodeCode(raw)
    expect(decoded.kind).toBe('offer')
    expect(decoded.payload.from).toBe('user-1')
    expect(decoded.payload.sdp).toContain('m=application')
    expect(decoded.publicSignKey).toBe(cryptoService.getPublicSignKey())
  })

  it('isDirectConnectCode recognizes both prefixes and rejects anything else', () => {
    expect(directConnect.isDirectConnectCode('hexfield-offer:abc')).toBe(true)
    expect(directConnect.isDirectConnectCode('hexfield-answer:abc')).toBe(true)
    expect(directConnect.isDirectConnectCode('hexfield://join/abc')).toBe(false)
    expect(directConnect.isDirectConnectCode('garbage')).toBe(false)
  })

  it('rejects input without a recognized prefix', async () => {
    await expect(directConnect.decodeCode('not-a-code-at-all')).rejects.toThrow(/direct-connect code/i)
  })

  it('rejects a tampered signature', async () => {
    const payload = {
      v: 1 as const,
      from: 'user-1',
      displayName: 'Alice',
      publicDHKey: cryptoService.getPublicDHKey(),
      sdp: 'v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n',
      exp: Date.now() + 60_000,
    }
    const signed = cryptoService.signJson(payload)
    const tampered = { ...signed, displayName: 'Mallory' } // mutate a signed field
    const b64 = Buffer.from(JSON.stringify(tampered), 'utf-8').toString('base64url')
    await expect(directConnect.decodeCode(`hexfield-offer:r${b64}`)).rejects.toThrow(/invalid signature/i)
  })

  it('rejects an expired code', async () => {
    const payload = {
      v: 1 as const,
      from: 'user-1',
      displayName: 'Alice',
      publicDHKey: cryptoService.getPublicDHKey(),
      sdp: 'v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n',
      exp: Date.now() - 1000, // already expired
    }
    const signed = cryptoService.signJson(payload)
    const b64 = Buffer.from(JSON.stringify(signed), 'utf-8').toString('base64url')
    await expect(directConnect.decodeCode(`hexfield-offer:r${b64}`)).rejects.toThrow(/expired/i)
  })

  it('rejects a code missing required fields', async () => {
    const signed = cryptoService.signJson({ v: 1, from: '' })
    const b64 = Buffer.from(JSON.stringify(signed), 'utf-8').toString('base64url')
    await expect(directConnect.decodeCode(`hexfield-answer:r${b64}`)).rejects.toThrow(/missing required fields/i)
  })

  it('rejects corrupted base64 body', async () => {
    await expect(directConnect.decodeCode('hexfield-offer:r***not-base64***')).rejects.toThrow(/corrupted/i)
  })

  // ── known-identity check ────────────────────────────────────────────────

  it('checkKnownIdentity: unknown when the userId has never been seen', async () => {
    const result = await directConnect.checkKnownIdentity('stranger', 'anyKey==')
    expect(result).toBe('unknown')
  })

  it('checkKnownIdentity: match / mismatch against a known server member', async () => {
    const { useServersStore } = await import('@/stores/serversStore')
    const serversStore = useServersStore()
    // Seed a known member directly on the store's reactive state.
    ;(serversStore.members as Record<string, Record<string, { publicSignKey: string }>>)['server-1'] = {
      'known-user': { publicSignKey: 'realKey==' },
    }

    expect(await directConnect.checkKnownIdentity('known-user', 'realKey==')).toBe('match')
    expect(await directConnect.checkKnownIdentity('known-user', 'fakeKey==')).toBe('mismatch')
  })

  // ── Rust orchestration ──────────────────────────────────────────────────

  it('createOfferCode invokes webrtc_create_offer_code and returns a signed offer code', async () => {
    const { useIdentityStore } = await import('@/stores/identityStore')
    const identityStore = useIdentityStore()
    identityStore.userId = 'me'
    identityStore.displayName = 'Me'
    identityStore.publicDHKey = cryptoService.getPublicDHKey()

    invokeImpl.mockResolvedValueOnce('v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n')

    const result = await directConnect.createOfferCode()
    expect(invokeImpl).toHaveBeenCalledWith('webrtc_create_offer_code', { sessionId: result.sessionId })
    expect(result.code.startsWith('hexfield-offer:')).toBe(true)
    expect(result.expiresAt).toBeGreaterThan(Date.now())

    const decoded = await directConnect.decodeCode(result.code)
    expect(decoded.kind).toBe('offer')
    expect(decoded.payload.from).toBe('me')
  })

  it('cancelOfferSession invokes webrtc_cancel_offer_session and swallows errors', async () => {
    invokeImpl.mockResolvedValueOnce(undefined)
    await directConnect.cancelOfferSession('session-x')
    expect(invokeImpl).toHaveBeenCalledWith('webrtc_cancel_offer_session', { sessionId: 'session-x' })

    invokeImpl.mockRejectedValueOnce(new Error('boom'))
    await expect(directConnect.cancelOfferSession('session-y')).resolves.toBeUndefined()
  })

  it('acceptOfferCode verifies the offer, calls webrtc_accept_offer_code, and returns a signed answer code', async () => {
    const { useIdentityStore } = await import('@/stores/identityStore')
    const identityStore = useIdentityStore()
    identityStore.userId = 'bob'
    identityStore.displayName = 'Bob'
    identityStore.publicDHKey = cryptoService.getPublicDHKey()

    const offerPayload = {
      v: 1 as const,
      from: 'alice',
      displayName: 'Alice',
      publicDHKey: cryptoService.getPublicDHKey(),
      sdp: 'v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n',
      exp: Date.now() + 60_000,
    }
    const signed = cryptoService.signJson(offerPayload)
    const offerCode = `hexfield-offer:r${Buffer.from(JSON.stringify(signed), 'utf-8').toString('base64url')}`

    invokeImpl.mockResolvedValueOnce('v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n') // answer sdp

    const result = await directConnect.acceptOfferCode(offerCode)
    expect(invokeImpl).toHaveBeenCalledWith('webrtc_accept_offer_code', {
      from: 'alice',
      sdp: offerPayload.sdp,
    })
    expect(result.fromUserId).toBe('alice')
    expect(result.code.startsWith('hexfield-answer:')).toBe(true)
  })

  it('acceptOfferCode rejects an answer code passed by mistake', async () => {
    const { useIdentityStore } = await import('@/stores/identityStore')
    const identityStore = useIdentityStore()
    identityStore.userId = 'bob'

    const answerPayload = {
      v: 1 as const,
      from: 'alice',
      displayName: 'Alice',
      publicDHKey: cryptoService.getPublicDHKey(),
      sdp: 'v=0\r\n',
      exp: Date.now() + 60_000,
    }
    const signed = cryptoService.signJson(answerPayload)
    const answerCode = `hexfield-answer:r${Buffer.from(JSON.stringify(signed), 'utf-8').toString('base64url')}`

    await expect(directConnect.acceptOfferCode(answerCode)).rejects.toThrow(/not an offer code/i)
    expect(invokeImpl).not.toHaveBeenCalled()
  })

  it('acceptOfferCode refuses a known identity whose key no longer matches', async () => {
    const { useServersStore } = await import('@/stores/serversStore')
    const serversStore = useServersStore()
    ;(serversStore.members as Record<string, Record<string, { publicSignKey: string }>>)['server-1'] = {
      alice: { publicSignKey: 'a-different-key==' },
    }

    const offerPayload = {
      v: 1 as const,
      from: 'alice',
      displayName: 'Alice',
      publicDHKey: cryptoService.getPublicDHKey(),
      sdp: 'v=0\r\n',
      exp: Date.now() + 60_000,
    }
    const signed = cryptoService.signJson(offerPayload)
    const offerCode = `hexfield-offer:r${Buffer.from(JSON.stringify(signed), 'utf-8').toString('base64url')}`

    await expect(directConnect.acceptOfferCode(offerCode)).rejects.toThrow(/identity key/i)
    expect(invokeImpl).not.toHaveBeenCalled()
  })

  it('applyAnswerCode verifies the answer and calls webrtc_apply_answer_code with the session id', async () => {
    const answerPayload = {
      v: 1 as const,
      from: 'bob',
      displayName: 'Bob',
      publicDHKey: cryptoService.getPublicDHKey(),
      sdp: 'v=0\r\n',
      exp: Date.now() + 60_000,
    }
    const signed = cryptoService.signJson(answerPayload)
    const answerCode = `hexfield-answer:r${Buffer.from(JSON.stringify(signed), 'utf-8').toString('base64url')}`

    invokeImpl.mockResolvedValueOnce(undefined)
    const result = await directConnect.applyAnswerCode('session-42', answerCode)
    expect(invokeImpl).toHaveBeenCalledWith('webrtc_apply_answer_code', {
      sessionId: 'session-42',
      from: 'bob',
      sdp: 'v=0\r\n',
    })
    expect(result.fromUserId).toBe('bob')
  })

  it('applyAnswerCode rejects an offer code passed by mistake', async () => {
    const offerPayload = {
      v: 1 as const,
      from: 'bob',
      displayName: 'Bob',
      publicDHKey: cryptoService.getPublicDHKey(),
      sdp: 'v=0\r\n',
      exp: Date.now() + 60_000,
    }
    const signed = cryptoService.signJson(offerPayload)
    const offerCode = `hexfield-offer:r${Buffer.from(JSON.stringify(signed), 'utf-8').toString('base64url')}`

    await expect(directConnect.applyAnswerCode('session-1', offerCode)).rejects.toThrow(/not an answer code/i)
    expect(invokeImpl).not.toHaveBeenCalled()
  })
})
