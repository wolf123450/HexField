# Spec 07 — Message Sync (P2P History Reconciliation)

> Parent: [Architecture Plan](../architecture-plan.md)

---

## 1. Problem

The rendezvous server relays messages in real time but does not persist them. When a client is offline, those messages would otherwise be lost. Relying on a random peer for history is unreliable: no peers may be online, and per-recipient encryption means no peer holds a copy decryptable by the returning client.

**Solution**: set reconciliation. Each client maintains a local timestamped message log. When any two clients connect, they efficiently determine what the other is missing and exchange only the differences.

---

## 2. Message Log Model

Relevant sync fields per message row:

```
message_id   — UUID v7 (time-sortable)
channel_id   — scope for reconciliation
logical_ts   — Hybrid Logical Clock (canonical ordering)
content      — NULL when deleted (row kept for sync correctness)
read         — local-only flag, never synced
```

**Canonical ordering rule**: messages are ordered by `logical_ts`, not `created_at`. The HLC combines wall-clock + logical counter, ensuring consistent ordering without clock synchronisation.

---

## 3. Sync Strategy

### Primary: Negentropy

Negentropy (Aljoscha Meyer) is a set reconciliation protocol for ordered event sets with minimal bandwidth.

**Algorithm**:
1. Divide event set into ranges by ID/timestamp
2. Exchange BLAKE3 fingerprints per range
3. Matching ranges skipped; mismatching ranges split recursively
4. At leaf ranges: exchange IDs → content of missing messages

**Cost**: O(k log n) where k = differences, n = total messages. Efficient for typical reconnection (small k, large n).

**Implementation**: `negentropy` Rust crate v0.5 — runs in Tauri backend with direct SQLite access. JS frontend initiates sync via Tauri invoke; results returned as diff.

### Fallback 1: Custom Negentropy-Compatible Implementation

If crate API doesn't fit: implement the protocol manually (~300–500 lines Rust). The spec is well-documented in Meyer's paper.

### Fallback 2: Merkle Tree Over Time Buckets

1. Partition messages into 1-hour time buckets
2. Each leaf = `BLAKE3(sorted IDs in bucket)`
3. Internal nodes = `BLAKE3(left || right)`
4. Exchange root hashes; recurse into differing subtrees
5. At differing leaves: exchange IDs → fetch content

Same O(k log n) cost but with fixed overhead proportional to number of buckets.

---

## 4. Sync Session Protocol

Triggered when two peers connect (WebRTC data channel open or WS relay available):

```
Initiator                              Responder
  |── sync_request { channelId } ──►   |
  |◄── sync_hello { fingerprint } ──── |
  |  [negentropy rounds]               |
  |── sync_have { missingIds[] }  ──►  |
  |◄── sync_have { missingIds[] } ──── |
  |── sync_send { messages[] }   ──►  |
  |◄── sync_send { messages[] }  ──── |
  |── sync_done               ──►     |
```

**Three passes per connection** (in sequence):

```
Pass 1: reconcile messages  table (per channel)
Pass 2: reconcile mutations table (per channel — edits, deletes, reactions)
Pass 3: reconcile mutations table (per server — server_update, role_assign,
                                   channel_create/update/delete, device_attest/revoke
                                   channelId = '__server__')
```

Channels prioritised by: currently open > recently active > others.

---

## 5. Mutations Sync

Mutations have their own UUID v7 IDs — they are first-class Negentropy entries, reconciled independently from messages.

**Applying mutations on receipt** (in `logical_ts` order):

```typescript
function applyMutation(m: Mutation) {
  switch (m.type) {
    case 'edit':
      // Verify m.authorId === original message authorId
      // UPDATE messages SET content = m.newContent WHERE id = m.targetId
      //   AND logical_ts < m.logical_ts  (last-write-wins)
      break

    case 'delete':
      // Verify m.authorId has permission (own message or MANAGE_MESSAGES)
      // 1. NULL content: UPDATE messages SET content = NULL WHERE id = m.targetId
      // 2. Delete attachment files from disk
      // 3. NULL raw_attachments column
      // 4. Remove from FTS index
      // Message ROW is kept — required for Negentropy sync correctness
      break

    case 'reaction_add':
    case 'reaction_remove':
      // No direct DB side effect — mutations table IS the source of truth
      // Reactions are materialised in messagesStore from mutations log
      break

    case 'server_update':
      // Parse m.newContent as JSON, apply fields to servers row
      break

    // channel_create / channel_update / channel_delete → apply to channels table
    // role_assign / role_revoke → apply to members.roles JSON array
    // device_attest / device_revoke → apply to devices table
  }
}
```

**Concurrent edit conflict**: last-write-wins by `logical_ts`. The mutation with the higher HLC value wins; the earlier one stays in the table (sync correctness) but has no visible effect.

---

## 6. What Delete Actually Erases

| Data | Fate |
|------|------|
| `messages.content` | → NULL |
| `messages.raw_attachments` | → NULL (JSON cleared) |
| Inline attachment files on disk | → deleted |
| FTS index entry | → removed |
| Message row | → **kept** (required for sync) |
| Delete mutation row | → **kept** (required for peers to learn the delete) |
| Copies on peers' devices | → erased when they receive the delete mutation |
| Copies on modified clients | → cannot be forced |

---

## 7. Read/Unread State

`read` is a **local-only flag** — never transmitted, never synced. Messages arrive as unread. Marking a channel as read sets all messages to read locally. State lives only in local SQLite.

---

## 8. Offline Message Queue

Messages composed while offline:
- Appended to `pendingMessages` in `messagesStore` with a local UUID v7
- Written to SQLite immediately
- **Not sent over any transport** — they wait
- On reconnect: Negentropy sync naturally includes them (they're in the local SQLite log)
- No explicit re-send logic needed

---

## 9. Storage Limits & Pruning

**Default limit**: 5 GB total (SQLite + attachments + emoji). User configurable up to 10 GB. Set in Settings > Privacy.

**Auto-pruning** when >90% full (oldest-first):
1. Attachment files beyond 30-day retention period
2. Attachment files within retention period
3. Message content in oldest channels (NULL content, keep rows)

Pruning never deletes message rows or mutation rows.

**Server archive / re-baseline** (Phase 6, server admin only):
1. Admin exports signed compressed archive bundle of all messages up to timestamp T
2. Admin issues `server_update` mutation: `{ historyStartsAt: T, archiveUrl: "hexfield://archive/..." }`
3. Peers receiving this stop requesting history before T from other peers
4. Archive importable via `hexfield://archive/` deep link → shows import prompt

---

## 10. Cold-Start Problem

If a user joins a server and no other member is ever online at the same time, they will have no history. Accepted limitation of the P2P model.

Future mitigations:
- **Designated archive peers**: members can voluntarily act as persistent stores ("always-on sync mode")
- **Rendezvous server buffering**: server optionally buffers encrypted content for a configurable TTL (e.g. 7 days)

---

## 11. Hybrid Logical Clock — `src/utils/hlc.ts`

```typescript
// HLC state: { wallMs: number, logical: number }
// Encode as: "{wallMs}-{logical}" (lexicographically sortable)
//
// On send:
//   wallMs = max(Date.now(), state.wallMs)
//   logical = (wallMs === state.wallMs) ? state.logical + 1 : 0
//
// On receive(remoteTs):
//   wallMs = max(Date.now(), state.wallMs, remote.wallMs)
//   logical = (wallMs === state.wallMs && wallMs === remote.wallMs)
//               ? max(state.logical, remote.logical) + 1
//               : (wallMs === state.wallMs || wallMs === remote.wallMs)
//               ? max(state.logical, remote.logical) + 1
//               : 0

export function generateHLC(): string
export function advanceHLC(remoteTs: string): string
export function compareHLC(a: string, b: string): number  // -1 | 0 | 1
```
