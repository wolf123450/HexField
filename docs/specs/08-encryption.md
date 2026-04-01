# Spec 08 — Encryption Layer

> Parent: [Architecture Plan](../architecture-plan.md)

---

## 1. Library: libsodium-wrappers (WASM)

Private keys and plaintext stay inside the JS/WASM runtime. The Rust backend only persists/loads encrypted key bytes to/from SQLite. Passing plaintext across the IPC boundary would be worse.

**Phase 2 note**: Argon2id KDF (for passphrase-wrapped keys) requires `libsodium-wrappers-sumo` — the full build. The standard `libsodium-wrappers` package omits it. Swap the npm dependency when implementing Phase 2.

**Primitives used:**

| Primitive | Function |
|-----------|----------|
| `crypto_box_easy` / `crypto_box_open_easy` | X25519 ECDH + XSalsa20-Poly1305 AEAD — message encryption |
| `crypto_sign` / `crypto_sign_verify_detached` | Ed25519 — signatures on messages and mutations |
| `randombytes_buf` | Secure nonce generation |
| `crypto_generichash` | BLAKE2b — content hashing (future dedup) |
| `crypto_pwhash` | Argon2id — key derivation from passphrase (Phase 2, sumo build only) |

---

## 2. cryptoService — `src/utils/cryptoService.ts`

```typescript
import _sodium from 'libsodium-wrappers'

class CryptoService {
  private signKeypair: _sodium.KeyPair | null = null
  private dhKeypair:   _sodium.KeyPair | null = null

  async init(): Promise<void>
  // await _sodium.ready, then loadOrGenerateKeys()

  private async loadOrGenerateKeys(): Promise<void>
  // invoke('db_load_key', 'identity_sign') — reconstruct from stored secret bytes
  // If missing: generate fresh keypair, invoke('db_save_key', ...)
  // Hold both keypairs in instance variables for session lifetime

  getPublicSignKey(): string    // sodium.to_base64(signKeypair.publicKey)
  getPublicDHKey():   string    // sodium.to_base64(dhKeypair.publicKey)

  encryptMessage(
    plaintext: string,
    recipientDHPubKey: string,
    senderId: string,
    recipientId: string
  ): EncryptedEnvelope
  // 1. nonce = sodium.randombytes_buf(24)
  // 2. ciphertext = sodium.crypto_box_easy(plaintext, nonce, recipientPubKey, myDHSecretKey)
  // 3. signature = sodium.crypto_sign_detached(concat(ciphertext, nonce), mySignSecretKey)
  // 4. return { version:1, senderId, recipientId, ciphertext: b64, nonce: b64, senderSignature: b64 }

  decryptMessage(
    envelope: EncryptedEnvelope,
    senderDHPubKey: string,
    senderSignPubKey: string
  ): string | null
  // 1. Verify Ed25519 signature — return null if invalid (never display unverified messages)
  // 2. crypto_box_open_easy — return null on decryption failure
  // 3. return sodium.to_string(plaintext)

  signData(data: Uint8Array): string           // base64 Ed25519 signature
  verifySignature(data: Uint8Array, sig: string, pubKey: string): boolean
}

export const cryptoService = new CryptoService()
```

---

## 3. Group Message Flow

For a channel with N members — produce N encrypted envelopes (one per recipient, including self for own history):

```typescript
async function sendToChannel(channelId: string, plaintext: string): Promise<void> {
  const members = serversStore.getMembersForChannel(channelId)
  const envelopes: EncryptedEnvelope[] = []

  for (const member of members) {
    // Also encrypt to each of this member's attested devices
    const devices = devicesStore.getActiveDevices(member.userId)
    for (const device of devices) {
      envelopes.push(
        cryptoService.encryptMessage(plaintext, device.publicDHKey, myUserId, device.deviceId)
      )
    }
  }

  signalingService.send({ type: 'chat_message', channelId, envelopes })
}
```

> **Scalability note**: N-envelope overhead is significant for large channels (>50 members). Phase 3+ enhancement: symmetric group key distributed via per-member asymmetric envelopes (similar to Signal's Sealed Sender or RFC 9420 MLS).

---

## 4. Encrypted Envelope Format

```typescript
interface EncryptedEnvelope {
  version:         1
  senderId:        string   // userId of sender
  recipientId:     string   // userId or deviceId of recipient
  ciphertext:      string   // base64 XSalsa20-Poly1305 output
  nonce:           string   // base64 24-byte random nonce
  senderSignature: string   // base64 Ed25519 sig over concat(ciphertext, nonce)
}
```

Recipients filter incoming envelope arrays by `recipientId === myUserId || myDeviceIds.includes(recipientId)`.

---

## 5. Mutation Signing

All mutations that change server state (role_assign, server_update, etc.) must be signed:

```typescript
function signMutation(mutation: Omit<Mutation, 'verified'>): Mutation & { sig: string } {
  const payload = JSON.stringify({
    id: mutation.id, type: mutation.type, targetId: mutation.targetId,
    authorId: mutation.authorId, newContent: mutation.newContent,
    logicalTs: mutation.logicalTs,
  })
  const sig = cryptoService.signData(sodium.from_string(payload))
  return { ...mutation, sig, verified: true }
}
```

Peers verify the signature before applying the mutation. Invalid signatures are silently dropped.

---

## 6. Key Storage Security Tiers

| Phase | Method |
|-------|--------|
| Phase 1 | Raw base64 in SQLite `key_store` (protected by OS user account AppData permissions) |
| Phase 2 | Argon2id KDF (libsodium-wrappers-sumo) from user passphrase → XSalsa20-Poly1305 wrap before SQLite storage |
| Phase 3 | OS keychain via Rust `keyring` crate (Windows Credential Manager / macOS Keychain / libsecret) |

---

## 7. Key Identifiers in `key_store`

| `key_id` | `key_type` | Contents |
|----------|------------|----------|
| `identity_sign` | `sign_secret` | Ed25519 secret key bytes (base64) |
| `identity_dh` | `dh_secret` | X25519 secret key bytes (base64) |
| `device_{deviceId}_sign` | `sign_secret` | Per-device Ed25519 secret key |
| `device_{deviceId}_dh` | `dh_secret` | Per-device X25519 secret key |

---

## 8. Forward Secrecy (Future, Phase 3+)

Phase 1 uses static X25519 keypairs — no forward secrecy. Future enhancements:
- **1:1 DMs**: X3DH (Extended Triple Diffie-Hellman) + Double Ratchet
- **Group channels**: MLS (RFC 9420 Messaging Layer Security)
- Both require prekey bundle support on the rendezvous server
