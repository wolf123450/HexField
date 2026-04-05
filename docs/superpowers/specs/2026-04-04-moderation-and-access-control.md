# Moderation & Access Control — Design Spec

**Date:** 2026-04-04  
**Status:** Planning (not yet implemented)  
**Scope:** Server access control, member kicking/banning, voice channel kick, disciplinary voice mute, per-channel access control, invite code constraints (expiry/use limits), personal block/mute, moderation audit log, "closed server" mode  
**Out of scope:** DMs moderation (separate spec), content scanning (CSAM / spam AI), federation / cross-server bans

---

## 1. Problem Statement

HexField servers currently have no moderation tooling beyond role assignment.  
Specifically missing:

1. **Server kick** — forcibly remove a member from the server session
2. **Voice channel kick** — eject a participant from a specific voice channel without touching their server membership
3. **Ban** — prevent a permanently-excluded member from rejoining
4. **Disciplinary voice mute** — silence a participant's microphone from an admin perspective (persistent across sessions, distinct from the user's own mute toggle)
5. **Per-channel access control** — restrict a text or voice channel to specific roles or a user whitelist/blacklist
6. **Personal block/mute** — per-user, client-side: block messages or silence voice for a user without any admin involvement
7. **Invite code constraints** — time expiry and/or maximum use count on invite codes (higher-priority than reverse-invite flow)
8. **Moderation audit log** — reason/message recorded with every kick/ban/mute action; visible to all admins
9. **Closed server mode** — new joins require explicit admin approval; optionally use a reverse-invite flow

Moderation actions in a P2P system have a fundamental challenge: **there is no authoritative server** to enforce bans. Any ban must be locally enforced by all members who receive the signed ban event, and a banned user could technically run a modified client. The design goal is to make banning work for honest-participant scenarios (the common case) while acknowledging that a motivated attacker running a custom client can circumvent it.

---

## 2. Data Model Changes

### 2.1 New Mutation Types (extend existing `MutationType` in `core.ts`)

```ts
| 'member_kick'         // targetId = userId; removes from server state locally
| 'member_ban'          // targetId = userId; persists a ban record
| 'member_unban'        // targetId = userId; removes ban record
| 'voice_kick'          // targetId = userId; ejects from a specific voice channel only
| 'voice_mute'          // targetId = userId; admin mutes a voice participant (persistent)
| 'voice_unmute'        // targetId = userId; admin unmutes a voice participant
| 'channel_acl_update'  // targetId = channelId; newContent = ChannelACL JSON
```

All moderation mutations include `reason?: string` in `newContent` (JSON). Every mutation that writes to `mod_log` also records the `reason` and `issued_by` fields there.

### 2.2 Ban Record (new table: `bans`)

```sql
CREATE TABLE IF NOT EXISTS bans (
  server_id   TEXT NOT NULL,
  user_id     TEXT NOT NULL,
  banned_by   TEXT NOT NULL,
  reason      TEXT,
  banned_at   TEXT NOT NULL,
  expires_at  TEXT,          -- NULL = permanent
  PRIMARY KEY (server_id, user_id)
);
```

### 2.3 Moderation Audit Log (new table: `mod_log`)

Every admin action (kick, ban, unban, voice kick, voice mute/unmute, channel ACL change, invite revoke) writes a row here. Rows propagate to all members via the mutation pathway so late-joiners have full history.

```sql
CREATE TABLE IF NOT EXISTS mod_log (
  id          TEXT PRIMARY KEY,      -- UUID v7
  server_id   TEXT NOT NULL,
  action      TEXT NOT NULL,         -- mutation type string
  target_id   TEXT NOT NULL,         -- userId or channelId
  issued_by   TEXT NOT NULL,         -- admin userId
  reason      TEXT,                  -- optional human-readable reason
  detail      TEXT,                  -- JSON: extra context (e.g. channel name, expiry)
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS mod_log_server ON mod_log(server_id, created_at DESC);
```

### 2.4 Per-Channel ACL (new table: `channel_acls`)

```sql
CREATE TABLE IF NOT EXISTS channel_acls (
  channel_id  TEXT PRIMARY KEY,
  server_id   TEXT NOT NULL,
  acl_json    TEXT NOT NULL          -- see §6 for TypeScript schema
);
```

### 2.5 Invite Code Constraints (new table: `invite_codes`)

Replaces the current in-memory-only `activeInviteTokens` map (lost on restart). Adding persistence and constraint fields.

```sql
CREATE TABLE IF NOT EXISTS invite_codes (
  code        TEXT PRIMARY KEY,
  server_id   TEXT NOT NULL,
  created_by  TEXT NOT NULL,
  max_uses    INTEGER,               -- NULL = unlimited
  use_count   INTEGER NOT NULL DEFAULT 0,
  expires_at  TEXT,                  -- ISO-8601 or NULL
  created_at  TEXT NOT NULL
);
```

### 2.6 Personal Block/Mute (localStorage, never synced)

These are purely client-side decisions; they are never broadcast to peers.

```
localStorage key: hexfield_personal_blocks_${myUserId}  → JSON array of blocked userIds
localStorage key: hexfield_personal_mutes_${myUserId}   → JSON array of voice-muted userIds
```

### 2.7 Server flags (extend `Server` interface)

```ts
interface Server {
  // ... existing fields ...
  accessMode: 'open' | 'closed'                                       // default 'open'
  inviteMode: 'code_open' | 'code_approval' | 'reverse_invite_only'   // default 'code_open'
}
```

### 2.8 Join Request Record (new table: `join_requests`)

```sql
CREATE TABLE IF NOT EXISTS join_requests (
  id          TEXT PRIMARY KEY,
  server_id   TEXT NOT NULL,
  user_id     TEXT NOT NULL,
  display_name TEXT NOT NULL,
  public_sign_key TEXT NOT NULL,
  public_dh_key   TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending'  -- 'pending' | 'approved' | 'denied'
);
```

---

## 3. Kick & Ban Design

### 3.1 Server Kick (session-level, non-persistent)

A kick is a signed mutation of type `member_kick` broadcast to all peers.

**Initiating peer (admin/owner):**
1. Opens a small "Kick [Name]?" modal with an optional **Reason** text field and a Confirm button
2. Creates `member_kick` mutation (`targetId = userId`, `newContent = JSON.stringify({ reason })`)
3. Broadcasts `{ type: 'mutation', mutation }` to all peers
4. Writes to `mod_log` locally
5. If the kicked user is in voice: also fires a co-incident `voice_kick` mutation for their current channel

**Receiving peer:**
- `handleMutationMessage` dispatches `member_kick` to `serversStore.applyServerMutation`
- Locally removes the member from `members[sid][targetId]`
- Removes that peer from voice state
- Calls `webrtcService.destroyPeer(targetId)` so the kicked user can't immediately re-send data

**Kicked user's own client:**
- Receives the `member_kick` for their own userId
- Shows toast: "You were removed from [ServerName]" + reason if provided
- Leaves the server gracefully: `serversStore.leaveServer(sid)` (to be implemented)

**Persistence:**
Kicks are ephemeral — the kick itself has no DB record, but `mod_log` records the action. On next app start the kicked user may reconnect (ban separately if permanent exclusion is needed).

### 3.1b Voice Channel Kick (session-level, granular)

Ejects a participant from a specific voice channel only. Server membership and text chat access are unaffected.

**Mutation:** `voice_kick`, `targetId = userId`, `newContent = JSON.stringify({ channelId, reason })`

**All peers on receive:**
- If target is in the named voice channel: call `voiceStore.removePeer(targetId)` and close that peer's audio stream for this channel
- Write to `mod_log`

**Kicked user's own client:**
- If `targetId === myUserId` and currently in the named channel: call `voiceStore.leaveVoiceChannel()`
- Show toast: "You were removed from voice by an admin" + optional reason
- The user may rejoin the voice channel unless a channel ACL (§6) prevents it

### 3.2 Ban (persistent, invite-code blocked)

A ban is a `member_ban` mutation propagated via the mutation/sync pathway (so late-joining members also receive it).

**Initiating peer:**
1. Opens a "Ban [Name]?" modal with: optional **Reason** field + **Duration** picker (Permanent / 30 days / 7 days / 1 day)
2. Creates `member_ban` mutation (`targetId = userId`, `newContent = JSON.stringify({ reason, expiresAt })`)
3. Broadcasts + saves to DB via mutation pathway
4. Writes to `mod_log`
5. Locally: inserts into `bans` table + fires a co-incident `member_kick` mutation

**All peers on receive:**
- Persist ban to `bans` table
- Walk their `connectedPeers` — if the banned user is connected, call `handleVoiceLeave` + destroy their WebRTC peer connection

**Join-time enforcement:**
When a new `server_join_request` arrives, the host checks `bans` for `(serverId, requesterId)` before issuing the `server_manifest`. If a ban exists and has not expired, the host rejects with `{ type: 'server_join_denied', reason: 'banned' }`.

**Limitations (acknowledged):**
A banned user who generates a new identity (new Ed25519 keypair = new userId) can bypass the ban. For a trust-based P2P app this is acceptable. Future mitigation: IP/fingerprint hints stored in the ban record (Phase 6+).

### 3.3 Unban

`member_unban` mutation removes the ban from the `bans` table on all peers. Only admins/owners can issue.

### 3.4 Ban expiry

If `expiresAt` is set and `Date.now() > expiresAt`, the ban record is treated as absent at join-enforcement time. A background job (or on-open check) can prune expired rows.

---

## 4. Disciplinary Voice Mute

Admin-initiated voice mute. Distinct from a user's own mute toggle. **Persistent** — stored in `mod_log` and re-applied on session reconnect.

### 4.1 Wire protocol

`voice_mute` / `voice_unmute` travel through the normal mutation pathway (broadcast + DB-persisted by all peers).

```ts
// mutation.targetId = userId
// mutation.newContent = JSON.stringify({ reason?: string })
```

### 4.2 Receiving side (the muted user's client)

On receiving `voice_mute` where `targetId === myUserId`:
- Sets `voiceStore.adminMuted = true`
- Sets `audioTrack.enabled = false` on the local mic track
- Shows indicator: "You have been muted by an admin" + optional reason
- Ignores the user's own unmute button until a `voice_unmute` is received

### 4.3 Receiving side (all other peers)

On receiving `voice_mute` for another peer:
- Flags that peer as `adminMuted: true` in `voiceStore.peers`
- Shows a distinct admin-mute icon on that peer's voice tile (different from self-mute icon)

### 4.4 Trust concern

A muted user's client could ignore the `voice_mute`. Anyone receiving the muted user's audio can stop rendering it via `audioTrack.enabled = false` on the remote `MediaStreamTrack`. Client-side enforcement is acceptable for honest-participant scenarios.

---

## 5. Invite Code Constraints

Invite code constraints are **higher priority** than the reverse-invite flow. Currently invite codes have a fixed 1-hour TTL and are stored only in memory (lost on restart).

### 5.1 Two optional constraints

| Constraint | Field | Behaviour |
|---|---|---|
| Time expiry | `expires_at` | Code rejected if `Date.now() > expiresAt`; default = 24 hours |
| Use limit | `max_uses` | Code rejected once `use_count >= max_uses`; default = unlimited (NULL) |

### 5.2 Persistence

Codes are stored in the new `invite_codes` table (§2.5). On server restart the records are loaded from DB and re-populated into `serversStore.activeInviteTokens`.

### 5.3 Invite code lifecycle

1. Admin opens InviteModal → picks expiry and optional max-uses → code generated and saved to `invite_codes`
2. When a `server_join_request` arrives with the code, the receiving admin:
   a. Looks up the code in `invite_codes`
   b. Checks `expires_at` — reject with `{ type: 'server_join_denied', reason: 'invite_expired' }` if stale
   c. Checks `use_count >= max_uses` — reject with `reason: 'invite_exhausted'` if at limit
   d. Otherwise: increments `use_count` in DB; continues with normal join flow
3. Admin can revoke a code from Server Settings > Invites (deletes the DB row + removes from in-memory map)

### 5.4 UI changes to InviteModal

Below the existing invite code + QR display:
- **Expires after**: dropdown — 1 hour / 6 hours / 24 hours / 7 days / Never
- **Max uses**: input with placeholder "Unlimited"; accepts a positive integer
- **Generate new link** button: creates a fresh code with the selected constraints
- **Active codes** (collapsible list): code slug, uses remaining / total, expiry countdown, Revoke button

### 5.5 Join-denied messages shown to the requester

| `reason` | Toast shown |
|---|---|
| `invite_expired` | "This invite link has expired. Ask for a new one." |
| `invite_exhausted` | "This invite link has reached its maximum uses." |
| `banned` | "You are banned from this server." |
| `server_closed` | "This server requires admin approval. Your request is queued." |

---

## 6. Per-Channel Access Control

Granular restrictions on who may read/write in a text channel or join a voice channel.

### 6.1 `ChannelACL` TypeScript interface

```ts
interface ChannelACL {
  channelId: string
  // Only members whose roles overlap this list may access the channel.
  // If omitted/empty — no role restriction.
  allowedRoles?: string[]
  // Explicit user whitelist (userIds). Takes precedence over role check.
  allowedUsers?: string[]
  // Explicit user blacklist (userIds). Denied even if their role would allow.
  deniedUsers?: string[]
  // Convenience flag: channel is private — only allowedUsers members may access it.
  // Supersedes allowedRoles.
  privateChannel?: boolean
}
```

ACL resolution order (first matching rule wins — DENY takes priority):
1. `deniedUsers` contains userId → **DENY**
2. `privateChannel === true` → allow only if userId in `allowedUsers`, else **DENY**
3. `allowedUsers` non-empty and contains userId → **ALLOW**
4. `allowedRoles` non-empty → allow if member roles overlap, else **DENY**
5. No ACL entry (or all fields absent) → **ALLOW** (default open)

### 6.2 Enforcement

**UI (soft — honest clients only):**
- Channels the local user is denied access to are hidden from `ChannelSidebar`
- `channelsStore.isChannelVisible(channelId)` returns false for denied channels
- Attempting to join a denied voice channel: toast "You don't have access to this channel"

**P2P (hard — receiving peer decides):**
- Message arriving on a channel from a denied sender: drop silently + write a debug log line
- Voice join: admin peers check ACL before routing `voice_join_reply`

**Known limitation:** A user running a modified client can still send to denied channels. Other honest clients will drop the message. True cryptographic enforcement requires per-channel symmetric keys — deferred to a future spec (§13 Open Questions).

### 6.3 Propagation

ACL changes travel as `channel_acl_update` mutations (`targetId = channelId`, `newContent = JSON.stringify(acl)`), persisted in `channel_acls` table and held in-memory in `channelsStore.channelAcls: Record<string, ChannelACL>`.

### 6.4 UI — Channel access settings (admin-only)

Admin right-click on channel in sidebar → **Access Settings** (hidden from non-admins):
- Visibility mode: **Public** (default) / **Private** (allowedUsers only) / **Role-gated**
- If Role-gated: checkbox list of server roles
- Allowed users list: member picker
- Blocked users list: member picker
- Confirm → fires `channel_acl_update` mutation + broadcast

---

## 7. Personal Block & Mute (Client-Side Only)

Distinct from admin moderation actions — these are the user's private decisions, never shared.

### 7.1 Personal block (text messages)

- Hides all messages from the blocked user in every channel and every server
- The blocked user is unaware; you still appear in their member list
- Messages are stored in SQLite normally (needed for sync correctness) — filtered at render time only
- Stored in `localStorage` under `hexfield_personal_blocks_${myUserId}` (JSON array of userIds)

### 7.2 Personal voice mute

- Sets `audioTrack.enabled = false` on the remote track received from that peer
- The muted user is unaware — shown as unmuted on their own client
- Stored in `localStorage` under `hexfield_personal_mutes_${myUserId}`
- Shown in the voice tile with a "personally muted" icon (distinct from admin mute icon)

### 7.3 State management (new store)

```ts
// src/stores/personalBlocksStore.ts
export const usePersonalBlocksStore = defineStore('personalBlocks', () => {
  const blockedUsers = ref<string[]>([])
  const mutedUsers   = ref<string[]>([])

  function blockUser(userId: string): void
  function unblockUser(userId: string): void
  function muteUser(userId: string): void     // voice only
  function unmuteUser(userId: string): void
  function isBlocked(userId: string): boolean
  function isMuted(userId: string): boolean

  // Persist to localStorage on change; load on store init
  return { blockedUsers, mutedUsers, blockUser, unblockUser, muteUser, unmuteUser, isBlocked, isMuted }
})
```

### 7.4 UI entry points

- Member context menu → **Block / Unblock** (non-self members)
- Member context menu → **Personally mute / Unmute** (only when both users are in voice)
- User profile popover → same options
- Settings > Privacy → list of all blocked + muted users with remove buttons

---

## 8. Moderation Audit Log

### 8.1 What is logged

Every moderation mutation writes to `mod_log` (§2.3):

| Action | `action` field | `detail` JSON |
|---|---|---|
| Server kick | `member_kick` | `{ targetName, reason }` |
| Server ban | `member_ban` | `{ targetName, reason, expiresAt }` |
| Unban | `member_unban` | `{ targetName }` |
| Voice channel kick | `voice_kick` | `{ targetName, channelId, channelName, reason }` |
| Admin voice mute | `voice_mute` | `{ targetName, reason }` |
| Admin voice unmute | `voice_unmute` | `{ targetName }` |
| Channel ACL change | `channel_acl_update` | `{ channelName, acl }` |
| Invite code revoke | `invite_revoke` | `{ codeSlug }` |

### 8.2 Propagation

Log entries are embedded in mutation `newContent` and synced via the mutation/negentropy pathway, so any admin who comes online later has the full history.

### 8.3 UI — Server Settings > Moderation Log (admin-only)

- Chronological table: timestamp, action badge, issuing admin name, target name, reason
- Filterable by action type and date range
- Inline **Unban** quick-action on ban log rows
- Owner can configure retention period (default 90 days; 10,000-row soft cap before oldest are pruned)

---

## 9. Closed Server Mode

### 9.1 States

| `accessMode` | Behaviour |
|---|---|
| `'open'` (default) | Anyone with a valid invite code can join immediately |
| `'closed'` | Invite code generates a join *request*; admin must approve before manifest is sent |

### 9.2 "Closed" join flow

**Current open flow:**  
B has invite code → B broadcasts `server_join_request` → A (admin member who is online) sends `server_manifest` back

**Closed flow:**  
B has invite code → B broadcasts `server_join_request` → A receives it and sees `server.accessMode === 'closed'` → instead of immediately replying with the manifest, A:
1. Stores the request in `join_requests` table (`status = 'pending'`)
2. Shows a notification/badge to admins: "X requests to join #ServerName"
3. Admin sees a request queue in Server Settings > Members
4. Admin approves → sends `server_manifest` + sets `status = 'approved'`
5. Admin denies → sends `server_join_denied` + sets `status = 'denied'`

**What if no admin is online?**  
The requester sees a "waiting for approval" state. They must be online at the same time as an admin who approves.

### 9.3 Reverse invite (QR / link from the requester)

The alternative to "admin must approve pull requests" is "the joiner sends a link/QR that the admin scans". This is equivalent in security but reverses the UX:
- Joiner: generates a one-time invite capsule (their `userId + publicSignKey + publicDHKey + serverHint`) as a QR code or deep link
- Admin: scans the QR / clicks the link → their client adds the requester as a member + broadcasts the membership
- No invite code needed — the admin explicitly vets each joiner

**Assessment:** The QR flow is better for high-security servers (no invite code in the wild) but requires the joiner and admin to be online simultaneously. Useful specifically when invite codes are disabled. Suggest implementing **both** mechanisms and letting admins toggle per server:
- `inviteMode: 'code_open' | 'code_approval' | 'reverse_invite_only'`

### 9.4 When `inviteMode = 'reverse_invite_only'`

No invite codes are issued. The "Invite People" button generates a sharable capsule (QR + deep-link URL `hexfield://approve?userId=...&key=...`). The admin's client handles the deep link, generating a signed `member_join` mutation and broadcasting it.

---

## 10. Security & Threat Model

| Threat | Mitigation |
|---|---|
| Banned user rejoins with same identity | Blocked at `server_join_request` handler by all online members who check `bans` table |
| Banned user creates new identity | Bypasses ban. No cryptographic defence in v1. Future: ban record can include IP hint. |
| Malicious admin kicks legitimate user | The kicked user's client falls back to their local DB + can rejoin via invite if unbanned |
| Admin mute ignored by modified client | Other peers can locally mute the remote audio track; no privacy/security risk |
| Fake admin issues kick/ban | Mutations are author-signed; clients verify `mutation.authorId` has `admin` or `owner` role in `serversStore.members[sid]` before applying |
| MITM of join request approval | The `server_manifest` is signed by the admin's Ed25519 key; the joiner verifies the signature against the admin's known public key before trusting the manifest |
| Invite code leaked to unwanted user | Set `max_uses` or a short expiry; use `code_approval` mode; or `reverse_invite_only` |
| Personal block bypassed by modified client | Blocks are display-layer only — no enforcement claim |
| ACL bypass via modified client (text) | Honest clients drop the message; no cryptographic protection in v1 |
| ACL bypass via modified client (voice) | Honest clients can locally silence the remote audio track |

**Role check on mutation apply (existing pattern to extend):**
```ts
// In serversStore.applyServerMutation, before applying:
const issuer = members[mutation.serverId]?.[mutation.authorId]
const issuerIsAdmin = issuer?.roles.some(r => r === 'admin' || r === 'owner') ?? false
if (!issuerIsAdmin) return  // silently ignore — not authoritative
```

---

## 11. UI Changes

### 11.1 Member context menu (right-click a member in `MemberList`)

Admin/owner additional items (non-self only):
- **Kick from server** → reason modal → `member_kick` mutation
- **Ban from server** → reason + duration modal → `member_ban` mutation
- **Admin mute in voice** (only when target is in voice + not already admin-muted) → `voice_mute`
- **Admin unmute in voice** (only when target is admin-muted) → `voice_unmute`
- **Kick from voice** (only when target is in voice) → `voice_kick` mutation

All users (non-self) additional items:
- **Block / Unblock** → personal blocks store (§7)
- **Personally mute / Unmute** → personal mutes store — shown only when both are in voice together (§7)

### 11.2 Server Settings tabs

**Members tab** additions:
- Access Requests sub-section (visible only when `accessMode === 'closed'`): pending requests with Approve / Deny
- Bans sub-section: userId slug, reason, expiry, Unban button

**Invites tab** (extend existing InviteModal or promote to Settings tab):
- Expiry dropdown + max-uses input when generating invite
- Active codes list with revoke buttons

**Moderation Log tab** (new, admin-only):
- Chronological log table, filterable by action type and date range (§8.3)

**Access tab** (new, admin-only):
- Server Access Mode toggle: Open / Requires Approval / Reverse Invite Only

### 11.3 Channel context menu (admin-only addition)

- **Access Settings** → opens per-channel ACL popover/modal (§6.4)

### 11.4 Voice tile additions

- Admin-muted peer: distinct "admin muted" badge on voice tile (different colour from self-mute)
- Personally muted peer: distinct "personally muted" icon, visible only to the user who muted

### 11.5 Toast messages

| Event | Toast |
|---|---|
| Received `member_kick` for self | "You were removed from [Server]" + reason |
| Received `voice_kick` for self | "You were removed from voice by an admin" + reason |
| `server_join_denied` | human-readable message per reason (§5.5) |
| Admin muted self | "You have been muted by an admin" + reason |

---

## 12. Implementation Phases (suggested order)

| Phase | Feature | Effort | Priority |
|---|---|---|---|
| A | `invite_codes` table + expiry + max-uses + InviteModal UI | Small | **High** |
| B | Reason modal + `mod_log` table + Audit Log UI | Small | **High** |
| C | Server kick + ban (with reason/expiry) + unban | Medium | High |
| D | Voice channel kick | Small | Medium |
| E | Admin voice mute/unmute (persistent via mutations) | Small | Medium |
| F | Per-channel ACL (role-gated + whitelist/blacklist) | Medium | Medium |
| G | Personal block (text) + personal voice mute | Small | Medium |
| H | Closed server mode (approval flow) | Medium | Low–medium |
| I | Reverse invite (QR capsule, no invite code) | Medium | Low |
| J | Ban expiry + log pruning background jobs | Small | Low |

Phases A and B are independent and can be implemented in parallel.  
Phase I requires `tauri-plugin-deep-link` infrastructure.

---

## 13. Open Questions

1. **Ban record gossip** — should `bans` sync to all members via Negentropy so late-joiners enforce bans? Recommend yes: sync via mutation pathway for consistency.

2. **Kick + LAN reconnect** — a kicked-but-not-banned user on LAN reconnects immediately after `webrtcService.destroyPeer(targetId)`. Kick = temporary disconnect only; ban = permanent exclusion. This is intentional.

3. **Who can kick/ban admins?** — Only the `owner` role. Admins can act on regular members, not on other admins or the owner.

4. **Multi-admin ban consensus?** — Out of scope for v1. Single admin can ban.

5. **Voice mute vs. deafening** — disciplinary `voice_mute` affects outgoing audio only. A "no messages visible" mode (text deafen) is deferred.

6. **Per-channel encryption keys** — true cryptographic ACL enforcement requires per-channel symmetric keys distributed only to allowed members. Significant key-management work; deferred to a future spec (Phase 6+).

7. **Audit log retention cap** — `mod_log` could grow unbounded. Recommend owner-configurable retention (default 90 days) + 10,000-row soft cap before oldest rows are pruned.

8. **Personal block + negentropy sync** — if user A blocks user B and then syncs, A will still receive B's messages into SQLite (correct for protocol integrity). Blocking is purely a render-layer filter. This is intentional and safe.
