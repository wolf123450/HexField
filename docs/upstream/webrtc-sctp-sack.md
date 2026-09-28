# Upstream draft: webrtc-sctp SACK processing desync

Drafts for webrtc-rs/webrtc (crate `webrtc-sctp`, path `sctp/`). Posted as
[webrtc-rs/webrtc#914](https://github.com/webrtc-rs/webrtc/issues/914); the issue offers a PR against
the `v0.17.x` branch. Our patch lives in
`src-tauri/patches/webrtc-sctp/` (see `PATCHES.md` there); lab numbers are in
`docs/network-compatibility-plan.md` step 6a.

Before posting, check that the bug is still present on webrtc-rs `master`
(`sctp/src/association/association_internal.rs`, `process_selective_ack`) and
rebase the patch onto it. Also search existing issues for
`ErrInflightQueueTsnPop` / "unable to be popped from inflight queue".

---

## Issue

**Title:** sctp: one bad SACK permanently stalls the association (`unable to be popped from inflight queue TSN`)

**Body:**

### Summary

`AssociationInternal::process_selective_ack` pops chunks off `inflight_queue`
before it has finished checking the SACK. It can return an error after the
pops, and `handle_sack` then does not advance `cumulative_tsn_ack_point`. The
popped TSNs are gone but the ack point still points before them, so every
later SACK fails at the first TSN with `ErrInflightQueueTsnPop`. The
association never acknowledges data again: `buffered_amount()` never drains
and the data channel is dead, while ICE and DTLS stay connected.

### Version

webrtc-sctp 0.17.1 (webrtc 0.17.1).

### Where

`sctp/src/association/association_internal.rs`, `process_selective_ack`.
Errors that can happen after chunks were already popped:

1. `ErrInvalidSystemTime`: in the cumulative-ack loop and in the gap-block
   loop, `SystemTime::now().duration_since(c.since)` fails if the wall clock
   stepped back after the chunk was sent (NTP step, VM/WSL clock sync).
2. `ErrTsnRequestNotExist`: a gap ack block names a TSN that is not in
   flight. This includes gap offset 0, which is the cumulative TSN ack itself
   and was just popped by the loop above.
3. `ErrInflightQueueTsnPop`: a TSN in the cumulative range is not at the
   queue front.

`handle_inbound` logs the error and continues, so nothing tears the
association down either. It just stays stuck.

### How to reproduce

Two webrtc-rs peers with a data channel in a network-namespace lab (WSL2),
100 ms delay on each WAN link (or `netem delay 60ms loss 2%` through a TURN
relay), one message every 500 ms. Step one peer's wall clock back while it
runs, for example with libfaketime (`LD_PRELOAD=.../libfaketime.so.1
DONT_FAKE_MONOTONIC=1 FAKETIME_NO_CACHE=1 FAKETIME_TIMESTAMP_FILE=/tmp/ft`)
and a loop that writes `-1`, `-2`, ... to `/tmp/ft` every 0.3 s. That peer
logs `Invalid SystemTime` once, then `unable to be popped from inflight queue
TSN` on every SACK, and messages stop arriving: 10 of 10 runs on the delay
link, 10 of 10 on the TURN link. The monotonic clock is not faked, so the
retransmit timers are unaffected. A real NTP step or VM clock sync does the
same thing.

We also saw data channels stall at 2–3% loss without any clock step in
earlier lab runs, but those runs had no logging, so we cannot say which of
the three errors started them. In this round the stall did not occur without
the clock step (60 runs of the unmodified crate).

A unit-level reproduction: an association with `cumulative_tsn_ack_point = 9`,
TSNs 10–12 in flight, `my_next_tsn = 13`, and a SACK with
`cumulative_tsn_ack = 11` and a gap block `5-5` (TSN 16, never sent).
`handle_sack` returns `Err`, TSNs 10 and 11 are popped, and the ack point is
still 9. The next valid SACK (`cumulative_tsn_ack = 11`) fails too.

### Expected

An invalid SACK is ignored without changing any state (RFC 4960 §6.2.1 lets a
receiver drop a SACK it cannot use), and processing a valid SACK cannot fail
partway.

### Related

pion/webrtc#1270 describes the same "T3-RTX escalates, never recovers"
signature for the Go implementation this crate was ported from.

---

## Pull request

**Title:** sctp: validate SACK before popping in-flight chunks

**Body:**

Fixes #<issue>.

`process_selective_ack` could return an error after popping chunks from
`inflight_queue`. `handle_sack` only advances `cumulative_tsn_ack_point` on
success, so the queue and the ack point went out of sync and every later SACK
failed with `ErrInflightQueueTsnPop`: the association stalled permanently.

This PR splits the function in two phases:

- **`validate_selective_ack` (no state change).** Rejects the SACK with the
  existing error variants if the cumulative TSN ack is not below
  `my_next_tsn`, if a TSN in `ack point + 1 ..= cumulative TSN ack` is not in
  flight or the queue front is not `ack point + 1`, or if a gap ack block has
  `start > end` or names a TSN that is not in flight. The `my_next_tsn` check
  comes first, so a bogus cumulative TSN cannot make the loop long.
- **Apply (cannot fail).** Pops and marks chunks as before. If the clock
  stepped back, the RTT sample for that chunk is skipped (debug log) instead
  of returning `ErrInvalidSystemTime`. Gap offset 0 (the cumulative TSN itself,
  not a valid gap start per RFC 4960 §3.3.4) is skipped instead of failing.

The old error returns in the apply phase stay as guards; they cannot be
reached after validation.

`process_fast_retransmission` can also return `ErrTsnRequestNotExist` after
changing `miss_indicator`s. It does not pop and runs after the ack point is
advanced, so it cannot cause this desync; this PR leaves it alone.

**Tests** (`association_internal_test.rs`): a SACK with an unknown gap TSN,
a cumulative TSN past `my_next_tsn`, a TSN missing from the queue, and a
reversed gap block each return `Err` and leave the ack point and queue
unchanged, and a following valid SACK applies. A SACK with gap offset 0 and
a SACK after a clock step back both apply. Five of the six fail on the
current code.

**Integration result:** two webrtc-rs peers in a network-namespace lab
(100 ms delay each way, or 2% loss through TURN), with the wall clock of one
peer stepped back 1 s every 0.3 s via libfaketime (monotonic clock
untouched), 60 messages 500 ms apart. Before: 0/10 and 0/10 runs delivered
every message; each run logged `Invalid SystemTime` once and then
`unable to be popped from inflight queue TSN` on every SACK. After: 10/10 and
10/10. Without the clock step we did not see the stall in 60 runs of the
unmodified crate at 2–3% loss, so we cannot say how often the other triggers
(for example a gap block naming a TSN that is not in flight) happen in
practice.
