# NAT lab

Tests HexField peer connectivity across simulated NATs, packet loss, latency and
bandwidth limits. It runs in CI (`.github/workflows/netlab.yml`) and on any Linux
machine with root, including WSL2.

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
regression test. When a fix lands (for example TURN wired into the app, or a
rendezvous fallback for invites), flip the matching row from `fail` to `pass`.

| NAT type | Rule | Real-world equivalent |
|---|---|---|
| `cone` | `MASQUERADE` | Home router (port-preserving, stateful filtering) |
| `symmetric` | `MASQUERADE --random-fully` | Carrier-grade NAT (CGNAT), many corporate firewalls |

`forward=yes` forwards natA's TCP signal port to the host. This stands in for a
successful UPnP mapping or a manual port forward. Without it, the joiner has only
the host's LAN address, just like an invite created behind an unmapped NAT.

## Scope

The lab covers direct signaling plus ICE, DTLS and SCTP data channels. It does
not cover mDNS (multicast doesn't cross the routers, as on real networks),
rendezvous-server signaling, or voice and video tracks.
