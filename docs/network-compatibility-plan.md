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
| TURN, all candidate types, symmetric NAT | ❌ | webrtc-rs 0.17 fails ICE with mixed candidate sets |
| Cone ↔ cone at 3% loss / relay at 2% loss | ⚠️ flaky (3/8, 14/20) | webrtc-rs SCTP stalls: data channel fails to open (`sctp`) or messages delayed >5 s (`echo`) |
| UDP blocked (corporate / guest Wi-Fi) | ❌ (not in lab yet) | webrtc-rs 0.17 TURN client is UDP-only; TCP/TLS are TODOs in `webrtc-ice/src/agent/agent_gather.rs` |

## Connection ladder after this plan

The app tries each rung in order and stops at the first one that works:

1. **LAN**: mDNS discovery, direct signaling (exists)
2. **Direct WAN**: invite endpoint reachable via UPnP or a port forward (exists)
3. **Manual code exchange**: offer/answer codes pasted by the users; no server (step 1b)
4. **Rendezvous signaling**: offer/answer via the rendezvous server (step 1)
5. **TURN relay**: traffic relayed over UDP for symmetric NAT / CGNAT (steps 2–3)
6. **WebSocket relay over TLS on port 443**: last resort for UDP-blocked networks (step 5)

Rungs 1–3 need no server. Rungs 4–6 need a rendezvous server and a TURN server
(`server/` + coturn). Users can self-host these, or we run a default instance
(see Decisions).

## Steps

Recommended execution order: **2 → 3a → 1b → 1 → 6a → 4 → 5 → 6b → 7 → 8**. Steps 2
and 3a are small and make TURN usable. Step 1b needs no server. Step 1 is the
biggest win but depends on the hosting decision.

### 1. Rendezvous signaling fallback for joins

*Fixes:* joins without a port forward, whenever both peers can reach a
rendezvous server.

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
- Remove the no-op `setICEConfigBuilder()` stub in `webrtcService.ts`.
- Keep Google STUN as the default when nothing is configured. Add a second
  STUN server so there is no single point of failure.
- Tests: `networkStore` unit test that the invoke receives the built config.
  The probe already covers the Rust side (`--ice`).

### 3. Symmetric NAT with TURN

*Fixes:* lab rows `symA-symB-fwd-turn` and `symA-coneB-fwd-turn`.

- **3a: relay-only retry.** Small and deterministic.
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
    ciphertext. Text, sync and presence work; voice is best-effort; no screen
    share.
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

- Deploy `server/` + coturn on GCP free tier (e2-micro) with TLS.
- Manual matrix on real networks: home ↔ home, home ↔ phone hotspot (CGNAT),
  guest / café Wi-Fi, a corporate network if one is available. Record the
  results here and compare with the lab predictions.

## Decisions needed

1. **Default server:** ship a default public rendezvous + TURN instance, or
   make it user-configured only? A default makes rungs 4–6 work out of the box.
   It costs money and puts us in the metadata path (the server sees who
   connects to whom, but never message contents).
2. **TURN bandwidth policy:** a relay costs about $0.10/GB of egress past the free
   tier. Options: allow text and voice over TURN but not screen share, or cap
   the bitrate when the selected candidate type is `relay`.
3. **Manual exchange UX:** a first-class "Direct connect" option in the invite
   flow, or a hidden advanced fallback shown only after other methods fail?

## Out of scope here

- Peer-relay tier (spec 06, relay-capable peers forwarding signaling). It helps
  once a group already exists, but doesn't solve first contact. Revisit after
  step 1.
- Matrix provider (stretch).
