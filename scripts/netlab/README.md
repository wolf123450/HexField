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
# One case (name natA natB forward ice netem expect):
sudo PROBE=… bash scripts/netlab/netlab.sh case mycase symmetric cone yes turn "delay 100ms loss 5%" pass
```

Results are written to `/tmp/netlab/results.tsv`, with per-case logs next to it.
Set `OUT=` to change the directory.

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

The `ice` column selects the ICE servers: `stun` means STUN only; `turn`
means STUN plus TURN with all candidate types, as the app would use them; `relay`
means STUN plus TURN restricted to relay candidates (`--relay-only`).

`forward=yes` forwards natA's TCP signal port to the host. This stands in for a
successful UPnP mapping or a manual port forward. Without it, the joiner has only
the host's LAN address, just like an invite created behind an unmapped NAT.

## Findings so far

- Direct signaling plus srflx hole punching works across cone NATs, including
  with 3% loss (connects in about 9s) and on a 250ms, 512 kbit link (about 12.6s).
- **Data channels stall under packet loss.** At 2–3% loss, webrtc-rs's SCTP layer
  intermittently fails to open the data channel (stage `sctp`, with
  `unable to be popped from inflight queue TSN` warnings) or delays messages by
  more than 5s (stage `echo`). In local runs, direct at 3% loss passed 3 of 8,
  and relay at 2% loss 14 of 20. These rows use `expect=any` until this is fixed.
- Joins with no port forward fail at the signaling stage, before WebRTC starts.
- Symmetric NAT on either side fails with STUN only, as expected.
- TURN works (the `relay` rows), but webrtc-rs 0.17 fails ICE across symmetric
  NATs when host and srflx candidates are also present. The offerer therefore
  retries with relay-only ICE after 15 s (`RELAY_RETRY_AFTER` in
  `webrtc_manager.rs`), and the `turn` rows connect at about 17 s
  (`relay_retry: true`). The root cause is tracked as plan step 3b.

## Scope

The lab covers direct signaling plus ICE, DTLS and SCTP data channels. It does
not cover mDNS (multicast doesn't cross the routers, as on real networks),
rendezvous-server signaling, or voice and video tracks.
