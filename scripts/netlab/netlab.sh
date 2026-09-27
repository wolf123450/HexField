#!/usr/bin/env bash
# HexField NAT lab — simulated networks built from Linux network namespaces.
#
# Topology (all addresses are private/documentation ranges; nothing leaves the host):
#
#   hf-peerA 10.0.1.2 ── 10.0.1.1 hf-natA 198.51.100.2 ─┐
#                                                        ├─ hf-pub bridge 198.51.100.1
#   hf-peerB 10.0.2.2 ── 10.0.2.1 hf-natB 198.51.100.3 ─┘   (the "internet"; runs coturn)
#
# The internet is one bridged subnet on purpose: coturn binds each relay socket
# to the interface of its relay IP, so with a routed, multi-interface "internet"
# it cannot relay between the two sides ("udp send: Network is unreachable").
#
# peerA runs the probe as HOST (the server owner who made the invite);
# peerB runs it as JOINER. NAT types per router:
#   cone       MASQUERADE — port-preserving, endpoint-independent mapping,
#              conntrack filtering (≈ port-restricted cone; typical home router)
#   symmetric  MASQUERADE --random-fully — new external port per destination
#              (≈ symmetric NAT / many CGNATs and corporate firewalls)
# --forward-host adds a TCP port forward on natA to the host's signal port,
# standing in for a successful UPnP mapping or a manual port forward.
#
# Usage (needs root, iproute2, iptables, coturn):
#   netlab.sh up [--nat-a cone|symmetric] [--nat-b cone|symmetric] [--forward-host] [--netem "<args>"]
#   netlab.sh down
#   netlab.sh case <name> <nat-a> <nat-b> <forward:yes|no> <ice:stun|turn> <netem|-> <expect:pass|fail>
#   netlab.sh matrix            # run the built-in case list, compare against expectations
#
# Env: PROBE=path to hexfield-netprobe (default src-tauri/target/debug/hexfield-netprobe)
#      OUT=directory for logs and results (default /tmp/netlab)
#      COTURN_ARGS=extra turnserver flags (e.g. --verbose)

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PROBE="${PROBE:-$ROOT/src-tauri/target/debug/hexfield-netprobe}"
OUT="${OUT:-/tmp/netlab}"
SIGNAL_PORT=7800
TURN_USER=lab
TURN_PASS=lab-secret
NS=(hf-pub hf-natA hf-natB hf-peerA hf-peerB)

nsx() { local ns=$1; shift; ip netns exec "$ns" "$@"; }

log() { echo "[netlab] $*" >&2; }

link() { # link <nsA> <ifA> <addrA|-> <nsB> <ifB> <addrB>
  ip link add "$2" netns "$1" type veth peer name "$5" netns "$4"
  [[ $3 == - ]] || nsx "$1" ip addr add "$3" dev "$2"
  nsx "$4" ip addr add "$6" dev "$5"
  nsx "$1" ip link set "$2" up
  nsx "$4" ip link set "$5" up
}

setup_nat() { # setup_nat <ns> <type>
  local ns=$1 type=$2 flags=""
  [[ $type == symmetric ]] && flags="--random-fully"
  [[ $type == cone || $type == symmetric ]] || { log "unknown NAT type: $type"; exit 2; }
  nsx "$ns" sysctl -qw net.ipv4.ip_forward=1
  nsx "$ns" iptables -t nat -A POSTROUTING -o wan -j MASQUERADE $flags
  # Stateful firewall: only replies (and explicit forwards) come in from the WAN.
  nsx "$ns" iptables -P FORWARD DROP
  nsx "$ns" iptables -A FORWARD -i lan -o wan -j ACCEPT
  nsx "$ns" iptables -A FORWARD -i wan -o lan -m conntrack --ctstate ESTABLISHED,RELATED,DNAT -j ACCEPT
  # Drop unsolicited WAN traffic to the router itself, like real routers do.
  # Without this, an early hole-punch packet leaves a conntrack entry that
  # clashes with the router's own later outbound mapping and forces a port
  # rewrite, turning the "cone" NAT into a symmetric one.
  nsx "$ns" iptables -A INPUT -i wan -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
  nsx "$ns" iptables -A INPUT -i wan -j DROP
}

cmd_down() {
  pkill -f "turnserver.*netlab" 2>/dev/null || true
  for ns in "${NS[@]}"; do
    ip netns pids "$ns" 2>/dev/null | xargs -r kill 2>/dev/null || true
    ip netns del "$ns" 2>/dev/null || true
  done
}

cmd_up() {
  local nat_a=cone nat_b=cone forward=no netem=""
  while [[ $# -gt 0 ]]; do
    case $1 in
      --nat-a) nat_a=$2; shift 2 ;;
      --nat-b) nat_b=$2; shift 2 ;;
      --forward-host) forward=yes; shift ;;
      --netem) netem=$2; shift 2 ;;
      *) log "unknown option: $1"; exit 2 ;;
    esac
  done

  cmd_down
  mkdir -p "$OUT"
  for ns in "${NS[@]}"; do
    ip netns add "$ns"
    nsx "$ns" ip link set lo up
  done

  nsx hf-pub ip link add inet type bridge
  nsx hf-pub ip addr add 198.51.100.1/24 dev inet
  nsx hf-pub ip link set inet up
  link hf-pub  pubA -           hf-natA  wan 198.51.100.2/24
  link hf-pub  pubB -           hf-natB  wan 198.51.100.3/24
  nsx hf-pub ip link set pubA master inet
  nsx hf-pub ip link set pubB master inet
  link hf-natA lan  10.0.1.1/24 hf-peerA eth0 10.0.1.2/24
  link hf-natB lan  10.0.2.1/24 hf-peerB eth0 10.0.2.2/24

  nsx hf-natA ip route add default via 198.51.100.1
  nsx hf-natB ip route add default via 198.51.100.1
  nsx hf-peerA ip route add default via 10.0.1.1
  nsx hf-peerB ip route add default via 10.0.2.1

  setup_nat hf-natA "$nat_a"
  setup_nat hf-natB "$nat_b"

  if [[ $forward == yes ]]; then
    nsx hf-natA iptables -t nat -A PREROUTING -i wan -p tcp --dport "$SIGNAL_PORT" \
      -j DNAT --to-destination "10.0.1.2:$SIGNAL_PORT"
  fi

  # Impair both WAN links in both directions (each qdisc shapes egress).
  if [[ -n $netem ]]; then
    for pair in "hf-natA wan" "hf-natB wan" "hf-pub pubA" "hf-pub pubB"; do
      read -r ns dev <<<"$pair"
      # shellcheck disable=SC2086
      nsx "$ns" tc qdisc add dev "$dev" root netem $netem
    done
  fi

  # STUN + TURN on the "internet".
  nsx hf-pub turnserver -n --log-file=stdout --no-tls --no-dtls --no-cli \
    --listening-ip=198.51.100.1 --relay-ip=198.51.100.1 \
    --lt-cred-mech --user="$TURN_USER:$TURN_PASS" --realm=netlab \
    --min-port=49152 --max-port=49400 ${COTURN_ARGS:-} >"$OUT/coturn.log" 2>&1 &
  sleep 1
  log "up: natA=$nat_a natB=$nat_b forward-host=$forward netem='${netem:-none}'"
}

cmd_case() { # see usage
  local name=$1 nat_a=$2 nat_b=$3 forward=$4 ice=$5 netem=$6 expect=$7
  local up_args=(--nat-a "$nat_a" --nat-b "$nat_b")
  [[ $forward == yes ]] && up_args+=(--forward-host)
  [[ $netem != - ]] && up_args+=(--netem "$netem")
  cmd_up "${up_args[@]}"

  # ice: stun = STUN only; turn = STUN + TURN (all candidate types, like the app);
  #      relay = STUN + TURN with ICE restricted to relay candidates
  local ice_args=(--ice "stun:198.51.100.1:3478")
  case $ice in
    stun) ;;
    turn | relay)
      ice_args+=(--ice "turn:198.51.100.1:3478?transport=udp" --turn-user "$TURN_USER" --turn-pass "$TURN_PASS")
      [[ $ice == relay ]] && ice_args+=(--relay-only)
      ;;
    *) log "unknown ice mode: $ice"; exit 2 ;;
  esac

  # The invite gives the host's WAN address only when a port forward exists;
  # otherwise the joiner is left with the host's LAN address (what JoinView tries).
  local endpoint="10.0.1.2:$SIGNAL_PORT"
  [[ $forward == yes ]] && endpoint="198.51.100.2:$SIGNAL_PORT"

  nsx hf-peerA "$PROBE" --id host --listen-port "$SIGNAL_PORT" "${ice_args[@]}" \
    >"$OUT/$name.host.out" 2>"$OUT/$name.host.err" &
  sleep 1
  local result code=0
  result=$(nsx hf-peerB "$PROBE" --id joiner --connect "$endpoint" --peer host \
    --pings 20 --timeout-secs 30 "${ice_args[@]}" 2>"$OUT/$name.joiner.err") || code=$?
  cmd_down

  local got=pass
  [[ $code -eq 0 ]] || got=fail
  local verdict=OK
  # expect=any: known-flaky row — recorded in the results, never fails the run
  [[ $got == "$expect" || $expect == any ]] || verdict=UNEXPECTED
  echo "$result" >"$OUT/$name.json"
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$verdict" "$name" "$nat_a/$nat_b" "$forward" "$ice" "${netem// /_}" "$expect" "$got" "$result" \
    | tee -a "$OUT/results.tsv"
  [[ $verdict == OK ]]
}

# name | natA | natB | forward | ice | netem | expected
# Expectations document today's behaviour; flip a row when a fix lands.
#   cone-nofwd-stun      → rendezvous fallback for invites without a port forward
#   *-lossy / *-loss     → `any`: webrtc-rs SCTP data channels stall intermittently
#                          at 2–3% loss (stage "sctp"/"echo"); make these `pass`
#                          once data channels are reliable under loss
#   *-turn (symmetric)   → pass via the relay-only retry (webrtc_manager.rs,
#                          RELAY_RETRY_AFTER = 15 s): webrtc-rs 0.17 fails ICE across
#                          symmetric NAT with host/srflx candidates present, so the
#                          offerer re-offers relay-only; expect connect_ms ≈ 17 s
CASES=(
  "cone-fwd-stun             cone      cone      yes stun  -                         pass"
  "cone-nofwd-stun           cone      cone      no  stun  -                         fail"
  "cone-fwd-stun-lossy       cone      cone      yes stun  delay_80ms_20ms_loss_3%   any"
  "cone-fwd-stun-slow        cone      cone      yes stun  delay_250ms_rate_512kbit  pass"
  "symA-coneB-fwd-stun       symmetric cone      yes stun  -                         fail"
  "symA-symB-fwd-stun        symmetric symmetric yes stun  -                         fail"
  "cone-fwd-relay            cone      cone      yes relay -                         pass"
  "symA-symB-fwd-relay       symmetric symmetric yes relay -                         pass"
  "symA-symB-fwd-relay-loss  symmetric symmetric yes relay delay_60ms_loss_2%        any"
  "cone-fwd-turn             cone      cone      yes turn  -                         pass"
  "symA-symB-fwd-turn        symmetric symmetric yes turn  -                         pass"
  "symA-coneB-fwd-turn       symmetric cone      yes turn  -                         pass"
)

cmd_matrix() {
  [[ -x $PROBE ]] || { log "probe not found at $PROBE (build with --features netprobe)"; exit 2; }
  mkdir -p "$OUT"; : >"$OUT/results.tsv"
  local failures=0 row
  for row in "${CASES[@]}"; do
    # shellcheck disable=SC2086
    set -- $row
    cmd_case "$1" "$2" "$3" "$4" "$5" "${6//_/ }" "$7" || failures=$((failures + 1))
  done
  write_summary
  log "$failures unexpected result(s)"
  [[ $failures -eq 0 ]]
}

write_summary() {
  [[ -n ${GITHUB_STEP_SUMMARY:-} ]] || return 0
  {
    echo "### NAT lab results"
    echo
    echo "| | case | NAT A/B | fwd | ICE | netem | expect | got | candidates | connect ms | rtt avg ms |"
    echo "|---|---|---|---|---|---|---|---|---|---|---|"
    while IFS=$'\t' read -r verdict name nat fwd ice netem expect got json; do
      local mark="✅"; [[ $verdict == OK ]] || mark="❌"
      [[ $expect == any && $got == fail ]] && mark="⚠️"
      local cand ms rtt
      cand=$(jq -r '[.local_candidate, .remote_candidate] | map(. // "-") | join("→")' <<<"$json" 2>/dev/null || echo -)
      ms=$(jq -r '.connect_ms // .stage // "-"' <<<"$json" 2>/dev/null || echo -)
      rtt=$(jq -r '.rtt_ms_avg // "-"' <<<"$json" 2>/dev/null || echo -)
      echo "| $mark | $name | $nat | $fwd | $ice | ${netem//_/ } | $expect | $got | $cand | $ms | $rtt |"
    done <"$OUT/results.tsv"
  } >>"$GITHUB_STEP_SUMMARY"
}

[[ $EUID -eq 0 ]] || { log "must run as root (network namespaces)"; exit 2; }
case "${1:-}" in
  up) shift; cmd_up "$@" ;;
  down) cmd_down ;;
  case) shift; cmd_case "$@" ;;
  matrix) cmd_matrix ;;
  *) sed -n '2,27p' "$0"; exit 2 ;;
esac
