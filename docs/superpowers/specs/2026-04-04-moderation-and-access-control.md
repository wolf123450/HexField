# Moderation & Access Control — Design Spec

**Date:** 2026-04-04  
**Status:** Planning (not yet implemented)  
**Scope:** Server access control, member kicking/banning, disciplinary voice mute, and "closed server" mode  
**Out of scope:** DMs moderation (separate spec), content scanning (CSAM / spam AI), federation / cross-server bans

---

## 1. Problem Statement

GameChat servers currently have no moderation tooling beyond role assignment.  
Specifically missing:

1. **Kick** — forcibly remove a member from a server session
2. **Ban** — prevent a permanently-excluded member from rejoining
3. **Disciplinary voice mute** — silence a participant's microphone from an admin perspective (distinct from the user's own mute toggle)
4. **Closed server mode** — prevent new members from joining without explicit admin approval; optionally require a reverse-invite flow

Moderation actions in a P2P system have a fundamental challenge: **there is no authoritative server** to enforce bans. Any ban must be locally enforced by all members who receive the signed ban event, and a banned user could technically run a modified client. The design goal is to make banning work for honest-participant scenarios (the common case) while acknowledging that a motivated attacker running a custom client can circumvent it.

---

## 2. Data Model Changes

### 2.1 New Mutation Types (extend existing `MutationType` in `core.ts`)

```ts
| 'member_kick'    // targetId = userId; removes from server state locally
| 'member_ban'     // targetId = userId; persists a ban record
| 'member_unban'   // targetId = userId; removes ban record
| 'voice_mute'     // targetId = userId; admin mutes a voice participant
| 'voice_unmute'   // targetId = userId; admin unmutes a voice participant
```

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

### 2.3 Server flags (extend `Server` interface)

```ts
interface Server {
  // ... existing fields ...
  accessMode: 'open' | 'closed'  // default 'open'
  // 'closed' = new join requests require admin approval
}
```

### 2.4 Join Request Record (new table: `join_requests`)

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

### 3.1 Kick (session-level, non-persistent)

A kick is a signed mutation of type `member_kick` broadcast to all peers.

**Initiating peer (admin/owner):**
1. Creates `member_kick` mutation (`targetId = userId`, signed with own Ed25519 key)
2. Broadcasts `{ type: 'mutation', mutation }` to all peers
3. Locally: removes the member from `serversStore.members[sid][targetId]`
4. If the kicked user is in voice: calls `handleVoiceLeave(userId)` locally

**Receiving peer:**
- `handleMutationMessage` dispatches `member_kick` to `serversStore.applyServerMutation`
- Locally removes the member from `members[sid][targetId]`
- Removes that peer from voice state

**Kicked user's own client:**
- Receives the `member_kick` for their own userId
- Leaves the server gracefully: `serversStore.leaveServer(sid)` (to be implemented)
- Redirects UI to "you were kicked from this server" error state

**Persistence:**
Kicks are ephemeral — no DB record. On next app start the kicked user could attempt to reconnect. Kicking is a session-level action only.

### 3.2 Ban (persistent, invite-code blocked)

A ban is a `member_ban` mutation propagated via the mutation/sync pathway (so late-joining members also receive it).

**Initiating peer:**
1. Creates `member_ban` mutation (`targetId = userId`, optional `newContent = JSON.stringify({ reason, expiresAt })`)
2. Broadcasts + saves to DB via mutation pathway
3. Locally: inserts into `bans` table + kicks the user (fires `member_kick` first)

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

Admin-initiated voice mute. Different from a user's own mute toggle.

### 4.1 Wire protocol

Two new voice messages:
```ts
{ type: 'voice_admin_mute',   targetId: string; issuerServerId: string }
{ type: 'voice_admin_unmute', targetId: string; issuerServerId: string }
```

### 4.2 Receiving side (the muted user's client)

On receiving `voice_admin_mute` where `targetId === myUserId`:
- Sets `voiceStore.adminMuted = true`
- Mutes the audio track (replace with silent `MediaStreamTrack` or set `enabled = false`)
- Displays a visible indicator: "You have been muted by an admin"
- Ignores the user's own unmute button until `voice_admin_unmute` is received

### 4.3 Receiving side (all other peers)

On receiving `voice_admin_mute` for another peer:
- Flags that peer as `adminMuted: true` in `voiceStore.peers`
- Shows a distinct mute icon on that peer's tile

### 4.4 Trust concern

A muted user's client could ignore the `voice_admin_mute`. Anyone receiving the muted user's audio can simply stop rendering it using `audioTrack.enabled = false` on the remote `MediaStreamTrack`. This client-side enforcement is good enough for trusted participants.

---

## 5. Closed Server Mode

### 5.1 States

| `accessMode` | Behaviour |
|---|---|
| `'open'` (default) | Anyone with a valid invite code can join immediately |
| `'closed'` | Invite code generates a join *request*; admin must approve before manifest is sent |

### 5.2 "Closed" join flow

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

### 5.3 Reverse invite (QR / link from the requester)

The alternative to "admin must approve pull requests" is "the joiner sends a link/QR that the admin scans". This is equivalent in security but reverses the UX:
- Joiner: generates a one-time invite capsule (their `userId + publicSignKey + publicDHKey + serverHint`) as a QR code or deep link
- Admin: scans the QR / clicks the link → their client adds the requester as a member + broadcasts the membership
- No invite code needed — the admin explicitly vets each joiner

**Assessment:** The QR flow is better for high-security servers (no invite code in the wild) but requires the joiner and admin to be online simultaneously. Useful specifically when invite codes are disabled. Suggest implementing **both** mechanisms and letting admins toggle per server:
- `inviteMode: 'code_open' | 'code_approval' | 'reverse_invite_only'`

### 5.4 When `inviteMode = 'reverse_invite_only'`

No invite codes are issued. The "Invite People" button generates a sharable capsule (QR + deep-link URL `gamechat://approve?userId=...&key=...`). The admin's client handles the deep link, generating a signed `member_join` mutation and broadcasting it.

---

## 6. Security & Threat Model

| Threat | Mitigation |
|---|---|
| Banned user rejoins with same identity | Blocked at `server_join_request` handler by all online members who check `bans` table |
| Banned user creates new identity | Bypasses ban. No cryptographic defence in v1. Future: ban record can include IP hint. |
| Malicious admin kicks legitimate user | The kicked user's client falls back to their local DB + can rejoin via invite if unbanned |
| Admin mute ignored by modified client | Other peers can locally mute the remote audio track; no privacy/security risk |
| Fake admin issues kick/ban | Mutations are author-signed; clients verify `mutation.authorId` has `admin` or `owner` role in `serversStore.members[sid]` before applying |
| MITM of join request approval | The `server_manifest` is signed by the admin's Ed25519 key; the joiner verifies the signature against the admin's known public key before trusting the manifest |
| Invite code leaked to unwanted user | Use `inviteMode: 'code_approval'` so all joins need explicit approval; or switch to `reverse_invite_only` |

**Role check on mutation apply (existing pattern to extend):**
```ts
// In serversStore.applyServerMutation, before applying:
const issuer = members[mutation.serverId]?.[mutation.authorId]
const issuerIsAdmin = issuer?.roles.some(r => r === 'admin' || r === 'owner') ?? false
if (!issuerIsAdmin) return  // silently ignore — not authoritative
```

---

## 7. UI Changes

### 7.1 Member context menu (right-click a member in `MemberList`)

Admin/owner sees additional items:
- **Kick from server** → `member_kick` mutation
- **Ban from server** → modal: optional reason + optional expiry → `member_ban` mutation
- **Mute in voice** (only when user is in voice) → `voice_admin_mute`
- **Unmute in voice** (only when user is admin-muted) → `voice_admin_unmute`

### 7.2 Server Settings > Members

New sub-section: **Access Requests** (only visible when `accessMode === 'closed'`):
- List of pending `join_requests`
- Each row: avatar (if gossiped), name, time of request, Approve / Deny buttons

New sub-section: **Bans**:
- List of banned users
- Each row: userId (first 8 chars), reason, banned-by, expiry (if set), Unban button

New toggle: **Server Access Mode** (admin only):
- Open (anyone with invite code can join)
- Requires approval (invite code generates a request)
- Reverse invite only (no invite code; admin scans/clicks requester's QR)

### 7.3 Kicked/banned user experience

On receiving `member_kick` for self:
- Toast notification: "You were removed from [ServerName]"
- Server is removed from the sidebar
- Channels from that server are cleared from local state (or kept as archive)

On attempting to join a server you're banned from:
- `server_join_denied` message received
- Toast: "You are banned from [ServerName]"

---

## 8. Implementation Phases (suggested)

| Phase | Feature | Effort |
|---|---|---|
| A | Kick (ephemeral) + ban (persistent) | Small–medium |
| B | Admin voice mute/unmute | Small |
| C | Closed server mode (approval flow) | Medium |
| D | Reverse invite (QR capsule, no invite code) | Medium |
| E | Ban expiry + background pruning | Small |

Suggested order: A → B → C → D → E. Phase D requires the deep-link infrastructure from Phase 1's `tauri-plugin-deep-link` work.

---

## 9. Open Questions

1. **Ban record gossip**: should `bans` be synced to all members via Negentropy (like messages/mutations) so late-joiners know about bans? Or only enforced by the members who were online when the ban was issued? — Recommend: yes, sync via mutation pathway so all members enforce bans consistently.

2. **Kick without ban**: if a kicked-but-not-banned user is online, they immediately reconnect via LAN. Should a kick auto-close their peer connection? — Yes: the receiving side should call `webrtcService.destroyPeer(targetId)` on kick. The kicked user can reconnect, which effectively means kick = temporary disconnect only.

3. **Who can kick/ban admins?** — Only the `owner` role. Admins can kick/ban regular members but not other admins or the owner.

4. **Multi-admin consensus for bans?** — Out of scope for v1 (too complex for a P2P UX). Single admin can ban.

5. **Duration of "muting" vs. "deafening"**? A disciplinary mute only affects the target's outgoing audio. Should there also be a "blind" (no messages visible) mode? — Deferred; voice mute is sufficient for v1.
