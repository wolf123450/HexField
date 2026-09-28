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

The real code is `messagesStore.sendMessage` + `services/chatWire.ts`:

```typescript
const targets: EnvelopeTarget[] = []
for (const member of Object.values(serversStore.members[serverId])) {
  if (member.publicDHKey) targets.push({ recipientId: member.userId, dhKey: member.publicDHKey })
  // Also encrypt to each of this member's attested devices
  for (const device of devicesStore.getActiveDevices(member.userId)) {
    if (device.publicDHKey !== member.publicDHKey)
      targets.push({ recipientId: member.userId, dhKey: device.publicDHKey })
  }
}
// encryptMessage(plaintext, senderId, recipientId, recipientDHKey) per target,
// plus the encrypted attachment blob (§4.1) when there are attachments
const { envelopes, attachmentsCipher } =
  buildChatEnvelopes(cryptoService, content, myUserId, targets, attachments)

networkStore.broadcastToServer(serverId, { type: 'chat_message', ..., envelopes, attachmentsCipher })
```

**Delivery scope.** Chat messages, chat mutations (`reaction_add`, `reaction_remove`,
`edit`, `delete`) and `attachment_want` for a chat attachment go through
`networkStore.broadcastToServer(serverId, ...)`: only connected peers that are members
of that server receive them. This is the same set that receives an envelope, so
non-members lose nothing they could read. Avatar/emoji `attachment_want` (no
`messageId`) and server-level mutations still go to every connected peer.

**Receive check.** `receiveEncryptedMessage` accepts a message only if its `authorId`
is a member of its `serverId`. If the member record is missing, it retries with the
same backoff as for missing keys (5 × 2 s), because `member_join` can still be in
flight through sync, and then drops the message. Members of a server that has not been
opened yet are loaded from the DB on demand. Note: history sync (`sync_push`) writes
rows without this check.

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
  attachmentKey?:  SealedBox // 0.2.14+: see §4.1
}
```

Recipients filter incoming envelope arrays by `recipientId === myUserId || myDeviceIds.includes(recipientId)`.

### 4.1 Encrypted attachment metadata (0.2.14+)

Attachment metadata (file name, size, MIME type, BLAKE3 hash, inline preview) is
private. Before 0.2.14 it travelled in plaintext as `chat_message.attachments`, next
to the envelopes. Now it is encrypted:

1. The sender encrypts `JSON.stringify(attachments)` **once** with
   `crypto_secretbox_easy` under a fresh random key → `chat_message.attachmentsCipher:
   { ciphertext, nonce }`. One blob, not one per recipient, because the previews are
   large (per-recipient copies would not fit a data-channel frame).
2. For each envelope, the sender boxes `JSON.stringify({ k: key, h: blobHash })` with
   `crypto_box_easy` (sender DH secret → the envelope's recipient DH key) →
   `envelope.attachmentKey: { ciphertext, nonce }`.
   `blobHash = crypto_generichash(32, ciphertext ‖ nonce)` of the blob. The hash stops
   a recipient, who knows the key, from giving another recipient a different blob in
   the sender's name: they cannot make a sender→third-party box.
3. The receiver opens its `attachmentKey` with the sender's DH key, checks `h` against
   the blob, opens the blob, then runs `sanitizeAttachments`. Any failure → the message
   is kept with no attachments.

Code: `cryptoService.sealForRecipients` / `openSealed`, and `services/chatWire.ts`
(`buildChatEnvelopes`, `readChatAttachments`).

**Compatibility.** There is no version bump: `EncryptedEnvelope.version` stays `1`,
and the presence of the optional fields is the signal.

| Sender → receiver | Result |
|---|---|
| new → new | `attachmentsCipher` + `attachmentKey` → attachments decrypted. |
| old → new | No `attachmentsCipher` → the receiver reads the legacy plaintext `attachments`. |
| new → old | The old client ignores the unknown fields. It shows the text but **no attachments** (an image-only message shows as an empty message). Accepted degradation. It does not heal later: the old client stores the row without attachments, and sync dedupes by ID. (A message the old client first gets through history sync does have its attachments, because `sync_push` sends stored rows.) |
| new, both fields present | `attachmentsCipher` wins; plaintext `attachments` is ignored, never merged. |

New senders never send plaintext `attachments`. The envelope's v1 fields and signature
are unchanged, so old clients still decrypt the text. Tests:
`src/services/__tests__/chatWire.test.ts`.

**Frame budget.** Base64 of the ciphertext adds a third to the (already base64)
previews, so the per-message preview budget went from 36 K to 27 K chars
(`MESSAGE_PREVIEW_BUDGET_CHARS`) and the per-image target from 24 KB to 18 KB
(`PREVIEW_TARGET_BYTES`). A test keeps a full-budget message with 20 envelopes under
60 000 bytes.

**Not covered yet.** History sync (`sync_push`) sends stored rows, including
`raw_attachments` and `content`, as plaintext over the (DTLS-encrypted) data channel,
and it does not check that the peer is a member of the channel's server. Edit
`newContent` in mutations is also plaintext. Both are follow-up work.

---

## 5. Mutation Signing

**Every** mutation is signed by its author's Ed25519 identity key when it is created (`signMutation` in `src/services/mutationAuth.ts`). Unsigned mutations are rejected; there is no compatibility path.

**Signed payload** — `cryptoService.signJson()` over this object (canonical JSON: all keys deep-sorted, so key order after a serde round trip does not matter):

```typescript
{
  v: 1,                          // payload version
  id, type, targetId, channelId, authorId,
  newContent: m.newContent ?? null,   // absent → null, never undefined
  emojiId:    m.emojiId ?? null,
  logicalTs, createdAt,
}
```

`verified` and `sig` are not signed. Only the base64 signature (`__sig`) is kept: on the wire as `mutation.sig` and in the DB as `mutations.sig` (migration 014), so a synced mutation can be re-served and re-verified by third parties. The public key is never taken from the sender: the verifier sets `__pub` to a key it already knows for `authorId` (own identity key, or `members.public_sign_key` in any server).

**Receive checks** (`authorizeMutation`, used by the live `mutation` message and by history sync). `verified: true` is set only after all pass:

| Check | Rule |
|---|---|
| Signature | Valid under a known key of `authorId`. No known key → drop. |
| Live sender | The peer that sent a live `mutation` message must be `authorId`. (Sync relays third-party history, so it has no sender check.) |
| Channel/server | Live path: a real `channelId` must be a channel of the wire's `serverId` in our DB. |
| `edit` | Target message must be in our DB, in the same channel, and authored by `authorId`. |
| `delete` | As `edit`, but an admin/owner of the message's server may delete others' messages. |
| `reaction_add` / `reaction_remove` | Target message in our DB and same channel; the reacting user is `authorId` (the signer). |
| `member_join` | Self-join only (`authorId === targetId === payload.userId`). Verified with the key it introduces, which must match any key already known for that user (no key replacement). Roles other than `member` only for the server owner. |
| `member_profile_update` | `targetId === authorId`. |
| Server / role / channel / moderation / emoji / voice / governance | Signature only. Per-author permission checks (spec 11) are not implemented yet — see `docs/TODO.md`. |

An edit/delete/reaction whose target message is unknown is **dropped, not held**. It is not stored, so negentropy offers it again on the next sync session, after the message has arrived.

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
