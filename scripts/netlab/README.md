# NAT lab

Tests HexField peer connectivity across simulated NATs, packet loss, latency and
bandwidth limits. It runs in CI (`.github/workflows/netlab.yml`) and on any Linux
machine with root, including WSL2.

## Lab gotchas

- The routers drop unsolicited WAN input. Without this rule, an early
  hole-punch packet leaves a conntrack entry that forces a port rewrite, so a
  "cone" NAT behaves like a symmetric one.
- The "internet" is a single bridged subnet. coturn binds each relay socket to
  its relay IP's interface, so a routed internet with several interfaces cannot
  relay between the two sides.
- The "internet" namespace has a default route (into a dummy interface), like a
  real server. Without it, coturn's first send to a peer's private host
  candidate fails with `udp send: Network is unreachable`, and coturn then
  stops forwarding for that whole allocation. ICE with mixed candidate types
  then fails even for relay↔relay pairs (plan step 3b). The case column
  `noroute` recreates this server on purpose.

## Parts

- **`hexfield-netprobe`** (`src-tauri/src/bin/netprobe.rs`, built with
  `--features netprobe`): a headless command-line driver for the app's real
  `lan.rs` signaling and `webrtc_manager.rs` WebRTC code. The networking layer
  sends its events through `EventSink` (`src-tauri/src/event_sink.rs`) instead of
  the Tauri `AppHandle`. The joiner prints one JSON line with the stage it
  reached, time to connect, the selected ICE candidate types (host, srflx or
  relay) and data-channel echo round-trip times.
- **`netlab.sh`**: builds five network namespaces (two peers, two NAT routers and
  a "public internet" namespace that runs coturn for STUN and TURN), sets the NAT
  type of each router, optionally adds a port forward and `tc netem` impairment,
  then runs a host probe and a joiner probe.

## Run locally (Linux or WSL2)

```bash
sudo apt-get install -y coturn iproute2 iptables jq
(cd src-tauri && cargo build --features netprobe --bin hexfield-netprobe)
sudo PROBE=$PWD/src-tauri/target/debug/hexfield-netprobe bash scripts/netlab/netlab.sh matrix
# One case (name natA natB forward ice netem expect [type] [route|noroute]):
sudo PROBE=… bash scripts/netlab/netlab.sh case mycase symmetric cone yes turn "delay 100ms loss 5%" pass
# Debug one case: raw ICE outcome, every ICE check, packet capture, coturn detail
sudo PROBE=… PCAP=1 COTURN_ARGS=--verbose PROBE_ARGS="--no-relay-retry --trace-deps" \
  bash scripts/netlab/netlab.sh case dbg symmetric symmetric yes turn - pass relay
```

Results are written to `/tmp/netlab/results.tsv`, with per-case logs next to it
(`<case>.host.err`, `<case>.joiner.err`, `<case>.coturn.log`, and `<case>.pcap`
with `PCAP=1`). Set `OUT=` to change the directory.

## Reading the matrix

Each row has an expected outcome that matches what the code does **today**. The
job passes when every result matches its expectation, which makes it a
regression test. Rows with expectation `any` are known to be flaky: they are
recorded (⚠️ in the summary) but never fail the run. When a fix lands (for example TURN wired into the app, or a
rendezvous fallback for invites), flip the matching row from `fail` to `pass`.

| NAT type | Rule | Real-world equivalent |
|---|---|---|
| `cone` | `MASQUERADE` | Home router (port-preserving, stateful filtering) |
| `symmetric` | `MASQUERADE --random-fully` | Carrier-grade NAT (CGNAT), many corporate firewalls |

The optional last column is the expected connection type (`lan`, `direct` or
`relay`). The probe fails a passing row with stage `type` if the type differs,
and reports `media_allowed` (false for relayed connections, per the relay
policy).

The `ice` column selects the ICE servers: `stun` means STUN only; `turn`
means STUN plus TURN with all candidate types, as the app would use them; `relay`
means STUN plus TURN restricted to relay candidates (`--relay-only`).

`forward=yes` forwards natA's TCP signal port to the host. This stands in for a
successful UPnP mapping or a manual port forward. Without it, the joiner has only
the host's LAN address, just like an invite created behind an unmapped NAT.

## Findings so far

- Direct signaling plus srflx hole punching works across cone NATs, including
  with 3% loss (connects in about 9s) and on a 250ms, 512 kbit link (about 12.6s).
- **Data channels stall under packet loss (plan step 6a).** At 2–3% loss,
  webrtc-rs's SCTP layer intermittently fails to open the data channel (stage
  `sctp`, with `unable to be popped from inflight queue TSN` warnings) or
  delays messages by more than 5s (stage `echo`).
  - **Root cause of the `inflight queue TSN` failure:** a bug in
    `process_selective_ack` (`webrtc-sctp-0.17.1/src/association/association_internal.rs`):
    it pops chunks off `inflight_queue` in a loop before the SACK is fully
    validated, and only advances `cumulative_tsn_ack_point` if the whole loop
    succeeds. Under loss, a SACK can reference a TSN a previous (also-failed)
    SACK already popped; the loop then returns `Err(ErrInflightQueueTsnPop)`,
    which the caller logs and swallows as non-fatal — but the ack point is
    never advanced, so every later SACK hits the same already-missing TSN
    forever. The data channel is then permanently dead (outbound bytes never
    drain) even though ICE and DTLS stay healthy. Same signature as
    [pion/webrtc#1270](https://github.com/pion/webrtc/issues/1270) (unfixed
    upstream there too). webrtc-rs 0.17.1 doesn't expose SCTP RTO/retransmit
    tuning via `SettingEngine` (`RTO_INITIAL`/`RTO_MIN`/`RTO_MAX`/`MAX_INIT_RETRANS`
    are `pub(crate)` in `webrtc-sctp`), so this can't be tuned from the app.
  - **Fix:** `webrtc_manager.rs` now polls each open data channel's
    `buffered_amount()` every 10s and forces a full reconnect
    (`start_offer()`, same path `schedule_relay_retry` uses) if outstanding
    bytes stop draining for 8 consecutive polls (~80s). That margin is
    deliberate: it must clear webrtc-sctp's `RTO_MAX` (60s, hardcoded) or it
    misfires on a link that's merely slow, not stalled. An earlier, faster
    version (~8s total) force-reconnected a **passing** `cone-fwd-stun-slow`
    run (250ms delay, 512kbit, no loss) mid-test and turned it into a fail —
    a tiny queued ping can legitimately sit in `buffered_amount()` for
    several seconds on a link that thin.
  - **Results after the fix** (`netlab.sh case`, batches of 5 runs):
    `cone-fwd-stun-slow` **3/3 pass** (confirms the regression above is
    fixed). `symA-symB-fwd-relay-loss` (2% loss, relay) **7/10 pass** across
    two batches, against 14/20 before the fix — the same rate, so no
    measurable change, and not the 5/5 needed to flip `expect=any` to
    `pass`. The failures are instances of the stall bug where
    detection-plus-reconnect (~80s+) doesn't finish inside the probe's fixed
    20-ping/5s-per-ping window; showing the recovery needs a longer window.
    `cone-fwd-stun-lossy` (3% loss, 80±20ms jitter, direct) is unchanged
    (1/5; was 3/8) — its failures are a *different* mode (single pings
    missing the probe's 5s deadline during a legitimate RTO retransmit,
    stage `echo`, `pongs: 15-19/20`), not the permanent-stall bug the fix
    targets. Both rows stay `expect=any`; see
    `docs/network-compatibility-plan.md` step 6a for follow-up ideas
    (app-level message ack/resend, or loosening the probe's per-ping
    deadline).
- Joins with no port forward fail at the signaling stage, before WebRTC starts.
- Symmetric NAT on either side fails with STUN only, as expected.
- TURN works with all candidate types across symmetric NATs: the `turn` rows
  connect in about 2.1 s without the relay-only retry. An earlier failure here
  was a lab fault, not a webrtc-rs bug (see the default-route gotcha above and
  plan step 3b).
- If the TURN server stops relaying after a failed send (row
  `symA-symB-fwd-turn-noroute`), the offerer retries with relay-only ICE after
  15 s (`RELAY_RETRY_AFTER` in `webrtc_manager.rs`) and connects at about 17 s
  (`relay_retry: true`). A TURN server that denies private peer addresses
  (coturn `denied-peer-ip`) avoids the fault.

## Scope

The lab covers direct signaling plus ICE, DTLS and SCTP data channels. It does
not cover mDNS (multicast doesn't cross the routers, as on real networks),
rendezvous-server signaling, or voice and video tracks.
