# Spec 06 — Networking Layer

> Parent: [Architecture Plan](../architecture-plan.md)

---

## 1. Connection Modes (Priority Order)

| # | Mode | When used |
|---|------|-----------|
| 1 | **LAN mDNS** | Peers on same local network; zero config |
| 2 | **QR code / direct** | First contact; share via any side channel |
| 3 | **Peer-relay** | Mutual peer forwards WebRTC offer/answer |
| 4 | **Rendezvous server** | Configured server for smooth signaling |

---

## 2. QR Code / Invite Link

A QR code or `hexfield://` link encodes:

```json
{
  "userId": "...",
  "displayName": "Alice",
  "publicSignKey": "<base64>",
  "publicDHKey":   "<base64>",
  "endpoints": [
    { "type": "direct", "addr": "203.0.113.1:7777" },
    { "type": "lan",    "addr": "192.168.1.5:7777"  }
  ],
  "serverInvite": {
    "serverId": "...",
    "serverName": "My Gaming Server",
    "inviteToken": "<random>"
  }
}
```

Generated with the `qrcode` npm package (SVG output, displayed in-app). The recipient scans with their phone camera or another HexField instance.

**Server invite via QR**: New member connects directly to the owner (or any online member who can relay), presents the token, and receives the signed server manifest + member list.

---

## 3. LAN Discovery (mDNS / DNS-SD)

On startup the Rust backend:
1. Registers `_hexfield._udp.local` service with `userId` and listen port
2. Browses for other `_hexfield._udp.local` services
3. On discovery: attempt direct connection automatically

Crate: `mdns-sd = "0.18"`. No internet, no server, zero configuration.

---

## 4. Peer-Relay Signaling

When Alice and Charlie share mutual peer Bob, Bob relays WebRTC signaling:

```
Alice                    Bob (relay)                Charlie
  |── relay_offer ──────►|──► signal_offer ─────────►|
  |                       |◄── signal_answer ──────────|
  |◄── relay_answer ─────|                            |
  |◄──────────► relay_ice ◄───────────────────────────►|
  |══════ DTLS handshake (P2P, Bob not involved) ══════|
```

After DTLS handshake, traffic is direct. Bob only forwards SDP blobs.

---

## 5. Optional Rendezvous Server (`hexfield-server` — separate repo)

When configured, provides: smooth signaling, persistent presence, invite link resolution. **Never stores message content.**

**REST API:**
```
POST   /auth/register          { displayName, publicSignKey, publicDHKey }  → { userId, token }
POST   /auth/login             { userId, challengeSignature }               → { token }
GET    /users/:userId          → { userId, displayName, publicSignKey, publicDHKey }
POST   /servers/:serverId/join { inviteCode }               → ServerMember
GET    /servers/:serverId      → Server + member list
POST   /invites                { serverId, maxUses?, expiresAt? }  → InviteLink
GET    /invites/:code          → { serverId, serverName }
POST   /voice/:channelId/join  → { peers: string[] }
DELETE /voice/:channelId/leave → 204
```

**WebSocket `/ws?token=...`:**
```
signal_offer/answer/ice    { to/from, sdp/candidate }
chat_message               { channelId, envelopes[] }    ← relay only; server can't decrypt
presence_update/presence   { status }
typing_start/stop          { channelId }
emoji_sync/request         { serverId, emoji? }
ping / pong
```

**Graceful degradation**: on connection failure, app falls back to LAN + peer-relay. Banner shown: "Using direct connections — server unavailable." Reconnect uses exponential backoff (1s → max 60s).

---

## 6. Device Linking Protocol

```
Device A (existing)               Device B (new)
  | Generate 32-byte one-time token |
  | Display QR (expires 5 min):     |
  |   { userId, deviceId_A,         |
  |     publicSignKey_A, linkToken } |
  |                                  | Scan QR → generate keypair_B
  |◄── device_link_request ─────────|
  |    { linkToken, deviceId_B,      |
  |      publicSignKey_B, publicDHKey_B }
  |                                  |
  | Show prompt: "Link 'Laptop'?"    |
  | On confirm: sign attestation     |
  |   { userId, deviceId_B,          |
  |     publicSignKey_B, publicDHKey_B,
  |     attestedBy: deviceId_A,      |
  |     sig: sign_A(hash(above)) }   |
  |──► device_link_confirm ─────────►|
  | Gossip attestation to all peers  |
  |◄──────── Negentropy sync ────────►| (Device B catches up on history)
```

**Multi-device encryption**: encrypt to ALL attested devices of each recipient.

**Revocation**: `device_revoke` mutation signed by any higher-trust device → peers stop encrypting to revoked device.

---

## 7. NAT Traversal

**Connection order** (automatic):

```
1. Direct STUN   → works for ~80% of home/residential NAT
2. Peer relay    → app-level relay via connected mutual peer
3. TURN relay    → rendezvous server or relay-capable peer
```

**NAT type detection** (on startup + connectivity change):

```typescript
async function detectNATType(): Promise<'open' | 'restricted' | 'symmetric'> {
  const [addr1, addr2] = await Promise.all([
    querySTUN('stun.l.google.com:19302'),
    querySTUN('stun1.l.google.com:19302'),
  ])
  if (addr1.port === addr2.port) return 'open'
  return 'symmetric'  // need relay
}
```

**Relay capability advertisement** in gossip/presence:

```json
{ "userId": "...", "relayCapable": true, "relayAddr": "203.0.113.1:3479" }
```

A peer is relay-capable when: not behind symmetric NAT AND has stable public address (via UPnP or consistent STUN mapping). Mobile devices typically not relay-capable.

**Dynamic ICE config:**

```typescript
function buildICEConfig(targetUserId: string): RTCConfiguration {
  const relays = peersStore.getRelayCapablePeers()
  const rendezvous = settingsStore.rendezvousServer
  const userTURN = settingsStore.customTURNServers

  return {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      ...relays.map(p => ({
        urls: `turn:${p.relayAddr}`,
        username: targetUserId,
        credential: generateRelayToken(p),
      })),
      ...(rendezvous?.turnAddr ? [{ urls: `turn:${rendezvous.turnAddr}`, ... }] : []),
      ...userTURN,
    ]
  }
}
```

**Client-side TURN** (Rust backend, Phase 5c): use `turn` crate from webrtc-rs (NOT `turn-rs`). Handles ALLOCATE/SEND/DATA for WebRTC relay candidates. Only enabled when client is publicly reachable.

---

## 8. WebRTC Service — `src/utils/webrtcService.ts`

```typescript
class WebRTCService {
  private peers = new Map<string, RTCPeerConnection>()

  async createOffer(userId: string): Promise<void>
  async handleOffer(userId: string, sdp: string): Promise<void>
  async handleAnswer(userId: string, sdp: string): Promise<void>
  async handleIceCandidate(userId: string, candidate: RTCIceCandidateInit): Promise<void>
  addScreenShareTrack(track: MediaStreamTrack): void
  destroyPeer(userId: string): void
  destroyAll(): void
}
export const webrtcService = new WebRTCService()
```

**signalingService.ts** abstracts transport — routes through peer-relay or rendezvous WS, making WebRTC layer transport-agnostic.

---

## 9. Wire Message Protocol

All messages sent over WebRTC data channels or WS relay:

```typescript
type WireMessageType =
  | 'chat_message'          // { channelId, envelopes: EncryptedEnvelope[] }
  | 'sync_request'          // { channelId }
  | 'sync_hello'            // { fingerprint }
  | 'sync_have'             // { missingIds: string[] }
  | 'sync_send'             // { messages: MessageRow[] }
  | 'sync_done'
  | 'relay_offer'           // { to, sdp }
  | 'relay_answer'          // { to, sdp }
  | 'relay_ice'             // { to, candidate }
  | 'emoji_request'         // { serverId }
  | 'emoji_sync'            // { serverId, emoji: EmojiMetadata }
  | 'emoji_image_request'   // { emojiId }
  | 'emoji_image'           // { emojiId, imageBytes: base64 }
  | 'typing_start'          // { channelId }
  | 'typing_stop'           // { channelId }
  | 'presence_update'       // { status: OnlineStatus }
  | 'device_link_request'   // { linkToken, deviceId, publicSignKey, publicDHKey }
  | 'device_link_confirm'   // { attestation: Device }
  | 'attachment_want'       // { contentHash }  Phase 5b
  | 'attachment_have'       // { contentHash }  Phase 5b
  | 'screen_share_start'    // { channelId }
  | 'screen_share_stop'     // { channelId }
```
