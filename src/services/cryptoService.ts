/**
 * cryptoService — all libsodium operations.
 *
 * Private keys are held exclusively in this module's memory.
 * They are NEVER stored in Pinia stores or passed to the UI layer.
 */

import _sodium from 'libsodium-wrappers-sumo'
import type { EncryptedEnvelope } from '@/types/core'

type SodiumType = typeof _sodium

class CryptoService {
  private sodium: SodiumType | null = null

  // Identity keys — one per user, shared across devices
  private signKeyPair:       { publicKey: Uint8Array; privateKey: Uint8Array } | null = null
  private dhKeyPair:         { publicKey: Uint8Array; privateKey: Uint8Array } | null = null

  // Device keys — one per physical device install
  private deviceSignKeyPair: { publicKey: Uint8Array; privateKey: Uint8Array } | null = null
  private deviceDHKeyPair:   { publicKey: Uint8Array; privateKey: Uint8Array } | null = null

  async init(): Promise<void> {
    await _sodium.ready
    this.sodium = _sodium
  }

  async generateKeys(): Promise<{ signSecret: string; dhSecret: string }> {
    const s = this.sodium!
    this.signKeyPair = s.crypto_sign_keypair()
    this.dhKeyPair   = s.crypto_box_keypair()

    return {
      signSecret: s.to_base64(this.signKeyPair.privateKey),
      dhSecret:   s.to_base64(this.dhKeyPair.privateKey),
    }
  }

  async loadKeys(signSecretB64: string, dhSecretB64: string): Promise<void> {
    const s = this.sodium!
    const signSecret = s.from_base64(signSecretB64)
    const dhSecret   = s.from_base64(dhSecretB64)

    // Ed25519: libsodium's 64-byte sk encodes [seed(32) || pubkey(32)]
    this.signKeyPair = {
      privateKey: signSecret,
      publicKey:  signSecret.slice(32, 64),
    }
    this.dhKeyPair = {
      privateKey: dhSecret,
      publicKey:  s.crypto_scalarmult_base(dhSecret),
    }
  }

  getPublicSignKey(): string {
    const s = this.sodium!
    return s.to_base64(this.signKeyPair!.publicKey)
  }

  getPublicDHKey(): string {
    const s = this.sodium!
    return s.to_base64(this.dhKeyPair!.publicKey)
  }

  /**
   * Encrypt a message for a single recipient.
   * Returns an EncryptedEnvelope ready to send over the wire.
   */
  encryptMessage(
    plaintext: string,
    senderId: string,
    recipientId: string,
    recipientDHKeyB64: string,
  ): EncryptedEnvelope {
    const s = this.sodium!
    const recipientPubKey = s.from_base64(recipientDHKeyB64)
    const nonce = s.randombytes_buf(s.crypto_box_NONCEBYTES)

    const ciphertextBytes = s.crypto_box_easy(
      s.from_string(plaintext),
      nonce,
      recipientPubKey,
      this.dhKeyPair!.privateKey,
    )

    const ciphertext = s.to_base64(ciphertextBytes)
    const nonceB64   = s.to_base64(nonce)

    // Sign (ciphertext + nonce) concatenated
    const toSign = new Uint8Array([...ciphertextBytes, ...nonce])
    const sig    = s.crypto_sign_detached(toSign, this.signKeyPair!.privateKey)

    return {
      version:         1,
      senderId,
      recipientId,
      ciphertext,
      nonce:           nonceB64,
      senderSignature: s.to_base64(sig),
    }
  }

  /**
   * Decrypt an incoming envelope. Returns null if verification fails.
   */
  decryptMessage(
    envelope: EncryptedEnvelope,
    senderDHKeyB64: string,
    senderSignKeyB64: string,
  ): string | null {
    const s = this.sodium!
    try {
      const ciphertextBytes = s.from_base64(envelope.ciphertext)
      const nonce           = s.from_base64(envelope.nonce)
      const sig             = s.from_base64(envelope.senderSignature)
      const senderSignKey   = s.from_base64(senderSignKeyB64)
      const senderDHKey     = s.from_base64(senderDHKeyB64)

      // Verify signature
      const toVerify = new Uint8Array([...ciphertextBytes, ...nonce])
      const valid = s.crypto_sign_verify_detached(sig, toVerify, senderSignKey)
      if (!valid) return null

      // Decrypt
      const plaintext = s.crypto_box_open_easy(
        ciphertextBytes,
        nonce,
        senderDHKey,
        this.dhKeyPair!.privateKey,
      )
      return s.to_string(plaintext)
    } catch {
      return null
    }
  }

  /**
   * Generate a fresh device keypair (separate from identity keys).
   * Returns secrets as base64 for persistence.
   */
  async generateDeviceKeys(): Promise<{ deviceSignSecret: string; deviceDHSecret: string }> {
    const s = this.sodium!
    this.deviceSignKeyPair = s.crypto_sign_keypair()
    this.deviceDHKeyPair   = s.crypto_box_keypair()
    return {
      deviceSignSecret: s.to_base64(this.deviceSignKeyPair.privateKey),
      deviceDHSecret:   s.to_base64(this.deviceDHKeyPair.privateKey),
    }
  }

  async loadDeviceKeys(deviceSignSecretB64: string, deviceDHSecretB64: string): Promise<void> {
    const s = this.sodium!
    const deviceSignSecret = s.from_base64(deviceSignSecretB64)
    const deviceDHSecret   = s.from_base64(deviceDHSecretB64)
    this.deviceSignKeyPair = {
      privateKey: deviceSignSecret,
      publicKey:  deviceSignSecret.slice(32, 64),
    }
    this.deviceDHKeyPair = {
      privateKey: deviceDHSecret,
      publicKey:  s.crypto_scalarmult_base(deviceDHSecret),
    }
  }

  getDevicePublicSignKey(): string {
    const s = this.sodium!
    return s.to_base64(this.deviceSignKeyPair!.publicKey)
  }

  getDevicePublicDHKey(): string {
    const s = this.sodium!
    return s.to_base64(this.deviceDHKeyPair!.publicKey)
  }

  /**
   * Sign an attestation payload with the device sign key.
   * Input is JSON-stringified; returns base64 signature.
   */
  signAttestation(payload: object): string {
    const s = this.sodium!
    const bytes = s.from_string(JSON.stringify(payload))
    const sig   = s.crypto_sign_detached(bytes, this.deviceSignKeyPair!.privateKey)
    return s.to_base64(sig)
  }

  /**
   * Verify an attestation signed by a known device sign key.
   */
  verifyAttestation(payload: object, sigB64: string, deviceSignKeyB64: string): boolean {
    const s = this.sodium!
    try {
      const bytes = s.from_string(JSON.stringify(payload))
      return s.crypto_sign_verify_detached(
        s.from_base64(sigB64),
        bytes,
        s.from_base64(deviceSignKeyB64),
      )
    } catch {
      return false
    }
  }

  /**
   * Sign arbitrary data with the local Ed25519 signing key.
   */
  sign(data: Uint8Array): string {
    const s = this.sodium!
    const sig = s.crypto_sign_detached(data, this.signKeyPair!.privateKey)
    return s.to_base64(sig)
  }

  /**
   * Verify an Ed25519 signature.
   */
  verify(data: Uint8Array, signatureB64: string, publicKeyB64: string): boolean {
    const s = this.sodium!
    try {
      return s.crypto_sign_verify_detached(
        s.from_base64(signatureB64),
        data,
        s.from_base64(publicKeyB64),
      )
    } catch {
      return false
    }
  }

  /**
   * Export the raw (unencrypted) identity secret keys as base64.
   * Used by removePassphrase() to re-write raw keys after decrypting.
   * Returns null if keys are not loaded.
   */
  getRawIdentitySecrets(): { signSecret: string; dhSecret: string } | null {
    const s = this.sodium!
    if (!this.signKeyPair || !this.dhKeyPair) return null
    return {
      signSecret: s.to_base64(this.signKeyPair.privateKey),
      dhSecret:   s.to_base64(this.dhKeyPair.privateKey),
    }
  }

  // ── Phase 2: Passphrase-wrapped key storage ─────────────────────────────

  /**
   * Encrypt the raw identity secrets with a user-supplied passphrase.
   *
   * Uses Argon2id (crypto_pwhash) to derive a 32-byte symmetric key from the
   * passphrase + random salt, then wraps the concatenated secrets with
   * XSalsa20-Poly1305 (crypto_secretbox_easy).
   *
   * Returns a JSON-serialisable object that can be stored as-is in key_store.
   */
  wrapKeysWithPassphrase(passphrase: string): {
    version:    2
    salt:       string   // base64 16-byte Argon2id salt
    nonce:      string   // base64 24-byte secretbox nonce
    ciphertext: string   // base64 wrapped keys
  } {
    const s = this.sodium!
    if (!this.signKeyPair || !this.dhKeyPair) throw new Error('Keys not loaded')

    // Concatenate secret bytes: [signSecret(64)] + [dhSecret(32)]
    const plaintext = new Uint8Array([
      ...this.signKeyPair.privateKey,
      ...this.dhKeyPair.privateKey,
    ])

    const salt  = s.randombytes_buf(s.crypto_pwhash_SALTBYTES)
    const nonce = s.randombytes_buf(s.crypto_secretbox_NONCEBYTES)

    // Argon2id — interactive parameters (fast enough for a user login prompt)
    const derivedKey = s.crypto_pwhash(
      s.crypto_secretbox_KEYBYTES,
      passphrase,
      salt,
      s.crypto_pwhash_OPSLIMIT_INTERACTIVE,
      s.crypto_pwhash_MEMLIMIT_INTERACTIVE,
      s.crypto_pwhash_ALG_ARGON2ID13,
    )

    const ciphertext = s.crypto_secretbox_easy(plaintext, nonce, derivedKey)

    return {
      version:    2,
      salt:       s.to_base64(salt),
      nonce:      s.to_base64(nonce),
      ciphertext: s.to_base64(ciphertext),
    }
  }

  /**
   * Decrypt a passphrase-wrapped key bundle and load the keys into memory.
   * Throws if the passphrase is wrong or the ciphertext is corrupted.
   */
  async unwrapKeysWithPassphrase(
    wrapped: { version: 2; salt: string; nonce: string; ciphertext: string },
    passphrase: string,
  ): Promise<void> {
    const s = this.sodium!
    const salt       = s.from_base64(wrapped.salt)
    const nonce      = s.from_base64(wrapped.nonce)
    const ciphertext = s.from_base64(wrapped.ciphertext)

    const derivedKey = s.crypto_pwhash(
      s.crypto_secretbox_KEYBYTES,
      passphrase,
      salt,
      s.crypto_pwhash_OPSLIMIT_INTERACTIVE,
      s.crypto_pwhash_MEMLIMIT_INTERACTIVE,
      s.crypto_pwhash_ALG_ARGON2ID13,
    )

    // This throws if MAC verification fails (wrong passphrase or tampered data)
    const plaintext = s.crypto_secretbox_open_easy(ciphertext, nonce, derivedKey)

    // Reconstruct keypairs from the decrypted secret bytes:
    // first 64 bytes = Ed25519 sign secret, next 32 = X25519 DH secret
    const signSecret = plaintext.slice(0, 64)
    const dhSecret   = plaintext.slice(64, 96)
    await this.loadKeys(s.to_base64(signSecret), s.to_base64(dhSecret))
  }
}

export const cryptoService = new CryptoService()
