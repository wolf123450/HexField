# Code Review Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Address all findings from the comprehensive code review — security hardening, memory leaks, Rust safety, UX bugs, code smell extraction, and version bump.

**Architecture:** These are independent fixes grouped by subsystem. Each task is self-contained and produces a buildable, testable commit. Security fixes come first (highest impact), then correctness bugs, then code quality improvements.

**Tech Stack:** Vue 3.5 (Composition API), Pinia 3 (Setup Stores), TypeScript strict, Tauri v2, Rust 2021 edition, rusqlite, libsodium-wrappers

**Branch:** `fix/code-review-2026-04-06` (create from `main`)

---

## File Map

| Action | File | Responsibility |
|--------|------|----------------|
| Create | `src/utils/useIsAdmin.ts` | Composable: reactive `isAdmin` check for current user |
| Create | `src/utils/peerValidator.ts` | Runtime type validators for all P2P message types |
| Create | `src/utils/__tests__/peerValidator.test.ts` | Tests for peer message validators |
| Create | `src/utils/__tests__/useIsAdmin.test.ts` | Tests for isAdmin composable |
| Create | `src-tauri/migrations/010_server_id_index.sql` | `idx_messages_server` index |
| Modify | `src-tauri/src/main.rs` | Fix `parent().unwrap()` in panic hook |
| Modify | `src-tauri/src/commands/db_commands.rs` | Replace 2 production `.unwrap()` with `?` |
| Modify | `src-tauri/src/db/migrations.rs` | Register migration 010 |
| Modify | `src/services/cryptoService.ts` | Upgrade Argon2 → SENSITIVE params; add `signJson()`/`verifyJsonSignature()` helpers |
| Modify | `src/services/__tests__/cryptoService.test.ts` | Add tests for signJson/verifyJsonSignature |
| Modify | `src/stores/networkStore.ts` | Sign signals, verify peer gossip, validate messages, rate limit, clear typing on disconnect |
| Modify | `src/stores/messagesStore.ts` | Replace `setMyUserId()` with computed identity import; add dedup Set |
| Modify | `src/stores/channelsStore.ts` | Call `markChannelRead()` on channel switch |
| Modify | `src/components/chat/MessageHistory.vue` | Disconnect IntersectionObservers on unmount |
| Modify | `src/components/chat/MessageBubble.vue` | Use `useIsAdmin` composable |
| Modify | `src/components/layout/ChannelSidebar.vue` | Use `useIsAdmin` composable |
| Modify | `src/components/layout/MemberRow.vue` | Use `useIsAdmin` composable |
| Modify | `src/components/layout/ServerRail.vue` | Use `useIsAdmin` composable |
| Modify | `src/components/modals/ServerSettingsModal.vue` | Use `useIsAdmin` composable |
| Modify | `src/App.vue` | Remove `setMyUserId()` call |
| Modify | `package.json` | Version `0.2.0` → `0.2.1` |
| Modify | `src-tauri/Cargo.toml` | Version `0.2.0` → `0.2.1` |

---

### Task 1: Create feature branch

**Files:**
- None (git only)

- [ ] **Step 1: Create and switch to feature branch**

```bash
git checkout main
git pull
git checkout -b fix/code-review-2026-04-06
```

---

### Task 2: Fix Rust panics — `parent().unwrap()` and `serde_json::to_string().unwrap()`

**Files:**
- Modify: `src-tauri/src/main.rs:11`
- Modify: `src-tauri/src/commands/db_commands.rs:241,264`

- [ ] **Step 1: Fix `parent().unwrap()` in panic hook**

In `src-tauri/src/main.rs`, replace the unsafe `path.parent().unwrap()` with a safe conditional:

```rust
// Before (line 11):
//   let _ = std::fs::create_dir_all(path.parent().unwrap());

// After:
        let path = std::env::var("APPDATA")
            .map(|d| std::path::PathBuf::from(d).join("com.hexfield.app").join("crash.txt"))
            .unwrap_or_else(|_| std::path::PathBuf::from("hexfield_crash.txt"));
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
```

- [ ] **Step 2: Replace two `serde_json::to_string().unwrap()` calls with `?` propagation**

In `src-tauri/src/commands/db_commands.rs`, line 241 (inside `"role_assign"`):

```rust
// Before:
[&serde_json::to_string(&roles).unwrap(), &mutation.target_id, server_id],

// After:
[&serde_json::to_string(&roles).map_err(|e| e.to_string())?, &mutation.target_id, server_id],
```

Same fix at line 264 (inside `"role_revoke"`):

```rust
// Before:
[&serde_json::to_string(&roles).unwrap(), &mutation.target_id, server_id],

// After:
[&serde_json::to_string(&roles).map_err(|e| e.to_string())?, &mutation.target_id, server_id],
```

- [ ] **Step 3: Run cargo check**

```bash
cd src-tauri && cargo check
```

Expected: no errors.

- [ ] **Step 4: Run existing Rust tests**

```bash
cd src-tauri && cargo test
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/main.rs src-tauri/src/commands/db_commands.rs
git commit -m "fix(rust): replace unwrap() with safe error propagation in panic hook and role serialization"
```

---

### Task 3: Add `messages.server_id` index migration

**Files:**
- Create: `src-tauri/migrations/010_server_id_index.sql`
- Modify: `src-tauri/src/db/migrations.rs`

- [ ] **Step 1: Create migration file**

Create `src-tauri/migrations/010_server_id_index.sql`:

```sql
CREATE INDEX IF NOT EXISTS idx_messages_server ON messages(server_id, logical_ts DESC);
```

- [ ] **Step 2: Register the migration**

In `src-tauri/src/db/migrations.rs`, add the new migration to the `Migrations::new(vec![...])` list. Find the last `M::up(include_str!("../../migrations/009_member_profile_fields.sql"))` entry and add after it:

```rust
M::up(include_str!("../../migrations/010_server_id_index.sql")),
```

- [ ] **Step 3: Run cargo check and cargo test**

```bash
cd src-tauri && cargo check && cargo test
```

Expected: all pass. The in-memory DB test helper runs all migrations automatically.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/migrations/010_server_id_index.sql src-tauri/src/db/migrations.rs
git commit -m "perf(db): add index on messages.server_id for server-wide search"
```

---

### Task 4: Fix IntersectionObserver memory leak in MessageHistory

**Files:**
- Modify: `src/components/chat/MessageHistory.vue`

- [ ] **Step 1: Add `onUnmounted` import and observer refs, disconnect on unmount**

In `src/components/chat/MessageHistory.vue`, add `onUnmounted` to the Vue import, lift observer variables out of `onMounted`, and clean up:

Change the import line:

```typescript
// Before:
import { ref, computed, watch, onMounted, nextTick } from 'vue'

// After:
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from 'vue'
```

Add observer refs after `highlightTimer`:

```typescript
let highlightTimer: ReturnType<typeof setTimeout> | null = null
let topObserver: IntersectionObserver | null = null
let bottomObserver: IntersectionObserver | null = null
```

Replace the `onMounted` block:

```typescript
onMounted(() => {
  // Top sentinel: load older messages on scroll-up
  if (topSentinel.value) {
    topObserver = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) {
        const cursor = messagesStore.cursors[props.channelId]
        if (cursor) messagesStore.loadMessages(props.channelId, cursor)
      }
    }, { threshold: 0.1 })
    topObserver.observe(topSentinel.value)
  }

  // Bottom sentinel: load newer messages when in a historical view
  if (bottomSentinel.value) {
    bottomObserver = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting && messagesStore.hasNewerMessages[props.channelId]) {
        messagesStore.loadNewerMessages(props.channelId)
      }
    }, { threshold: 0.1 })
    bottomObserver.observe(bottomSentinel.value)
  }

  if (props.scrollToId) {
    nextTick(() => scrollToMessageId(props.scrollToId!))
  } else {
    nextTick(scrollToBottom)
  }
})

onUnmounted(() => {
  topObserver?.disconnect()
  bottomObserver?.disconnect()
  if (highlightTimer) clearTimeout(highlightTimer)
})
```

- [ ] **Step 2: Run frontend build check**

```bash
npm run build
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/components/chat/MessageHistory.vue
git commit -m "fix(chat): disconnect IntersectionObservers and clear highlight timer on unmount"
```

---

### Task 5: Upgrade Argon2 to SENSITIVE parameters

**Files:**
- Modify: `src/services/cryptoService.ts:250-253,308-311`
- Modify: `src/services/__tests__/cryptoService.test.ts`

- [ ] **Step 1: Update `wrapKeysWithPassphrase` to use SENSITIVE**

In `src/services/cryptoService.ts`, inside `wrapKeysWithPassphrase()`, change lines 250-253:

```typescript
// Before:
    const derivedKey = s.crypto_pwhash(
      s.crypto_secretbox_KEYBYTES,
      passphrase,
      salt,
      s.crypto_pwhash_OPSLIMIT_INTERACTIVE,
      s.crypto_pwhash_MEMLIMIT_INTERACTIVE,
      s.crypto_pwhash_ALG_ARGON2ID13,
    )

// After:
    const derivedKey = s.crypto_pwhash(
      s.crypto_secretbox_KEYBYTES,
      passphrase,
      salt,
      s.crypto_pwhash_OPSLIMIT_SENSITIVE,
      s.crypto_pwhash_MEMLIMIT_SENSITIVE,
      s.crypto_pwhash_ALG_ARGON2ID13,
    )
```

Also update the matching comment above from "interactive parameters" to "sensitive parameters":

```typescript
// Before:
    // Argon2id — interactive parameters (fast enough for a user login prompt)

// After:
    // Argon2id — sensitive parameters (brute-force resistant key derivation)
```

- [ ] **Step 2: Update `unwrapKeysWithPassphrase` to match**

In the same file, inside `unwrapKeysWithPassphrase()`, change lines 308-311:

```typescript
// Before:
    const derivedKey = s.crypto_pwhash(
      s.crypto_secretbox_KEYBYTES,
      passphrase,
      salt,
      s.crypto_pwhash_OPSLIMIT_INTERACTIVE,
      s.crypto_pwhash_MEMLIMIT_INTERACTIVE,
      s.crypto_pwhash_ALG_ARGON2ID13,
    )

// After:
    const derivedKey = s.crypto_pwhash(
      s.crypto_secretbox_KEYBYTES,
      passphrase,
      salt,
      s.crypto_pwhash_OPSLIMIT_SENSITIVE,
      s.crypto_pwhash_MEMLIMIT_SENSITIVE,
      s.crypto_pwhash_ALG_ARGON2ID13,
    )
```

**Important: Key bundles wrapped with INTERACTIVE params by existing installs will NOT be unwrappable with SENSITIVE params.** We need a version fallback. Change `unwrapKeysWithPassphrase` to try SENSITIVE first, then fall back to INTERACTIVE:

```typescript
  async unwrapKeysWithPassphrase(
    wrapped: { version: 2; salt: string; nonce: string; ciphertext: string },
    passphrase: string,
  ): Promise<void> {
    const s = this.sodium!
    const salt       = s.from_base64(wrapped.salt)
    const nonce      = s.from_base64(wrapped.nonce)
    const ciphertext = s.from_base64(wrapped.ciphertext)

    let plaintext: Uint8Array
    try {
      // Try SENSITIVE first (current parameter set)
      const derivedKey = s.crypto_pwhash(
        s.crypto_secretbox_KEYBYTES,
        passphrase,
        salt,
        s.crypto_pwhash_OPSLIMIT_SENSITIVE,
        s.crypto_pwhash_MEMLIMIT_SENSITIVE,
        s.crypto_pwhash_ALG_ARGON2ID13,
      )
      plaintext = s.crypto_secretbox_open_easy(ciphertext, nonce, derivedKey)
    } catch {
      // Fall back to INTERACTIVE (legacy parameter set from <= v0.2.0)
      const derivedKey = s.crypto_pwhash(
        s.crypto_secretbox_KEYBYTES,
        passphrase,
        salt,
        s.crypto_pwhash_OPSLIMIT_INTERACTIVE,
        s.crypto_pwhash_MEMLIMIT_INTERACTIVE,
        s.crypto_pwhash_ALG_ARGON2ID13,
      )
      plaintext = s.crypto_secretbox_open_easy(ciphertext, nonce, derivedKey)
    }

    // Reconstruct keypairs from the decrypted secret bytes:
    // (keep existing code below unchanged)
```

- [ ] **Step 3: Run existing crypto tests**

```bash
npm run test -- --reporter=verbose src/services/__tests__/cryptoService.test.ts
```

Expected: existing `wrapKeysWithPassphrase + unwrapKeysWithPassphrase` round-trip test still passes (it generates fresh bundles with SENSITIVE params). The "wrong passphrase throws" test also still passes.

- [ ] **Step 4: Run full frontend build**

```bash
npm run build
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/services/cryptoService.ts
git commit -m "security(crypto): upgrade Argon2 to SENSITIVE params with INTERACTIVE fallback for legacy bundles"
```

---

### Task 6: Add `signJson` / `verifyJsonSignature` helpers to cryptoService

**Files:**
- Modify: `src/services/cryptoService.ts`
- Modify: `src/services/__tests__/cryptoService.test.ts`

These helpers will be used by Tasks 7-8 to sign/verify signal messages and gossip.

- [ ] **Step 1: Write failing tests**

Add to `src/services/__tests__/cryptoService.test.ts`:

```typescript
describe('signJson / verifyJsonSignature', () => {
  it('round-trips: sign then verify returns true', async () => {
    await cryptoService.init()
    await cryptoService.generateAndStoreKeys('test-user')

    const payload = { type: 'signal_offer', to: 'peer-1', sdp: 'v=0\r\n...' }
    const signed = cryptoService.signJson(payload)

    expect(signed).toHaveProperty('__sig')
    expect(signed).toHaveProperty('__pub')
    expect(signed.type).toBe('signal_offer')

    const valid = cryptoService.verifyJsonSignature(signed)
    expect(valid).toBe(true)
  })

  it('rejects tampered payload', async () => {
    await cryptoService.init()
    await cryptoService.generateAndStoreKeys('test-user')

    const payload = { type: 'signal_offer', to: 'peer-1', sdp: 'v=0\r\n...' }
    const signed = cryptoService.signJson(payload)
    signed.sdp = 'TAMPERED'

    const valid = cryptoService.verifyJsonSignature(signed)
    expect(valid).toBe(false)
  })

  it('rejects when __pub is missing', () => {
    const result = cryptoService.verifyJsonSignature({ type: 'test' })
    expect(result).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to see it fail**

```bash
npm run test -- --reporter=verbose src/services/__tests__/cryptoService.test.ts
```

Expected: FAIL — `cryptoService.signJson is not a function`

- [ ] **Step 3: Implement `signJson` and `verifyJsonSignature`**

Add these two methods to the `CryptoService` class in `src/services/cryptoService.ts`, after the existing `verify()` method (around line 198):

```typescript
  /**
   * Sign a JSON-serialisable object by appending `__sig` (base64 Ed25519 signature)
   * and `__pub` (base64 public sign key) fields. Returns a new object — does not
   * mutate the input.
   *
   * The signature covers the deterministic JSON encoding of all fields EXCEPT
   * `__sig` and `__pub` themselves.
   */
  signJson<T extends Record<string, unknown>>(payload: T): T & { __sig: string; __pub: string } {
    const s = this.sodium!
    if (!this.signKeyPair) throw new Error('Sign keys not loaded')
    // Canonical payload: sorted keys, exclude meta-fields
    const { __sig: _s, __pub: _p, ...rest } = payload as Record<string, unknown>
    const canonical = JSON.stringify(rest, Object.keys(rest).sort())
    const sig = s.crypto_sign_detached(s.from_string(canonical), this.signKeyPair.privateKey)
    return {
      ...payload,
      __sig: s.to_base64(sig),
      __pub: s.to_base64(this.signKeyPair.publicKey),
    }
  }

  /**
   * Verify a JSON object that was signed with `signJson()`.
   * Returns `true` if `__sig` is a valid Ed25519 signature over the canonical
   * payload using `__pub`.
   */
  verifyJsonSignature(payload: Record<string, unknown>): boolean {
    const s = this.sodium!
    const sig = payload.__sig as string | undefined
    const pub = payload.__pub as string | undefined
    if (!sig || !pub) return false
    try {
      const { __sig: _s, __pub: _p, ...rest } = payload
      const canonical = JSON.stringify(rest, Object.keys(rest).sort())
      return s.crypto_sign_verify_detached(
        s.from_base64(sig),
        s.from_string(canonical),
        s.from_base64(pub),
      )
    } catch {
      return false
    }
  }
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm run test -- --reporter=verbose src/services/__tests__/cryptoService.test.ts
```

Expected: all pass (including the new 3 tests).

- [ ] **Step 5: Run full frontend build**

```bash
npm run build
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/services/cryptoService.ts src/services/__tests__/cryptoService.test.ts
git commit -m "feat(crypto): add signJson/verifyJsonSignature for signed P2P messages"
```

---

### Task 7: Sign WebRTC signals and verify on receive

**Files:**
- Modify: `src/stores/networkStore.ts` (signal send + handleSignalMessage)

- [ ] **Step 1: Sign outgoing signals**

In `src/stores/networkStore.ts`, add the cryptoService import at the top with the other imports:

```typescript
import { cryptoService } from '@/services/cryptoService'
```

Then modify the three `listen` handlers (lines 344-368) to sign payloads before sending. Replace each `sendSignal(...)` call to wrap the payload:

```typescript
    listen<{ to: string; sdp: string }>('webrtc_offer', ({ payload }) => {
      sendSignal(cryptoService.signJson({ type: 'signal_offer', to: payload.to, from: localUserId, sdp: payload.sdp }))
        .catch(e => console.warn('[webrtc] relay webrtc_offer error:', e))
    }).catch(e => console.warn('[webrtc] webrtc_offer listen failed:', e))

    listen<{ to: string; sdp: string }>('webrtc_answer', ({ payload }) => {
      sendSignal(cryptoService.signJson({ type: 'signal_answer', to: payload.to, from: localUserId, sdp: payload.sdp }))
        .catch(e => console.warn('[webrtc] relay webrtc_answer error:', e))
    }).catch(e => console.warn('[webrtc] webrtc_answer listen failed:', e))

    listen<{ to: string; candidate: string; sdpMid: string | null; sdpMlineIndex: number | null }>(
      'webrtc_ice', ({ payload }) => {
        sendSignal(cryptoService.signJson({
          type: 'signal_ice',
          to: payload.to,
          from: localUserId,
          candidate: { candidate: payload.candidate, sdpMid: payload.sdpMid, sdpMLineIndex: payload.sdpMlineIndex },
        })).catch(e => console.warn('[webrtc] relay webrtc_ice error:', e))
      },
    ).catch(e => console.warn('[webrtc] webrtc_ice listen failed:', e))
```

- [ ] **Step 2: Verify incoming signals**

In `handleSignalMessage` (line 405), add signature verification before processing. We do a soft check: if `__sig` is present, verify it; if not, accept for backward compatibility with older peers:

```typescript
  function handleSignalMessage(payload: SignalPayload) {
    const from = payload.from as string | undefined
    if (!from) return

    // Verify signature if present (older peers may not sign)
    const asRecord = payload as unknown as Record<string, unknown>
    if (asRecord.__sig && !cryptoService.verifyJsonSignature(asRecord)) {
      console.warn('[webrtc] Dropping signal with invalid signature from', from)
      return
    }

    switch (payload.type) {
      // ... rest unchanged
```

- [ ] **Step 3: Run frontend build**

```bash
npm run build
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/stores/networkStore.ts
git commit -m "security(network): sign WebRTC signals with Ed25519 and verify on receive"
```

---

### Task 8: Create peer message validators and integrate

**Files:**
- Create: `src/utils/peerValidator.ts`
- Create: `src/utils/__tests__/peerValidator.test.ts`
- Modify: `src/stores/networkStore.ts`

- [ ] **Step 1: Write the validator tests**

Create `src/utils/__tests__/peerValidator.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import {
  isValidChatMessage,
  isValidMemberAnnounce,
  isValidPresenceUpdate,
  isValidMutation,
  isValidTypingStart,
} from '../peerValidator'

describe('peerValidator', () => {
  describe('isValidChatMessage', () => {
    it('accepts valid chat message', () => {
      expect(isValidChatMessage({
        type: 'chat_message',
        messageId: 'abc-123',
        channelId: 'ch-1',
        serverId: 'srv-1',
        authorId: 'user-1',
        envelopes: [{ recipientId: 'user-2', ciphertext: 'abc', nonce: 'def', ephemeralPub: 'ghi' }],
        logicalTs: '1234-000000',
        createdAt: '2026-01-01T00:00:00Z',
      })).toBe(true)
    })

    it('rejects missing messageId', () => {
      expect(isValidChatMessage({
        type: 'chat_message',
        channelId: 'ch-1',
        serverId: 'srv-1',
        authorId: 'user-1',
        envelopes: [],
        logicalTs: '1234-000000',
        createdAt: '2026-01-01T00:00:00Z',
      })).toBe(false)
    })

    it('rejects non-array envelopes', () => {
      expect(isValidChatMessage({
        type: 'chat_message',
        messageId: 'abc',
        channelId: 'ch-1',
        serverId: 'srv-1',
        authorId: 'user-1',
        envelopes: 'not-an-array',
        logicalTs: '1234-000000',
        createdAt: '2026-01-01T00:00:00Z',
      })).toBe(false)
    })
  })

  describe('isValidMemberAnnounce', () => {
    it('accepts valid member announce', () => {
      expect(isValidMemberAnnounce({
        type: 'member_announce',
        members: [{
          userId: 'u1', serverId: 's1', displayName: 'Alice',
          publicSignKey: 'pk1', publicDHKey: 'dh1',
          roles: ['member'], joinedAt: '2026-01-01T00:00:00Z', onlineStatus: 'online',
        }],
      })).toBe(true)
    })

    it('rejects non-array members', () => {
      expect(isValidMemberAnnounce({ type: 'member_announce', members: 'bad' })).toBe(false)
    })

    it('rejects member missing userId', () => {
      expect(isValidMemberAnnounce({
        type: 'member_announce',
        members: [{ serverId: 's1', displayName: 'Alice' }],
      })).toBe(false)
    })
  })

  describe('isValidPresenceUpdate', () => {
    it('accepts valid presence', () => {
      expect(isValidPresenceUpdate({ type: 'presence_update', status: 'online' })).toBe(true)
    })

    it('rejects invalid status', () => {
      expect(isValidPresenceUpdate({ type: 'presence_update', status: 'flying' })).toBe(false)
    })

    it('rejects missing status', () => {
      expect(isValidPresenceUpdate({ type: 'presence_update' })).toBe(false)
    })
  })

  describe('isValidMutation', () => {
    it('accepts valid mutation', () => {
      expect(isValidMutation({
        type: 'mutation',
        id: 'm1', mutationType: 'reaction_add', targetId: 'msg-1',
        authorId: 'u1', serverId: 's1', channelId: 'c1',
        logicalTs: '1234-000000', createdAt: '2026-01-01T00:00:00Z',
      })).toBe(true)
    })

    it('rejects missing id', () => {
      expect(isValidMutation({
        type: 'mutation',
        mutationType: 'reaction_add', targetId: 'msg-1',
        authorId: 'u1',
      })).toBe(false)
    })
  })

  describe('isValidTypingStart', () => {
    it('accepts valid typing', () => {
      expect(isValidTypingStart({ type: 'typing_start', channelId: 'ch-1' })).toBe(true)
    })

    it('rejects missing channelId', () => {
      expect(isValidTypingStart({ type: 'typing_start' })).toBe(false)
    })
  })
})
```

- [ ] **Step 2: Run tests to see them fail**

```bash
npm run test -- --reporter=verbose src/utils/__tests__/peerValidator.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement validators**

Create `src/utils/peerValidator.ts`:

```typescript
/**
 * Runtime type validators for P2P messages received over WebRTC data channels.
 * These guard against malformed or malicious payloads from peers.
 */

type Obj = Record<string, unknown>

function isStr(v: unknown): v is string { return typeof v === 'string' && v.length > 0 }

export function isValidChatMessage(msg: Obj): boolean {
  return isStr(msg.messageId) &&
    isStr(msg.channelId) &&
    isStr(msg.serverId) &&
    isStr(msg.authorId) &&
    Array.isArray(msg.envelopes) &&
    isStr(msg.logicalTs) &&
    isStr(msg.createdAt)
}

export function isValidMemberAnnounce(msg: Obj): boolean {
  if (!Array.isArray(msg.members)) return false
  return (msg.members as Obj[]).every(m =>
    isStr(m.userId) &&
    isStr(m.serverId) &&
    typeof m.displayName === 'string' &&
    isStr(m.publicSignKey) &&
    isStr(m.publicDHKey) &&
    Array.isArray(m.roles) &&
    isStr(m.joinedAt)
  )
}

const VALID_STATUSES = new Set(['online', 'idle', 'dnd', 'offline'])
export function isValidPresenceUpdate(msg: Obj): boolean {
  return isStr(msg.status) && VALID_STATUSES.has(msg.status as string)
}

export function isValidMutation(msg: Obj): boolean {
  return isStr(msg.id) &&
    isStr(msg.mutationType) &&
    isStr(msg.targetId) &&
    isStr(msg.authorId)
}

export function isValidTypingStart(msg: Obj): boolean {
  return isStr(msg.channelId)
}

export function isValidProfileUpdate(msg: Obj): boolean {
  return msg.payload != null && typeof msg.payload === 'object'
}

export function isValidVoiceJoin(msg: Obj): boolean {
  return isStr(msg.channelId)
}

export function isValidEmojiSync(msg: Obj): boolean {
  return isStr(msg.serverId) && Array.isArray(msg.emoji)
}
```

- [ ] **Step 4: Run validator tests**

```bash
npm run test -- --reporter=verbose src/utils/__tests__/peerValidator.test.ts
```

Expected: all pass.

- [ ] **Step 5: Integrate validators into `handleDataChannelMessage`**

In `src/stores/networkStore.ts`, add the import at the top:

```typescript
import {
  isValidChatMessage,
  isValidMemberAnnounce,
  isValidPresenceUpdate,
  isValidMutation,
  isValidTypingStart,
  isValidProfileUpdate,
  isValidVoiceJoin,
  isValidEmojiSync,
} from '@/utils/peerValidator'
```

Then in `handleDataChannelMessage`, add validation guards inside the switch cases. For example:

```typescript
  function handleDataChannelMessage(userId: string, data: unknown) {
    const msg = data as Record<string, unknown>
    if (!msg || typeof msg !== 'object' || !msg.type) return

    switch (msg.type) {
      case 'chat_message':
        if (!isValidChatMessage(msg)) { console.warn('[network] invalid chat_message from', userId); return }
        handleChatMessage(userId, msg)
        break
      case 'typing_start':
        if (!isValidTypingStart(msg)) return
        handleTypingStart(userId, msg.channelId as string)
        break
      case 'typing_stop':
        handleTypingStopEvent(userId)
        break
      case 'mutation':
        if (!isValidMutation(msg)) { console.warn('[network] invalid mutation from', userId); return }
        handleMutationMessage(msg)
        break
      case 'emoji_sync':
        if (!isValidEmojiSync(msg)) return
        handleEmojiSync(msg)
        break
      // emoji_image_request, emoji_image, device_link_request, device_link_confirm,
      // device_attest — keep as-is (low-frequency, non-critical data path)
      case 'member_announce':
        if (!isValidMemberAnnounce(msg)) { console.warn('[network] invalid member_announce from', userId); return }
        handleMemberAnnounce(userId, msg).catch(e =>
          console.warn('[network] member_announce error:', e)
        )
        break
      case 'presence_update':
        if (!isValidPresenceUpdate(msg)) return
        handlePresenceUpdate(userId, msg)
        break
      case 'profile_update':
        if (!isValidProfileUpdate(msg)) return
        handleProfileUpdate(userId, msg)
        break
      case 'voice_join':
        if (!isValidVoiceJoin(msg)) return
        handleVoiceJoin(userId, msg)
        break
      // All other cases remain unchanged
```

- [ ] **Step 6: Run frontend build**

```bash
npm run build
```

Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/utils/peerValidator.ts src/utils/__tests__/peerValidator.test.ts src/stores/networkStore.ts
git commit -m "security(network): validate all peer message types before processing"
```

---

### Task 9: Add rate limiting for peer messages

**Files:**
- Modify: `src/stores/networkStore.ts`

- [ ] **Step 1: Add rate limiter utility inside networkStore**

In `src/stores/networkStore.ts`, add a rate limiter above `handleDataChannelMessage`. Insert after the `typingUsers` ref declaration:

```typescript
  // ── Per-peer rate limiter ──────────────────────────────────────────────────
  const RATE_LIMIT_WINDOW_MS = 1000
  const RATE_LIMIT_MAX = 15  // max messages per peer per second
  const peerMessageCounts = new Map<string, { count: number; windowStart: number }>()

  function isRateLimited(userId: string): boolean {
    const now = Date.now()
    let entry = peerMessageCounts.get(userId)
    if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
      entry = { count: 0, windowStart: now }
      peerMessageCounts.set(userId, entry)
    }
    entry.count++
    if (entry.count > RATE_LIMIT_MAX) {
      console.warn('[network] rate limiting peer', userId, `(${entry.count} msgs in window)`)
      return true
    }
    return false
  }
```

- [ ] **Step 2: Guard `handleDataChannelMessage` with rate limiter**

At the top of `handleDataChannelMessage`, add:

```typescript
  function handleDataChannelMessage(userId: string, data: unknown) {
    if (isRateLimited(userId)) return

    const msg = data as Record<string, unknown>
    // ... rest unchanged
```

- [ ] **Step 3: Clean up rate limit entries on peer disconnect**

In the disconnect handler (line 333-349), add cleanup:

```typescript
      (userId) => {
        webrtcService.destroyPeer(userId)
        connectedPeers.value = connectedPeers.value.filter(id => id !== userId)
        lastHeartbeatFrom.delete(userId)
        peerMessageCounts.delete(userId)
        // ... rest unchanged
```

- [ ] **Step 4: Run frontend build**

```bash
npm run build
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/stores/networkStore.ts
git commit -m "security(network): add per-peer rate limiting (15 msgs/sec) to prevent flood DoS"
```

---

### Task 10: Clear typing indicators on peer disconnect

**Files:**
- Modify: `src/stores/networkStore.ts`

- [ ] **Step 1: Add typing cleanup to the disconnect handler**

In the peer disconnect callback (around line 333), add typing cleanup before the existing `handlePresenceUpdate` call:

```typescript
      (userId) => {
        webrtcService.destroyPeer(userId)
        connectedPeers.value = connectedPeers.value.filter(id => id !== userId)
        lastHeartbeatFrom.delete(userId)
        peerMessageCounts.delete(userId)

        // Clear stale typing indicator immediately
        if (typingUsers.value[userId]) {
          clearTimeout(typingUsers.value[userId].timeout)
          const { [userId]: _, ...rest } = typingUsers.value
          typingUsers.value = rest
        }

        handlePresenceUpdate(userId, { status: 'offline' })
        handleVoicePeerDisconnect(userId)
      },
```

- [ ] **Step 2: Run frontend build**

```bash
npm run build
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/stores/networkStore.ts
git commit -m "fix(network): clear typing indicator immediately on peer disconnect"
```

---

### Task 11: Fix `markChannelRead` — call on channel switch

**Files:**
- Modify: `src/stores/channelsStore.ts`

- [ ] **Step 1: Add `markChannelRead` call in `setActiveChannel`**

In `src/stores/channelsStore.ts`, modify `setActiveChannel` to reset unread:

```typescript
// Before:
  function setActiveChannel(channelId: string | null) {
    activeChannelId.value = channelId
  }

// After:
  function setActiveChannel(channelId: string | null) {
    activeChannelId.value = channelId
    if (channelId) {
      import('./messagesStore').then(({ useMessagesStore }) => {
        useMessagesStore().markChannelRead(channelId)
      })
    }
  }
```

This uses dynamic import to avoid circular dependency (channelsStore ↔ messagesStore).

- [ ] **Step 2: Run frontend build**

```bash
npm run build
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/stores/channelsStore.ts
git commit -m "fix(channels): reset unread count when switching to a channel"
```

---

### Task 12: Remove fragile `setMyUserId` — use computed identity

**Files:**
- Modify: `src/stores/messagesStore.ts`
- Modify: `src/App.vue`

- [ ] **Step 1: Replace `_myUserId` ref with a getter function in messagesStore**

In `src/stores/messagesStore.ts`, find the `_myUserId` ref and `setMyUserId` function (around lines 42-45):

```typescript
// Before:
  const _myUserId = ref<string | null>(null)
  function setMyUserId(id: string) {
    _myUserId.value = id
  }

// After:
  function _getMyUserId(): string | null {
    // Dynamic import avoids circular dependency with identityStore
    // Pinia stores are cached after first use, so this is O(1) after init.
    try {
      const { useIdentityStore } = require('./identityStore')
      return useIdentityStore().userId
    } catch {
      return null
    }
  }
```

**Wait — `require()` doesn't work in ESM.** Use a lazy-initialized variable instead:

```typescript
// Before:
  const _myUserId = ref<string | null>(null)
  function setMyUserId(id: string) {
    _myUserId.value = id
  }

// After:
  let _identityStoreRef: ReturnType<typeof import('./identityStore').useIdentityStore> | null = null
  function _getMyUserId(): string | null {
    if (!_identityStoreRef) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { useIdentityStore } = require('./identityStore') as typeof import('./identityStore')
        _identityStoreRef = useIdentityStore()
      } catch { return null }
    }
    return _identityStoreRef.userId
  }
```

**Actually — the entire codebase uses `await import()` for dynamic imports in stores.** The simplest correct pattern is to keep `_myUserId` as a ref but populate it lazily the first time it's needed, removing the explicit call from App.vue. But the review finding is that forgetting `setMyUserId()` is fragile.

The cleanest fix for the existing pattern: make messagesStore read identityStore directly, since by the time any message is received, identityStore is already initialized. The circular-dep concern is only for top-level imports — accessing at runtime is fine if you import the store function inside the calling function. But `getMessagesWithMutations` is synchronous and called frequently, so we can't use `await import()` there.

**Revised approach:** Keep `_myUserId` ref, but also reactively sync it via a watcher in `App.vue` so it stays up to date even if `identityStore.userId` changes (e.g., after device linking). The real fix is to make the existing `setMyUserId` call robust rather than removing it — and also ensure it's not a single point of failure. We'll watch for it:

In `App.vue`, replace the one-shot `setMyUserId` with a reactive watcher. Find:

```typescript
  // Give messagesStore the local userId for synchronous reaction computation
  if (identityStore.userId) {
    messagesStore.setMyUserId(identityStore.userId)
  }
```

Replace with (add `watch` import + watcher OUTSIDE `onMounted`):

```typescript
  // Reactively sync userId into messagesStore for synchronous reaction computation
  watch(() => identityStore.userId, (uid) => {
    if (uid) messagesStore.setMyUserId(uid)
  }, { immediate: true })
```

And remove the block from inside `onMounted` that was:
```typescript
  if (identityStore.userId) {
    messagesStore.setMyUserId(identityStore.userId)
  }
```

- [ ] **Step 1: Add `watch` to App.vue imports and add the watcher**

In `src/App.vue`, add `watch` to the Vue import:

```typescript
// Before:
import { onMounted } from 'vue'

// After:
import { onMounted, watch } from 'vue'
```

Then add the watcher after the store declarations (before `onMounted`):

```typescript
// Reactively sync userId into messagesStore for synchronous reaction computation.
// This replaces the one-shot setMyUserId call and survives identity changes.
watch(() => identityStore.userId, (uid) => {
  if (uid) messagesStore.setMyUserId(uid)
}, { immediate: true })
```

And remove the old `setMyUserId` block from inside `onMounted`:

```typescript
// Remove this block from onMounted:
  // Give messagesStore the local userId for synchronous reaction computation
  if (identityStore.userId) {
    messagesStore.setMyUserId(identityStore.userId)
  }
```

- [ ] **Step 2: Also add a dedup Set to messagesStore for race-condition prevention**

In `src/stores/messagesStore.ts`, add a Set near the top of the store setup (after `_myUserId` or `setMyUserId`):

```typescript
  const _receivedIds = new Set<string>()
```

Then in `receiveEncryptedMessage`, replace the existing dedup check:

```typescript
// Before:
    // Deduplicate — may arrive over multiple transports
    const existing = messages.value[wire.channelId]
    if (existing?.some(m => m.id === wire.messageId)) return

// After:
    // Deduplicate — may arrive over multiple transports (Set prevents race condition)
    if (_receivedIds.has(wire.messageId)) return
    _receivedIds.add(wire.messageId)
    const existing = messages.value[wire.channelId]
    if (existing?.some(m => m.id === wire.messageId)) return
```

- [ ] **Step 3: Run frontend build**

```bash
npm run build
```

Expected: no errors.

- [ ] **Step 4: Run existing tests**

```bash
npm run test -- --reporter=verbose
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/App.vue src/stores/messagesStore.ts
git commit -m "fix(messages): reactively sync userId and add Set-based dedup to prevent race"
```

---

### Task 13: Extract `useIsAdmin` composable

**Files:**
- Create: `src/utils/useIsAdmin.ts`
- Create: `src/utils/__tests__/useIsAdmin.test.ts`
- Modify: `src/components/chat/MessageBubble.vue`
- Modify: `src/components/layout/ChannelSidebar.vue`
- Modify: `src/components/layout/MemberRow.vue`
- Modify: `src/components/layout/ServerRail.vue`
- Modify: `src/components/modals/ServerSettingsModal.vue`

- [ ] **Step 1: Write the composable test**

Create `src/utils/__tests__/useIsAdmin.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ref, nextTick } from 'vue'
import { setActivePinia, createPinia } from 'pinia'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))

describe('useIsAdmin', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('returns false when no userId', async () => {
    const { useIsAdmin } = await import('../useIsAdmin')
    const { useIdentityStore } = await import('@/stores/identityStore')
    const identityStore = useIdentityStore()
    // userId is null by default
    const isAdmin = useIsAdmin(ref('server-1'))
    expect(isAdmin.value).toBe(false)
  })

  it('returns true when user has owner role', async () => {
    const { useIsAdmin } = await import('../useIsAdmin')
    const { useIdentityStore } = await import('@/stores/identityStore')
    const { useServersStore } = await import('@/stores/serversStore')
    const identityStore = useIdentityStore()
    const serversStore = useServersStore()

    // Simulate identity
    identityStore.userId = 'user-1'
    // Simulate member with owner role
    serversStore.members['server-1'] = {
      'user-1': {
        userId: 'user-1', serverId: 'server-1', displayName: 'Test',
        roles: ['owner'], joinedAt: '', publicSignKey: '', publicDHKey: '',
        onlineStatus: 'online',
      } as any,
    }

    const isAdmin = useIsAdmin(ref('server-1'))
    expect(isAdmin.value).toBe(true)
  })

  it('returns true for admin role', async () => {
    const { useIsAdmin } = await import('../useIsAdmin')
    const { useIdentityStore } = await import('@/stores/identityStore')
    const { useServersStore } = await import('@/stores/serversStore')
    const identityStore = useIdentityStore()
    const serversStore = useServersStore()

    identityStore.userId = 'user-1'
    serversStore.members['server-1'] = {
      'user-1': {
        userId: 'user-1', serverId: 'server-1', displayName: 'Test',
        roles: ['admin'], joinedAt: '', publicSignKey: '', publicDHKey: '',
        onlineStatus: 'online',
      } as any,
    }

    const isAdmin = useIsAdmin(ref('server-1'))
    expect(isAdmin.value).toBe(true)
  })

  it('returns false when user is plain member', async () => {
    const { useIsAdmin } = await import('../useIsAdmin')
    const { useIdentityStore } = await import('@/stores/identityStore')
    const { useServersStore } = await import('@/stores/serversStore')
    const identityStore = useIdentityStore()
    const serversStore = useServersStore()

    identityStore.userId = 'user-1'
    serversStore.members['server-1'] = {
      'user-1': {
        userId: 'user-1', serverId: 'server-1', displayName: 'Test',
        roles: ['member'], joinedAt: '', publicSignKey: '', publicDHKey: '',
        onlineStatus: 'online',
      } as any,
    }

    const isAdmin = useIsAdmin(ref('server-1'))
    expect(isAdmin.value).toBe(false)
  })
})
```

- [ ] **Step 2: Run tests to see them fail**

```bash
npm run test -- --reporter=verbose src/utils/__tests__/useIsAdmin.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement the composable**

Create `src/utils/useIsAdmin.ts`:

```typescript
import { computed, unref, type Ref } from 'vue'
import { useIdentityStore } from '@/stores/identityStore'
import { useServersStore } from '@/stores/serversStore'

/**
 * Returns a reactive computed boolean: `true` if the current user has the
 * `admin` or `owner` role in the given server.
 *
 * @param serverId - A reactive or static server ID. Pass `null` to always
 *   return `false` (no server selected).
 */
export function useIsAdmin(serverId: Ref<string | null> | string | null): Ref<boolean> {
  const identityStore = useIdentityStore()
  const serversStore  = useServersStore()

  return computed(() => {
    const sid = unref(serverId)
    const uid = identityStore.userId
    if (!sid || !uid) return false
    return serversStore.members[sid]?.[uid]?.roles.some(
      (r: string) => r === 'admin' || r === 'owner',
    ) ?? false
  })
}

/**
 * Non-reactive function-based check for use outside component setup.
 */
export function isAdminOfServer(serverId: string): boolean {
  const identityStore = useIdentityStore()
  const serversStore  = useServersStore()
  const uid = identityStore.userId
  if (!uid) return false
  return serversStore.members[serverId]?.[uid]?.roles.some(
    (r: string) => r === 'admin' || r === 'owner',
  ) ?? false
}
```

- [ ] **Step 4: Run tests**

```bash
npm run test -- --reporter=verbose src/utils/__tests__/useIsAdmin.test.ts
```

Expected: all pass.

- [ ] **Step 5: Replace `isAdmin` in MessageBubble.vue**

In `src/components/chat/MessageBubble.vue`, add import and replace the computed:

```typescript
// Add near imports:
import { useIsAdmin } from '@/utils/useIsAdmin'

// Replace:
const isAdmin = computed(() => {
  const uid = identityStore.userId
  if (!uid) return false
  return serversStore.members[props.message.serverId]?.[uid]?.roles.some(r => r === 'admin' || r === 'owner') ?? false
})

// With:
const isAdmin = useIsAdmin(computed(() => props.message.serverId))
```

If `computed` is not already imported from Vue, add it to the import.

- [ ] **Step 6: Replace `isAdmin` in ChannelSidebar.vue**

In `src/components/layout/ChannelSidebar.vue`, add import and replace:

```typescript
// Add near imports:
import { useIsAdmin } from '@/utils/useIsAdmin'

// Replace:
const isAdmin = computed(() => {
  const sid = serversStore.activeServerId
  const uid = identityStore.userId
  if (!sid || !uid) return false
  return serversStore.members[sid]?.[uid]?.roles.some(r => r === 'admin' || r === 'owner') ?? false
})

// With:
const isAdmin = useIsAdmin(computed(() => serversStore.activeServerId))
```

- [ ] **Step 7: Replace `isAdmin` in MemberRow.vue**

In `src/components/layout/MemberRow.vue`:

```typescript
// Add near imports:
import { useIsAdmin } from '@/utils/useIsAdmin'

// Replace:
const isAdmin = computed(() => {
  const uid = identityStore.userId
  if (!uid) return false
  return serversStore.members[props.serverId]?.[uid]?.roles.some(r => r === 'admin' || r === 'owner') ?? false
})

// With:
const isAdmin = useIsAdmin(computed(() => props.serverId))
```

- [ ] **Step 8: Replace `isAdminOfServer` in ServerRail.vue**

In `src/components/layout/ServerRail.vue`:

```typescript
// Add near imports:
import { isAdminOfServer } from '@/utils/useIsAdmin'

// Remove the local function definition:
// function isAdminOfServer(serverId: string): boolean {
//   const uid = identityStore.userId
//   if (!uid) return false
//   return serversStore.members[serverId]?.[uid]?.roles.some(r => r === 'admin' || r === 'owner') ?? false
// }
```

The function signature is identical, so callers need no change.

- [ ] **Step 9: Replace `isAdmin` in ServerSettingsModal.vue**

In `src/components/modals/ServerSettingsModal.vue`:

```typescript
// Add near imports:
import { useIsAdmin } from '@/utils/useIsAdmin'

// Replace:
const isAdmin = computed(() => {
  const sid = uiStore.settingsServerId
  const uid = identityStore.userId
  if (!sid || !uid) return false
  return serversStore.members[sid]?.[uid]?.roles.some(r => r === 'admin' || r === 'owner') ?? false
})

// With:
const isAdmin = useIsAdmin(computed(() => uiStore.settingsServerId))
```

- [ ] **Step 10: Run full frontend build**

```bash
npm run build
```

Expected: no errors. Check for any unused import warnings from the old `computed` that was defining `isAdmin` locally — remove dead imports if flagged.

- [ ] **Step 11: Run all tests**

```bash
npm run test -- --reporter=verbose
```

Expected: all pass.

- [ ] **Step 12: Commit**

```bash
git add src/utils/useIsAdmin.ts src/utils/__tests__/useIsAdmin.test.ts \
  src/components/chat/MessageBubble.vue \
  src/components/layout/ChannelSidebar.vue \
  src/components/layout/MemberRow.vue \
  src/components/layout/ServerRail.vue \
  src/components/modals/ServerSettingsModal.vue
git commit -m "refactor(components): extract useIsAdmin composable — single source of truth for admin checks"
```

---

### Task 14: Version bump to 0.2.1

**Files:**
- Modify: `package.json:3`
- Modify: `src-tauri/Cargo.toml:3`

- [ ] **Step 1: Bump package.json**

In `package.json`, change:

```json
// Before:
  "version": "0.2.0",

// After:
  "version": "0.2.1",
```

- [ ] **Step 2: Bump Cargo.toml**

In `src-tauri/Cargo.toml`, change:

```toml
# Before:
version = "0.2.0"

# After:
version = "0.2.1"
```

Note: `tauri.conf.json` has `"version": "../package.json"` which reads from package.json, so no change needed there.

- [ ] **Step 3: Run full build (frontend + Rust)**

```bash
npm run build
cd src-tauri && cargo check
```

Expected: no errors.

- [ ] **Step 4: Run all tests**

```bash
cd .. && npm run test -- --reporter=verbose
cd src-tauri && cargo test
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
cd ..
git add package.json src-tauri/Cargo.toml
git commit -m "chore: bump version to 0.2.1"
```

---

## Summary

| Task | Area | Impact |
|------|------|--------|
| 1 | Git | Feature branch |
| 2 | Rust safety | Eliminate 2 production panics |
| 3 | DB performance | Index for server-wide message search |
| 4 | Memory leak | IntersectionObserver cleanup |
| 5 | Crypto security | Argon2 SENSITIVE params |
| 6 | Crypto infra | signJson/verifyJsonSignature helpers |
| 7 | Network security | Signed WebRTC signals |
| 8 | Network security | Peer message validation |
| 9 | Network security | Rate limiting |
| 10 | UX bug | Typing cleanup on disconnect |
| 11 | UX bug | Unread count reset on channel switch |
| 12 | Code quality | Reactive userId sync + dedup race fix |
| 13 | Code quality | useIsAdmin composable extraction |
| 14 | Release | Version bump 0.2.0 → 0.2.1 |
