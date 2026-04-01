/**
 * cryptoService — all libsodium operations.
 *
 * Private keys are held exclusively in this module's memory.
 * They are NEVER stored in Pinia stores or passed to the UI layer.
 */

import _sodium from 'libsodium-wrappers'
import type { EncryptedEnvelope } from '@/types/core'

type SodiumType = typeof _sodium

class CryptoService {
  private sodium: SodiumType | null = null

  // Private keys — held only in this module
  private signKeyPair:  { publicKey: Uint8Array; privateKey: Uint8Array } | null = null
  private dhKeyPair:    { publicKey: Uint8Array; privateKey: Uint8Array } | null = null

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
}

export const cryptoService = new CryptoService()
