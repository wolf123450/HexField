// @vitest-environment node
/**
 * Cross-peer integration tests.
 *
 * These tests create two independent CryptoService instances (Alice & Bob)
 * with separate key pairs, then exercise every communication path that
 * relies on one peer producing data and another peer consuming it:
 *
 *   1. Cross-peer encrypt/decrypt  (X25519 box)
 *   2. Cross-peer signJson/verifyJsonSignature  (Ed25519 canonical JSON)
 *   3. Signal payload signing & verification (the handleSignalMessage path)
 *   4. Chat wire message: encrypt → serialize → verify → decrypt
 *   5. Server join request payload structure
 *   6. Member announce / gossip payload structure
 *   7. Mutation wire message structure
 */

import { describe, it, expect, beforeAll } from 'vitest'
import { CryptoService } from '@/services/cryptoService'
import type { EncryptedEnvelope } from '@/types/core'
import {
  isValidChatMessage,
  isValidMemberAnnounce,
  isValidPresenceUpdate,
  isValidMutation,
  isValidTypingStart,
  isValidProfileUpdate,
} from '@/utils/peerValidator'

// ── Two independent identities ───────────────────────────────────────────────

let alice: CryptoService
let bob: CryptoService

let aliceSignPub: string
let aliceDHPub: string
let bobSignPub: string
let bobDHPub: string

beforeAll(async () => {
  alice = new CryptoService()
  bob = new CryptoService()
  await alice.init()
  await bob.init()
  await alice.generateKeys()
  await bob.generateKeys()

  aliceSignPub = alice.getPublicSignKey()
  aliceDHPub = alice.getPublicDHKey()
  bobSignPub = bob.getPublicSignKey()
  bobDHPub = bob.getPublicDHKey()
})

// ── 1. Cross-peer encrypt → decrypt ─────────────────────────────────────────

describe('cross-peer encryption', () => {
  it('Alice encrypts → Bob decrypts', () => {
    const plaintext = 'Hello Bob from Alice! 🔐'
    const envelope = alice.encryptMessage(plaintext, 'alice-id', 'bob-id', bobDHPub)
    const result = bob.decryptMessage(envelope, aliceDHPub, aliceSignPub)
    expect(result).toBe(plaintext)
  })

  it('Bob encrypts → Alice decrypts', () => {
    const plaintext = 'Hey Alice, Bob here! 🗝️'
    const envelope = bob.encryptMessage(plaintext, 'bob-id', 'alice-id', aliceDHPub)
    const result = alice.decryptMessage(envelope, bobDHPub, bobSignPub)
    expect(result).toBe(plaintext)
  })

  it('Alice cannot decrypt a message intended for Bob using her own keys', () => {
    const envelope = alice.encryptMessage('secret for Bob', 'alice-id', 'bob-id', bobDHPub)
    // Alice tries to decrypt with her own DH key as sender — should fail
    const result = alice.decryptMessage(envelope, aliceDHPub, aliceSignPub)
    expect(result).toBeNull()
  })

  it('Bob cannot decrypt with wrong sender sign key', () => {
    const envelope = alice.encryptMessage('signed by Alice', 'alice-id', 'bob-id', bobDHPub)
    // Bob uses Bob's own sign key as sender sign key — signature check fails
    const result = bob.decryptMessage(envelope, aliceDHPub, bobSignPub)
    expect(result).toBeNull()
  })

  it('Bob cannot decrypt with wrong sender DH key', () => {
    const envelope = alice.encryptMessage('sealed for Bob', 'alice-id', 'bob-id', bobDHPub)
    // Wrong DH key → shared secret differs → decryption fails
    const result = bob.decryptMessage(envelope, bobDHPub, aliceSignPub)
    expect(result).toBeNull()
  })

  it('round-trips empty string between peers', () => {
    const envelope = alice.encryptMessage('', 'alice-id', 'bob-id', bobDHPub)
    expect(bob.decryptMessage(envelope, aliceDHPub, aliceSignPub)).toBe('')
  })

  it('round-trips a long message between peers', () => {
    const plaintext = 'x'.repeat(10_000)
    const envelope = alice.encryptMessage(plaintext, 'alice-id', 'bob-id', bobDHPub)
    expect(bob.decryptMessage(envelope, aliceDHPub, aliceSignPub)).toBe(plaintext)
  })

  it('round-trips unicode/emoji between peers', () => {
    const plaintext = '日本語テスト 🎉🚀 مرحبا'
    const envelope = bob.encryptMessage(plaintext, 'bob-id', 'alice-id', aliceDHPub)
    expect(alice.decryptMessage(envelope, bobDHPub, bobSignPub)).toBe(plaintext)
  })

  it('each encryption produces unique ciphertext (random nonce)', () => {
    const env1 = alice.encryptMessage('same', 'alice-id', 'bob-id', bobDHPub)
    const env2 = alice.encryptMessage('same', 'alice-id', 'bob-id', bobDHPub)
    expect(env1.ciphertext).not.toBe(env2.ciphertext)
    expect(env1.nonce).not.toBe(env2.nonce)
    // But both decrypt to the same plaintext
    expect(bob.decryptMessage(env1, aliceDHPub, aliceSignPub)).toBe('same')
    expect(bob.decryptMessage(env2, aliceDHPub, aliceSignPub)).toBe('same')
  })
})

// ── 2. Cross-peer signJson / verifyJsonSignature ─────────────────────────────

describe('cross-peer JSON signing', () => {
  it('Alice signs → Bob verifies (returns Alice pubkey)', () => {
    const signed = alice.signJson({ type: 'signal_offer', to: 'bob', sdp: 'v=0...' })
    const result = bob.verifyJsonSignature(signed)
    expect(result).toBe(aliceSignPub)
  })

  it('Bob signs → Alice verifies (returns Bob pubkey)', () => {
    const signed = bob.signJson({ type: 'signal_answer', to: 'alice', sdp: 'v=0...' })
    const result = alice.verifyJsonSignature(signed)
    expect(result).toBe(bobSignPub)
  })

  it('tampered payload fails cross-peer verification', () => {
    const signed = alice.signJson({ type: 'offer', data: 'original' })
    const tampered = { ...signed, data: 'modified' }
    expect(bob.verifyJsonSignature(tampered)).toBeNull()
  })

  it('missing __sig fails verification', () => {
    const plain = { type: 'test', from: 'alice-id' }
    expect(bob.verifyJsonSignature(plain)).toBeNull()
  })

  it('canonical ordering is consistent across peers', () => {
    // Alice signs with fields in one order
    const signedA = alice.signJson({ z: 1, a: 2, m: 3 })
    // Bob verifies — canonical sort means field order doesn't matter
    expect(bob.verifyJsonSignature(signedA)).toBe(aliceSignPub)

    // Reconstruct with different insertion order — same canonical JSON
    const reordered = { a: 2, m: 3, z: 1, __sig: signedA.__sig, __pub: signedA.__pub }
    expect(bob.verifyJsonSignature(reordered)).toBe(aliceSignPub)
  })
})

// ── 3. Signal payload signing (simulates sendSignal → handleSignalMessage) ──

describe('signal payload round-trip', () => {
  /**
   * Simulates the exact flow from networkStore:
   *   sendSignal: cryptoService.signJson(payload) → wire
   *   handleSignalMessage: cryptoService.verifyJsonSignature(asObj)
   */
  function simulateSendSignal(
    sender: CryptoService,
    payload: Record<string, unknown>,
  ): Record<string, unknown> {
    return sender.signJson(payload)
  }

  function simulateHandleSignalMessage(
    receiver: CryptoService,
    payload: Record<string, unknown>,
  ): { accepted: boolean; senderKey: string | null } {
    const asObj = payload as Record<string, unknown>
    if (asObj['__sig']) {
      const senderKey = receiver.verifyJsonSignature(asObj)
      if (!senderKey) {
        return { accepted: false, senderKey: null }
      }
      return { accepted: true, senderKey }
    }
    // No signature — backward compat (accepted with no key)
    return { accepted: true, senderKey: null }
  }

  it('signal_offer: Alice → Bob', () => {
    const payload = { type: 'signal_offer', to: 'bob-id', from: 'alice-id', sdp: 'v=0\r\no=- 123...' }
    const wire = simulateSendSignal(alice, payload)
    const result = simulateHandleSignalMessage(bob, wire)
    expect(result.accepted).toBe(true)
    expect(result.senderKey).toBe(aliceSignPub)
  })

  it('signal_answer: Bob → Alice', () => {
    const payload = { type: 'signal_answer', to: 'alice-id', from: 'bob-id', sdp: 'v=0\r\no=- 456...' }
    const wire = simulateSendSignal(bob, payload)
    const result = simulateHandleSignalMessage(alice, wire)
    expect(result.accepted).toBe(true)
    expect(result.senderKey).toBe(bobSignPub)
  })

  it('signal_ice: Alice → Bob', () => {
    const payload = {
      type: 'signal_ice',
      to: 'bob-id',
      from: 'alice-id',
      candidate: { candidate: 'candidate:1 1 UDP 2130706431 192.168.1.1 12345 typ host', sdpMid: '0', sdpMLineIndex: 0 },
    }
    const wire = simulateSendSignal(alice, payload)
    const result = simulateHandleSignalMessage(bob, wire)
    expect(result.accepted).toBe(true)
  })

  it('tampered signal is rejected', () => {
    const payload = { type: 'signal_offer', to: 'bob-id', from: 'alice-id', sdp: 'original' }
    const wire = simulateSendSignal(alice, payload)
    // MITM alters the SDP
    const tampered = { ...wire, sdp: 'malicious-sdp' }
    const result = simulateHandleSignalMessage(bob, tampered)
    expect(result.accepted).toBe(false)
  })

  it('unsigned signal is accepted (backward compat)', () => {
    const payload = { type: 'signal_offer', to: 'bob-id', from: 'alice-id', sdp: 'v=0...' }
    // No signJson — simulates an older peer
    const result = simulateHandleSignalMessage(bob, payload)
    expect(result.accepted).toBe(true)
    expect(result.senderKey).toBeNull()
  })
})

// ── 4. Chat wire message: full encrypt → serialize → decrypt path ───────────

describe('chat wire message round-trip', () => {
  it('Alice sends a chat message; Bob receives and decrypts', () => {
    const content = 'Hello server chat!'
    const aliceId = 'alice-uuid'
    const bobId = 'bob-uuid'
    const serverId = 'server-uuid'
    const channelId = 'channel-uuid'
    const messageId = 'msg-uuid'

    // Alice encrypts for Bob (and herself)
    const envelopeForBob = alice.encryptMessage(content, aliceId, bobId, bobDHPub)
    const envelopeForSelf = alice.encryptMessage(content, aliceId, aliceId, aliceDHPub)

    // Construct the wire message (matches ChatWireMessage interface)
    const wireMsg = {
      type: 'chat_message' as const,
      messageId,
      channelId,
      serverId,
      authorId: aliceId,
      logicalTs: '1700000000000-000001',
      createdAt: new Date().toISOString(),
      contentType: 'text' as const,
      envelopes: [envelopeForBob, envelopeForSelf],
    }

    // Validate structure using actual ChatWireMessage field names
    expect(isValidChatMessage({
      messageId: wireMsg.messageId,
      channelId: wireMsg.channelId,
      serverId:  wireMsg.serverId,
      authorId:  wireMsg.authorId,
      envelopes: wireMsg.envelopes,
    })).toBe(true)

    // Bob finds his envelope
    const bobEnvelope = wireMsg.envelopes.find(e => e.recipientId === bobId)
    expect(bobEnvelope).toBeDefined()

    // Bob decrypts
    const decrypted = bob.decryptMessage(bobEnvelope!, aliceDHPub, aliceSignPub)
    expect(decrypted).toBe(content)

    // Alice can also decrypt her own copy
    const selfEnvelope = wireMsg.envelopes.find(e => e.recipientId === aliceId)
    expect(selfEnvelope).toBeDefined()
    const selfDecrypted = alice.decryptMessage(selfEnvelope!, aliceDHPub, aliceSignPub)
    expect(selfDecrypted).toBe(content)
  })

  it('Bob cannot decrypt envelope addressed to Alice', () => {
    const envelope = alice.encryptMessage('for Alice only', 'alice-id', 'alice-id', aliceDHPub)
    const result = bob.decryptMessage(envelope, aliceDHPub, aliceSignPub)
    expect(result).toBeNull()
  })

  it('multi-member chat: Alice encrypts for Bob, Charlie, and self', async () => {
    const charlie = new CryptoService()
    await charlie.init()
    await charlie.generateKeys()
    const charlieDHPub = charlie.getPublicDHKey()

    const content = 'Announcement to all!'
    const envBob = alice.encryptMessage(content, 'alice', 'bob', bobDHPub)
    const envCharlie = alice.encryptMessage(content, 'alice', 'charlie', charlieDHPub)
    const envSelf = alice.encryptMessage(content, 'alice', 'alice', aliceDHPub)

    expect(bob.decryptMessage(envBob, aliceDHPub, aliceSignPub)).toBe(content)
    expect(charlie.decryptMessage(envCharlie, aliceDHPub, aliceSignPub)).toBe(content)
    expect(alice.decryptMessage(envSelf, aliceDHPub, aliceSignPub)).toBe(content)

    // Cross-decryption fails
    expect(bob.decryptMessage(envCharlie, aliceDHPub, aliceSignPub)).toBeNull()
    expect(charlie.decryptMessage(envBob, aliceDHPub, aliceSignPub)).toBeNull()
  })
})

// ── 5. Server join request / response structure ─────────────────────────────

describe('server join request payload', () => {
  it('join request has valid structure and correct keys', () => {
    const request = {
      type: 'server_join_request',
      inviteToken: 'abc123',
      serverId: 'server-uuid',
      displayName: 'Bob',
      publicSignKey: bobSignPub,
      publicDHKey: bobDHPub,
    }

    expect(request.type).toBe('server_join_request')
    expect(request.publicSignKey).toBe(bobSignPub)
    expect(request.publicDHKey).toBe(bobDHPub)
    expect(typeof request.inviteToken).toBe('string')
    expect(typeof request.serverId).toBe('string')
  })

  it('join request keys match what was generated', () => {
    // Simulate: Bob generates keys, sends join request, Alice receives and stores
    const bobKeys = {
      publicSignKey: bobSignPub,
      publicDHKey: bobDHPub,
    }

    // Alice can now use these keys to encrypt messages to Bob
    const envelope = alice.encryptMessage('Welcome!', 'alice-id', 'bob-id', bobKeys.publicDHKey)
    const decrypted = bob.decryptMessage(envelope, aliceDHPub, aliceSignPub)
    expect(decrypted).toBe('Welcome!')

    // Alice can verify Bob's signatures using the sign key from the join request
    const signed = bob.signJson({ type: 'test' })
    expect(alice.verifyJsonSignature(signed)).toBe(bobKeys.publicSignKey)
  })
})

// ── 6. Member announce / gossip payloads ─────────────────────────────────────

describe('member announce and gossip', () => {
  it('member_announce payload passes validator', () => {
    // Wire format: { type, members: [...] }
    const announce = {
      type: 'member_announce',
      members: [{
        userId: 'bob-uuid',
        serverId: 'server-uuid',
        displayName: 'Bob',
        publicSignKey: bobSignPub,
        publicDHKey: bobDHPub,
        roles: ['member'],
      }],
    }

    expect(isValidMemberAnnounce(announce)).toBe(true)
  })

  it('member_announce with empty members array fails validation', () => {
    expect(isValidMemberAnnounce({ type: 'member_announce', members: [] })).toBe(false)
  })

  it('presence_update payload passes validator', () => {
    expect(isValidPresenceUpdate({ status: 'online' })).toBe(true)
    expect(isValidPresenceUpdate({ status: 'idle' })).toBe(true)
    expect(isValidPresenceUpdate({ status: 'dnd' })).toBe(true)
    expect(isValidPresenceUpdate({ status: 'offline' })).toBe(true)
    expect(isValidPresenceUpdate({ status: 'invalid' })).toBe(false)
  })

  it('typing_start payload passes validator', () => {
    expect(isValidTypingStart({ channelId: 'ch-uuid' })).toBe(true)
    expect(isValidTypingStart({})).toBe(false)
  })

  it('profile_update payload passes validator', () => {
    // Wire format: { type, payload: { displayName?, avatarDataUrl?, ... } }
    expect(isValidProfileUpdate({ payload: { displayName: 'NewName' } })).toBe(true)
    expect(isValidProfileUpdate({ payload: { avatarDataUrl: 'data:image/png;base64,...' } })).toBe(true)
    expect(isValidProfileUpdate({ payload: {} })).toBe(true) // empty payload object is still valid
    expect(isValidProfileUpdate({})).toBe(false)             // missing payload entirely
    expect(isValidProfileUpdate({ payload: null })).toBe(false)
  })
})

// ── 7. Mutation wire message structure ──────────────────────────────────────

describe('mutation wire messages', () => {
  it('edit mutation passes validator', () => {
    const msg = {
      type: 'mutation',
      serverId: 'server-uuid',
      mutation: {
        id: 'mut-uuid',
        type: 'edit',
        targetId: 'msg-uuid',
        channelId: 'ch-uuid',
        authorId: 'alice-uuid',
        newContent: 'edited text',
        logicalTs: '1700000000000-000002',
        createdAt: new Date().toISOString(),
      },
    }

    expect(isValidMutation(msg)).toBe(true)
  })

  it('reaction_add mutation passes validator', () => {
    const msg = {
      type: 'mutation',
      serverId: 'server-uuid',
      mutation: {
        id: 'mut-uuid',
        type: 'reaction_add',
        targetId: 'msg-uuid',
        channelId: 'ch-uuid',
        authorId: 'bob-uuid',
        emojiId: '👍',
        logicalTs: '1700000000000-000003',
        createdAt: new Date().toISOString(),
      },
    }

    expect(isValidMutation(msg)).toBe(true)
  })

  it('delete mutation passes validator', () => {
    const msg = {
      type: 'mutation',
      serverId: 'server-uuid',
      mutation: {
        id: 'mut-uuid',
        type: 'delete',
        targetId: 'msg-uuid',
        channelId: 'ch-uuid',
        authorId: 'alice-uuid',
        logicalTs: '1700000000000-000004',
        createdAt: new Date().toISOString(),
      },
    }

    expect(isValidMutation(msg)).toBe(true)
  })

  it('malformed mutation fails validator', () => {
    expect(isValidMutation({ type: 'mutation' })).toBe(false)
    expect(isValidMutation({ type: 'mutation', mutation: {} })).toBe(false)
    expect(isValidMutation({ type: 'mutation', mutation: { id: 'x' } })).toBe(false)
  })
})

// ── 8. Signal payload survives JSON round-trip (rendezvous relay simulation) ─

describe('signal payload JSON serialization round-trip', () => {
  it('signed signal survives JSON.stringify → JSON.parse (rendezvous relay)', () => {
    const payload = { type: 'signal_offer', to: 'bob-id', from: 'alice-id', sdp: 'v=0\r\no=- ...' }
    const signed = alice.signJson(payload)

    // Simulate relay: Rust receives, serializes to JSON, re-parses, emits
    const onWire = JSON.stringify(signed)
    const received = JSON.parse(onWire) as Record<string, unknown>

    // Bob verifies from deserialized JSON
    const result = bob.verifyJsonSignature(received)
    expect(result).toBe(aliceSignPub)
  })

  it('signed signal with nested objects survives round-trip', () => {
    const payload = {
      type: 'signal_ice',
      to: 'bob-id',
      from: 'alice-id',
      candidate: {
        candidate: 'candidate:1 1 UDP 2130706431 10.0.0.1 12345 typ host',
        sdpMid: '0',
        sdpMLineIndex: 0,
      },
    }
    const signed = alice.signJson(payload)
    const roundTripped = JSON.parse(JSON.stringify(signed)) as Record<string, unknown>
    expect(bob.verifyJsonSignature(roundTripped)).toBe(aliceSignPub)
  })

  it('signed signal survives serde_json BTreeMap reordering of nested keys', () => {
    // serde_json without preserve_order uses BTreeMap which alphabetically
    // reorders ALL object keys (including nested ones). This test simulates
    // what happens when a signal_ice payload transits through the Rust relay.
    const payload = {
      type: 'signal_ice',
      to: 'bob-id',
      from: 'alice-id',
      candidate: {
        candidate: 'candidate:1 1 UDP 2130706431 10.0.0.1 12345 typ host',
        sdpMid: '0',
        sdpMLineIndex: 0,
      },
    }
    const signed = alice.signJson(payload)

    // Simulate serde_json BTreeMap reordering: rebuild nested object with alphabetical keys
    const reordered: Record<string, unknown> = {}
    for (const k of Object.keys(signed).sort()) {
      const v = (signed as Record<string, unknown>)[k]
      if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
        const inner: Record<string, unknown> = {}
        for (const ik of Object.keys(v as Record<string, unknown>).sort()) {
          inner[ik] = (v as Record<string, unknown>)[ik]
        }
        reordered[k] = inner
      } else {
        reordered[k] = v
      }
    }

    // Verify the nested keys actually got reordered
    const origKeys = Object.keys((payload as Record<string, unknown>).candidate as object)
    const reorderedKeys = Object.keys(reordered.candidate as object)
    expect(reorderedKeys).toEqual([...origKeys].sort())
    expect(reorderedKeys).not.toEqual(origKeys) // sdpMLineIndex < sdpMid alphabetically

    // Verification must still pass despite the reordering
    expect(bob.verifyJsonSignature(reordered)).toBe(aliceSignPub)
  })

  it('signed signal with numeric values preserves types through JSON', () => {
    const payload = { type: 'test', count: 42, ratio: 3.14, flag: true }
    const signed = alice.signJson(payload)
    const roundTripped = JSON.parse(JSON.stringify(signed)) as Record<string, unknown>
    expect(bob.verifyJsonSignature(roundTripped)).toBe(aliceSignPub)
  })
})

// ── 9. Envelope structure integrity ─────────────────────────────────────────

describe('envelope structure', () => {
  it('cross-peer envelope has all required fields', () => {
    const env = alice.encryptMessage('test', 'alice-id', 'bob-id', bobDHPub)
    expect(env.version).toBe(1)
    expect(env.senderId).toBe('alice-id')
    expect(env.recipientId).toBe('bob-id')
    expect(typeof env.ciphertext).toBe('string')
    expect(typeof env.nonce).toBe('string')
    expect(typeof env.senderSignature).toBe('string')
    expect(env.ciphertext.length).toBeGreaterThan(0)
    expect(env.nonce.length).toBeGreaterThan(0)
    expect(env.senderSignature.length).toBeGreaterThan(0)
  })

  it('envelope survives JSON round-trip and still decrypts', () => {
    const env = alice.encryptMessage('round-trip test', 'alice-id', 'bob-id', bobDHPub)
    const serialized = JSON.stringify(env)
    const deserialized = JSON.parse(serialized) as EncryptedEnvelope

    const result = bob.decryptMessage(deserialized, aliceDHPub, aliceSignPub)
    expect(result).toBe('round-trip test')
  })
})

// ── 10. Cross-peer Ed25519 sign/verify (raw bytes) ──────────────────────────

describe('cross-peer raw Ed25519 signing', () => {
  it('Alice signs → Bob verifies with Alice public key', () => {
    const data = new TextEncoder().encode('important data')
    const sig = alice.sign(data)
    expect(bob.verify(data, sig, aliceSignPub)).toBe(true)
  })

  it('Bob signs → Alice verifies with Bob public key', () => {
    const data = new TextEncoder().encode('bob signed this')
    const sig = bob.sign(data)
    expect(alice.verify(data, sig, bobSignPub)).toBe(true)
  })

  it('wrong public key rejects', () => {
    const data = new TextEncoder().encode('alice data')
    const sig = alice.sign(data)
    // Verify with Bob's key — should fail
    expect(bob.verify(data, sig, bobSignPub)).toBe(false)
  })
})
