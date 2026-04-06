// @vitest-environment node
import { describe, it, expect, beforeAll } from 'vitest'
import { cryptoService } from '@/services/cryptoService'

// cryptoService is a module-level singleton. We init once for all tests.
// Keys are generated fresh on each test run, so all tests share the same
// alice/bob key pairs for the duration of this suite.
let aliceDHPub: string
let aliceSignPub: string

// A second in-process "recipient" reuses the same CryptoService singleton
// after loading a distinct key set, then restores Alice's keys after the
// test block.  For round-trip tests we use self-encryption (sender === recipient)
// which is valid with X25519 box: shared_key = scalarmult(pub, priv).

describe('cryptoService', () => {
  beforeAll(async () => {
    await cryptoService.init()
    await cryptoService.generateKeys()
    aliceDHPub   = cryptoService.getPublicDHKey()
    aliceSignPub = cryptoService.getPublicSignKey()
  })

  // ── Round-trip ─────────────────────────────────────────────────────────────

  it('encrypt → decrypt round-trip (self-encryption)', () => {
    const plaintext = 'Hello, secure world! 🔒'
    const envelope  = cryptoService.encryptMessage(plaintext, 'alice', 'alice', aliceDHPub)
    const result    = cryptoService.decryptMessage(envelope, aliceDHPub, aliceSignPub)
    expect(result).toBe(plaintext)
  })

  it('round-trips an empty string', () => {
    const envelope = cryptoService.encryptMessage('', 'alice', 'alice', aliceDHPub)
    expect(cryptoService.decryptMessage(envelope, aliceDHPub, aliceSignPub)).toBe('')
  })

  it('round-trips a long message', () => {
    const plaintext = 'x'.repeat(10_000)
    const envelope  = cryptoService.encryptMessage(plaintext, 'alice', 'alice', aliceDHPub)
    expect(cryptoService.decryptMessage(envelope, aliceDHPub, aliceSignPub)).toBe(plaintext)
  })

  // ── Tamper detection ───────────────────────────────────────────────────────

  it('returns null when ciphertext is tampered', () => {
    const envelope  = cryptoService.encryptMessage('secret', 'alice', 'alice', aliceDHPub)
    // Corrupt the last 4 base64 characters of the ciphertext
    const tampered  = { ...envelope, ciphertext: envelope.ciphertext.slice(0, -4) + 'AAAA' }
    expect(cryptoService.decryptMessage(tampered, aliceDHPub, aliceSignPub)).toBeNull()
  })

  it('returns null when the nonce is tampered', () => {
    const envelope = cryptoService.encryptMessage('secret', 'alice', 'alice', aliceDHPub)
    const tampered = { ...envelope, nonce: envelope.nonce.slice(0, -4) + 'BBBB' }
    expect(cryptoService.decryptMessage(tampered, aliceDHPub, aliceSignPub)).toBeNull()
  })

  it('returns null when the sender sign key is wrong', () => {
    const envelope = cryptoService.encryptMessage('secret', 'alice', 'alice', aliceDHPub)
    // All-zeros 32-byte Ed25519 public key (44-char base64) — valid length, wrong key
    const wrongSignKey = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='
    expect(cryptoService.decryptMessage(envelope, aliceDHPub, wrongSignKey)).toBeNull()
  })

  // ── Non-determinism ────────────────────────────────────────────────────────

  it('produces a different ciphertext for the same plaintext each time (random nonce)', () => {
    const env1 = cryptoService.encryptMessage('same plaintext', 'alice', 'alice', aliceDHPub)
    const env2 = cryptoService.encryptMessage('same plaintext', 'alice', 'alice', aliceDHPub)
    expect(env1.ciphertext).not.toBe(env2.ciphertext)
    expect(env1.nonce).not.toBe(env2.nonce)
  })

  // ── Envelope shape ─────────────────────────────────────────────────────────

  it('envelope has the expected fields', () => {
    const env = cryptoService.encryptMessage('hi', 'alice', 'bob', aliceDHPub)
    expect(env.version).toBe(1)
    expect(env.senderId).toBe('alice')
    expect(env.recipientId).toBe('bob')
    expect(typeof env.ciphertext).toBe('string')
    expect(typeof env.nonce).toBe('string')
    expect(typeof env.senderSignature).toBe('string')
  })

  // ── Ed25519 sign / verify ─────────────────────────────────────────────────

  it('sign() + verify() round-trip on identity key', () => {
    const data = new TextEncoder().encode('sign this payload')
    const sig  = cryptoService.sign(data)
    expect(cryptoService.verify(data, sig, aliceSignPub)).toBe(true)
  })

  it('verify() returns false for a tampered payload', () => {
    const data    = new TextEncoder().encode('original payload')
    const sig     = cryptoService.sign(data)
    const tampered = new TextEncoder().encode('tampered payload')
    expect(cryptoService.verify(tampered, sig, aliceSignPub)).toBe(false)
  })

  it('verify() returns false for the wrong public key', () => {
    const data     = new TextEncoder().encode('some data')
    const sig      = cryptoService.sign(data)
    const wrongKey = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='
    expect(cryptoService.verify(data, sig, wrongKey)).toBe(false)
  })

  // ── Key determinism ───────────────────────────────────────────────────────

  it('loadKeys() reproduces the same public keys from the same secret bytes', async () => {
    const { signSecret, dhSecret } = await cryptoService.generateKeys()
    const signPub1 = cryptoService.getPublicSignKey()
    const dhPub1   = cryptoService.getPublicDHKey()

    // Re-load from the same secrets — public keys must be deterministic
    await cryptoService.loadKeys(signSecret, dhSecret)
    expect(cryptoService.getPublicSignKey()).toBe(signPub1)
    expect(cryptoService.getPublicDHKey()).toBe(dhPub1)
  })

  // ── Device key round-trip ──────────────────────────────────────────────────

  it('generateDeviceKeys + loadDeviceKeys + getDevicePublicSignKey/DHKey', async () => {
    const { deviceSignSecret, deviceDHSecret } = await cryptoService.generateDeviceKeys()
    const signPub = cryptoService.getDevicePublicSignKey()
    const dhPub   = cryptoService.getDevicePublicDHKey()

    // Reload from secrets — should reproduce the same public keys
    await cryptoService.loadDeviceKeys(deviceSignSecret, deviceDHSecret)
    expect(cryptoService.getDevicePublicSignKey()).toBe(signPub)
    expect(cryptoService.getDevicePublicDHKey()).toBe(dhPub)
  })

  // ── Passphrase wrap / unwrap ──────────────────────────────────────────────

  it('wrapKeysWithPassphrase + unwrapKeysWithPassphrase: correct passphrase recovers keypair', async () => {
    const signPubBefore = cryptoService.getPublicSignKey()
    const dhPubBefore   = cryptoService.getPublicDHKey()

    const wrapped = cryptoService.wrapKeysWithPassphrase('correct-horse-battery-staple')
    expect(wrapped.version).toBe(2)
    expect(typeof wrapped.salt).toBe('string')
    expect(typeof wrapped.nonce).toBe('string')
    expect(typeof wrapped.ciphertext).toBe('string')

    // Unwrap: should silently succeed and reproduce the same public keys
    await cryptoService.unwrapKeysWithPassphrase(wrapped, 'correct-horse-battery-staple')
    expect(cryptoService.getPublicSignKey()).toBe(signPubBefore)
    expect(cryptoService.getPublicDHKey()).toBe(dhPubBefore)
  })

  it('unwrapKeysWithPassphrase: wrong passphrase throws', async () => {
    const wrapped = cryptoService.wrapKeysWithPassphrase('correct-passphrase')
    await expect(
      cryptoService.unwrapKeysWithPassphrase(wrapped, 'wrong-passphrase'),
    ).rejects.toThrow()
  })

  // ── signJson / verifyJsonSignature ─────────────────────────────────────────

  it('signJson attaches __sig and __pub fields', () => {
    const currentPub = cryptoService.getPublicSignKey()
    const signed = cryptoService.signJson({ type: 'hello', data: 42 })
    expect(typeof signed.__sig).toBe('string')
    expect(typeof signed.__pub).toBe('string')
    expect(signed.__pub).toBe(currentPub)
  })

  it('verifyJsonSignature returns senderPubKey for a valid signed object', () => {
    const currentPub = cryptoService.getPublicSignKey()
    const signed = cryptoService.signJson({ type: 'test', value: 'abc' })
    const result = cryptoService.verifyJsonSignature(signed)
    expect(result).toBe(currentPub)
  })

  it('verifyJsonSignature returns null when __sig is missing', () => {
    const plain = { type: 'test', value: 'abc' }
    expect(cryptoService.verifyJsonSignature(plain)).toBeNull()
  })

  it('verifyJsonSignature returns null when payload is tampered', () => {
    const signed = cryptoService.signJson({ type: 'test', value: 'abc' })
    const tampered = { ...signed, value: 'xyz' }
    expect(cryptoService.verifyJsonSignature(tampered)).toBeNull()
  })

  it('verifyJsonSignature is stable across field insertion order (canonical)', () => {
    const a = cryptoService.signJson({ b: 2, a: 1 })
    const b = cryptoService.signJson({ a: 1, b: 2 })
    // Both should produce the same canonical JSON → same signature
    const currentPub = cryptoService.getPublicSignKey()
    expect(cryptoService.verifyJsonSignature(a)).toBe(currentPub)
    expect(a.__sig).toBe(b.__sig)
  })
})
