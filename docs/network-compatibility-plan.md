# Network compatibility plan

**Goal:** peers can join and talk on as many real networks as possible: home
routers, mobile carrier-grade NAT (CGNAT), guest and corporate Wi-Fi, and
flaky links. The P2P-first model stays. Every server-based fallback is
optional, and the app always tries the direct path first.

**How progress is measured:** the NAT lab (`scripts/netlab/`, CI workflow
`netlab.yml`). Each step below names the lab rows it adds or flips from
`fail` to `pass`. A step is done when its rows pass in CI and the matching
`docs/TODO.md` items are checked.

## Where we are (lab baseline, PR #25)

| Scenario | Today | Why |
|---|---|---|
| Same LAN (mDNS) | ✅ | Direct LAN signaling + host candidates |
| Cone NAT ↔ cone NAT, host port forwarded or UPnP | ✅ ~0.7 s | srflx hole punching |
| Same, 3% loss / 250 ms 512 kbit | ✅ ~9 s / ~12.6 s | |
| Any NAT, **no** port forward | ❌ at signaling | The invite has only direct endpoints; no fallback route for the offer and answer |
| Symmetric NAT (CGNAT) on either side, STUN only | ❌ | Needs a relay |
| TURN, relay-only, symmetric ↔ symmetric | ✅ ~2.1 s | Proves the relay path works |
| TURN, all candidate types, symmetric NAT | ✅ ~17 s (after 3a) | webrtc-rs 0.17 fails ICE with mixed candidate sets; the offerer retries relay-only after 15 s |
| Cone ↔ cone at 3% loss / relay at 2% loss | ⚠️ flaky (3/8, 14/20) | webrtc-rs SCTP stalls: data channel fails to open (`sctp`) or messages delayed >5 s (`echo`) |
| UDP blocked (corporate / guest Wi-Fi) | ❌ (not in lab yet) | webrtc-rs 0.17 TURN client is UDP-only; TCP/TLS are TODOs in `webrtc-ice/src/agent/agent_gather.rs` |

## Connection ladder after this plan

The app tries each rung in order and stops at the first one that works:

1. **LAN**: mDNS discovery, direct signaling (exists)
2. **Direct WAN**: invite endpoint reachable via UPnP or a port forward (exists)
3. **Manual code exchange**: offer/answer codes pasted by the users; no server (step 1b)
4. **Rendezvous signaling**: offer/answer via the rendezvous server (step 1)
5. **TURN relay**: relayed over UDP for symmetric NAT / CGNAT (steps 2–3); text, sync and image previews only (Relay policy)
6. **WebSocket relay over TLS on port 443**: last resort for UDP-blocked networks (step 5); same limits

Rungs 1–3 need no server. Rungs 4–6 need a rendezvous server and a TURN server.
We run a default instance of each (see [Default infrastructure](#default-infrastructure)),
and users can point the app at their own instead, or turn them off.

## Role of the rendezvous server

The rendezvous server is a **signaling mailbox**, not a middleman for chat. While
the app runs, it holds one idle WebSocket so peers can reach it. When a peer
wants to connect, the server forwards the addressed `signal_offer`,
`signal_answer` and `signal_ice` messages. From then on the peers talk
directly (or over TURN), and messages, sync, presence and typing never pass
through the rendezvous server. It also hosts optional directory features:
user search, public server listing, invite codes and TURN credentials.

Today's server goes beyond that role and has an auth hole. Step 1.0 fixes both
before any public deployment.

## Relay policy

Traffic over **our** relays (TURN, and the step 5 WebSocket relay) is limited
to lightweight data:

| Over the relay | Allowed? |
|---|---|
| Text messages, reactions, edits, deletes | ✅ |
| Presence, typing, heartbeats | ✅ (heartbeat at a slower interval, see 3c) |
| Sync (negentropy + pushes) | ✅ |
| Images | ✅ **as a downscaled preview only** (longest side ≈1280 px, WebP/JPEG, ≤≈150 KB) carrying the content hash of the original |
| Full-size images and other attachments | ❌ fetched later over a direct connection |
| Voice, video, screen share | ❌ |

- The UI says clearly when media is unavailable because the connection is
  relayed. For example, the voice channel shows "No direct connection to Alex:
  voice unavailable". It must never fail silently.
- **Upgrade to full resolution:** once the client has a direct or LAN
  connection to *any* peer holding the original (matched by content hash),
  it fetches the full-size file and replaces the preview. This builds on the
  planned content-addressed P2P attachments (phase 5b, spec 12). Chunk
  requests are only ever served over non-relay connections.
- A user's own relay (a TURN server they configured themselves) could lift
  these limits later. Out of scope for now.

## Steps

Recommended execution order: **2 → 3a → 3c → 1b → 1 → 6a → 4 → 5 → 6b → 7 → 8**.
- Steps 2, 3a and 3c make TURN usable, and cheap enough to offer by default.
- Step 1b needs no server.
- Step 1 starts with the server security fix (1.0), which blocks any public
  deployment.

### 1. Rendezvous signaling fallback for joins

*Fixes:* joins without a port forward, whenever both peers can reach a
rendezvous server.

**1.0 Server cleanup and auth fix (blocker for any public deployment):**

> **Done.** `/auth/verify` issues HMAC-SHA256 session tokens (`server/src/session.rs`,
> secret `HEXFIELD_SESSION_SECRET`, TTL `HEXFIELD_SESSION_TTL`) and binds each user
> ID to its first sign key. `/ws` rejects invalid tokens with 401 and takes the user
> ID from the token. Authenticated REST routes, including `/turn/credentials`, need
> `Authorization: Bearer <token>`. The server forwards only `signal_*` messages and
> answers `ping`, with `peer_unavailable` to the sender when `to` is offline. The
> client pings every 45 s, drops the socket after 90 s of silence, and reconnects
> through the existing backoff with a fresh token.

- **Auth hole:** `/auth/verify` checks the Ed25519 challenge but returns the
  user ID itself as the "token" (`server/src/auth.rs:100`), and `/ws` accepts
  any `token` as the user ID without verifying it (`server/src/ws.rs:26`).
  Anyone who knows a user ID (every invite contains one) can connect as that
  user and receive their signaling.
  - Fix: issue a short-lived signed session token (HMAC or Ed25519, containing
    the user ID and expiry); `/ws` rejects connections without a valid one.
  - Use the same token for the other authenticated routes.
- **Remove server-side broadcasts:**
  - The server announces `online`/`offline` to *every* connected user on
    connect and disconnect (`ws.rs:53,78`), and fans `presence_update`,
    `typing_start` and `typing_stop` out to everyone (`ws.rs:103-105`).
  - That leaks presence and typing to strangers, and traffic grows with the
    square of the user count.
  - Presence and typing already travel peer-to-peer, so the server should
    forward only messages addressed to a single recipient.
- **Keepalive:** there is currently no app-level ping on the rendezvous
  WebSocket, so NATs and proxies can silently drop an idle connection. Client
  sends `ping` about every 60 s (the server already answers `pong`); reconnect
  on a missed pong.
- **Unreachable replies go to the sender only:** an offer addressed to a user who
  isn't connected gets a `peer_unavailable` reply sent just to the sender. The
  joiner can then fall back (for example to manual codes, 1b) instead of
  waiting. Nobody learns who is online without addressing them directly.

**1.1 Join fallback:**
- Invite gains an optional `rendezvous` URL field. Keep `v: 2`: old clients
  ignore unknown fields (architecture rule), whereas bumping to v3 would make
  `JoinView` show "outdated invite" on older builds.
- `JoinView.vue`: if no endpoint connects, call `connectToRendezvous(url)` and
  then `connectToPeer`. `signal_send` already falls back to the rendezvous
  WebSocket. The host must be online and connected to the same server.
- Move the rendezvous WebSocket actor out of the `signal_connect` Tauri command
  into a module that emits through `EventSink` (same pattern as `lan.rs`), so
  the probe can use it.
- Probe: `--rendezvous <url>` mode. It authenticates with an Ed25519 key
  (`ed25519-dalek` is already a dependency) through `/auth/challenge` and
  `/auth/verify`.
- Lab: run `hexfield-server` in `hf-pub`. New rows: `cone-nofwd-rdv` (pass),
  `symA-symB-nofwd-rdv-turn` (pass after step 3).

### 1b. Manual code exchange (serverless)

*Fixes:* joins without a port forward and without any server, when both
sides are behind cone NATs (most home routers).

- `WebRTCManager`: non-trickle mode. `create_offer_code(peer)` waits for ICE
  gathering to complete and returns the SDP with all candidates.
  `accept_offer_code` returns a complete answer. `apply_answer_code` finishes
  the handshake. It reuses the existing `PeerEntry` and data-channel wiring.
- Code format: `hexfield-offer:` / `hexfield-answer:` followed by base64url of a
  compact JSON `{ v, from, sdp-essentials, exp }`: ICE ufrag/pwd, DTLS
  fingerprint, candidates. That is a few hundred bytes, which fits in a QR code
  or a chat message. Signed with the sender's Ed25519 identity key in
  `cryptoService`. Single use, expires after about 10 minutes.
- UI:
  - `InviteModal`: a "Direct connect (no server)" option shows the offer code
    (text + QR) and a field to paste the reply code.
  - `JoinModal`: accepts an offer code and shows the reply code.
  - The host must keep the modal open until the reply is pasted.
  - After the data channel opens, the existing `JoinView` flow
    (manifest → `joinFromManifest` → `resyncPeer`) runs unchanged.
- Camera QR scanning is out of scope. `JoinModal`'s "scan a QR code" text
  currently has no scanner behind it; fix the wording or track scanning as a
  separate item.
- Probe: `--offer-out <file>` / `--answer-in <file>` (and the reverse) so the
  lab can pass codes between namespaces through files.
- Lab: row `cone-nofwd-manual` (pass). `sym*-nofwd-manual` stays `fail`, because
  a manual exchange cannot get through symmetric NAT without TURN.

### 2. Wire the frontend ICE config into Rust

*Fixes:* TURN servers configured in the app are ignored today. The Rust peer
connection uses one hardcoded STUN server.

- New command `webrtc_set_ice_servers(servers: [{ urls, username, credential }])`
  → `WebRTCManager::set_ice_servers()`. Call it whenever `buildICEConfig()`
  changes: startup, rendezvous connect (TURN credentials from
  `/turn/credentials`, refreshed before their TTL expires), and changes to
  Settings > Voice custom TURN.
- `server/src/routes/turn.rs`: add a Cloudflare TURN backend. It mints
  short-lived credentials through Cloudflare's API with a server-side key, and
  only for authenticated sessions (1.0). Keep the coturn HMAC backend for
  self-hosters. Pick the backend in config.
- Remove the no-op `setICEConfigBuilder()` stub in `webrtcService.ts`.
- Keep Google STUN as the default when nothing is configured. Add a second
  STUN server so there is no single point of failure.
- Tests: `networkStore` unit test that the invoke receives the built config.
  The probe already covers the Rust side (`--ice`).

### 3. Symmetric NAT with TURN

*Fixes:* lab rows `symA-symB-fwd-turn` and `symA-coneB-fwd-turn`.

- **3a: relay-only retry.** ✅ Done. The retry lives in `WebRTCManager` (`schedule_relay_retry`), so the probe and lab exercise the app's own logic. Lab: `sym*-turn` pass at ~17 s, and the `cone-fwd-turn` guard stays direct (no retry).
  - If a peer's first connection attempt ends in `Failed` (or isn't connected
    after about 15 s) and TURN is configured, re-offer that peer with
    `relay_only`.
  - Needs a per-peer policy, not the current global `set_relay_only`: pass the
    policy into `build_pc` per offer. Carry a `relayOnly: true` flag in
    `signal_offer` so the answerer restricts its own candidates too. Unknown
    fields are ignored by older peers, which then just use all candidates.
  - Flip the `sym*-turn` rows to `pass` and record the connect time, which is
    expected to be about 15 s plus 2 s on first contact.
- **3b: root cause, time-boxed to about 1 day.** Leads:
  - coturn logs `wrote to peer 0 bytes` for relayed checks.
  - webrtc-rs uses a separate socket per candidate type, where browsers share
    one; try `SettingEngine` UDP mux.
  - Check whether newer webrtc-rs releases fix it.
  - If found, fix locally or upstream, and drop the retry delay.
- **3c: enforce the relay policy and keep relays cheap.**
  - Expose each peer's connection type to the frontend: `connectionType: 'lan' | 'direct' | 'relay'`,
    from `selected_candidate_types()`, emitted on connect and after ICE restarts.
  - Gate voice, video and screen share per peer: no media tracks are added for
    relayed peers, and the UI shows the reason.
  - Image previews: when sending an image, always produce a preview (≤≈150 KB)
    plus a content hash. Send the preview to relayed peers and the original
    to direct peers. Receivers upgrade from preview to original over a direct
    connection (see Relay policy). This replaces today's inline data URLs of up
    to 40 KB for relayed peers.
  - Refuse attachment chunk requests over relayed connections.
  - Cut keepalive traffic for relayed peers, which is the dominant relay cost:
    heartbeat 10 s → 30 s, and a longer ICE keepalive/consent interval where
    webrtc-rs allows it.
  - Lab: a relayed row asserts `connectionType: relay` and that a media request
    is refused. The probe gains a `--media` attempt flag for this.

### 4. Recovery after network changes

*Fixes:* switching from Wi-Fi to a hotspot, a NAT changing its port mapping,
laptop sleep, the host restarting.

- ICE restart when the connection state goes to `disconnected` or `failed` on an
  established peer (renegotiate with ice-restart).
- After a heartbeat timeout (25 s), reconnect with backoff through whichever
  signaling path is available (LAN → rendezvous → peer relay), instead of only
  dropping the peer.
- Probe: `--duration <s>` long-run mode with periodic pings, reporting
  reconnect count and downtime.
- Lab rows:
  - `flap`: `ip link set eth0 down` for 5 s in a peer namespace.
  - `rebind`: `conntrack -F` in a NAT namespace mid-session.
  - `host-restart`: kill and relaunch the host probe.

### 5. UDP-blocked networks

*Fixes:* corporate and guest networks that allow only TCP 80/443.

- webrtc-rs 0.17 cannot use TURN over TCP or TLS (see the table above), so TURN
  can't help here. Options:
  - **(a, recommended)** A WebSocket relay over `wss://…:443` through the
    rendezvous server as a last-resort transport for data-channel payloads.
    Messages are already end-to-end encrypted (spec 08), so the server relays
    ciphertext. Same limits as TURN (see Relay policy): text, presence, sync
    and image previews only.
  - (b) Contribute TURN-over-TCP/TLS to webrtc-rs.
  - (c) Use the WebView's native WebRTC on platforms that have it
    (WebView2 / WKWebView), which supports TURN over TLS.
- Lab: row `udp-blocked` (iptables drops UDP except DNS on `hf-natB`). Expect
  `fail` until the relay exists, then `pass` with `transport: ws-relay`.

### 6. Behaviour under impairment

**6a. Data-channel reliability under loss (high priority).** Chat, sync and
signaling all ride on the data channel, and it stalls at 2–3% loss today.
- Reproduce with the probe at `--debug-deps` and characterise it: loss rate
  against failure rate, and which SCTP errors appear.
- Check newer webrtc-rs / `webrtc-sctp` releases and upstream issues for the
  `inflight queue TSN` and `Invalid SystemTime` errors.
- Mitigations if there's no upstream fix:
  - App-level: retry connecting when the data channel doesn't open within N s
    after ICE connects; resend on application-level ack timeout, since messages
    already have IDs and sync repairs gaps.
  - Tune SCTP retransmission settings where webrtc-rs exposes them.
- Done when the `*-lossy` / `*-loss` rows pass 20 of 20 and are switched from
  `any` back to `pass`.

**6b. Media.**
- Probe: send a synthetic Opus audio track (and optionally video) and report
  loss, jitter and round-trip time from RTCP stats.
- Lab rows for voice at 2% loss / 150 ms, and at 512 kbit. Set quality
  thresholds so regressions show up as failures.

### 7. IPv6, double NAT, UPnP edges

- Invite endpoints: include global IPv6 addresses. UPnP is IPv4-only
  (`signal_commands.rs:280`); consider PCP/NAT-PMP later.
- Lab rows: double NAT (a second NAT namespace in front of `hf-natB`); IPv6
  dual-stack host candidates. An IPv6-only / NAT64 row is optional because the
  setup is complex.

### 8. Real-world validation

- Deploy the default infrastructure (below): `hexfield-server` on a GCP e2-micro
  behind Caddy (TLS), with Cloudflare TURN. Requires 1.0.
- Add monitoring: server egress per day, Cloudflare TURN GB per month, and
  concurrent WebSocket count, alerting at 80% of the free allowances.
- Manual matrix on real networks: home ↔ home, home ↔ phone hotspot (CGNAT),
  guest / café Wi-Fi, a corporate network if one is available. Record the
  results here and compare with the lab predictions.

## Default infrastructure

**Decision: option A.**
- **Rendezvous:** `hexfield-server` on a GCP free-tier **e2-micro** (us-west1,
  us-central1 or us-east1), behind Caddy for TLS (`wss://`).
- **TURN:** **Cloudflare's managed TURN service**, with credentials minted by our
  server (step 2).
- Both stay user-configurable: users can point at their own server or TURN, or
  disable them.
- **Privacy note to add to Settings > Privacy:** the default server sees who
  tries to connect to whom, and when. It never sees message contents, and it
  no longer sees presence or typing (1.0).

*Prices and allowances below are from our planning notes (2026) and must be
re-checked before deployment.*

| Service | Free allowance | Beyond free |
|---|---|---|
| GCP e2-micro | 1 instance, ~1 GB/month internet egress (NA) | ~$0.12/GB egress |
| Cloudflare TURN | ~1 TB/month | ~$0.05/GB |

### Capacity estimate (after 1.0 and 3c)

Rough figures, easily off by a factor of three either way.

**Rendezvous server:**
- **Per active user per month:** a ping/pong keepalive every 60 s (~0.2 MB/day
  while online) plus ~5 KB per connection setup. That comes to **~5–15 MB/month**,
  depending on hours online.
- **Free egress:** covers roughly **100–200 active users**.
- **Beyond that:** about **$1–2 per month per 1,000 users**, because signaling is
  tiny. Server traffic now grows with the number of connections, not with the
  square of users.
- **Hardware ceiling:** e2-micro (1 GB RAM) holds roughly **5,000–10,000
  concurrent WebSocket connections**. Next size up is e2-small, about $12/month.

**TURN (Cloudflare), with the relay policy:**
- **Per relayed user per month:**
  - keepalives: ~0.5–1 GB after 3c tuning (~1–1.5 GB before)
  - chat: ~0.1 GB
  - image previews: ~0.1–0.2 GB
- **Free allowance:** covers roughly **1,000–1,500 relayed users** after tuning
  (~500 before).
- **As total users:** about 10–20% of users need a relay (more on mobile), so
  that's roughly **5,000–15,000 monthly active users** within the free
  allowance. Beyond it, about $0.03–0.05 per relayed user per month.

**Overall:**
- Effectively free up to a few hundred users.
- Then about **$1–2/month per 1,000 users** until the e2-micro's
  connection ceiling (~5–10k concurrent online).
- TURN stays free until roughly 5–15k monthly active users.

## Decisions

1. ✅ **Default server:** yes. Option A (GCP e2-micro rendezvous + Cloudflare
   TURN); see Default infrastructure.
2. ✅ **Relay bandwidth:** no voice or video over our relays. Text, presence,
   sync and image previews only, with full resolution fetched over direct
   connections; see Relay policy.
3. ⏳ **Manual exchange UX:** a first-class "Direct connect" option in the invite
   flow, or a hidden advanced fallback shown only after other methods fail?

## Out of scope here

- Peer-relay tier (spec 06, relay-capable peers forwarding signaling). It helps
  once a group already exists, but doesn't solve first contact. Revisit after
  step 1.
- Matrix provider (stretch).
