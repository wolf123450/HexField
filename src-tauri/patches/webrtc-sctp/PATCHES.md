# Local patch to webrtc-sctp

This directory is the crates.io release of `webrtc-sctp` **0.17.1**
(webrtc-rs/webrtc commit `e9fe1bc4207a0c6b8d28d5583a118419be60f3c2`,
path `sctp/`), with one fix applied. It is wired in by `[patch.crates-io]` in
`src-tauri/Cargo.toml`. The first commit that adds this directory is the
unmodified upstream copy, so `git diff <that commit> -- src-tauri/patches/webrtc-sctp`
shows the whole patch.

## The bug

`AssociationInternal::process_selective_ack` (`src/association/association_internal.rs`)
pops each chunk in `cumulative_tsn_ack_point + 1 ..= sack.cumulative_tsn_ack`
off the in-flight queue, then walks the gap ack blocks. Three early returns
can happen after chunks were already popped:

- `ErrInflightQueueTsnPop`: a TSN in the range is not at the front of the queue;
- `ErrTsnRequestNotExist`: a gap ack block names a TSN that is not in flight;
- `ErrInvalidSystemTime`: the wall clock stepped back between sending a chunk
  and its SACK, so the RTT sample fails.

`handle_sack` advances `cumulative_tsn_ack_point` only when
`process_selective_ack` returns `Ok`. After an early return the popped chunks
are gone but the ack point is stale, so every later SACK starts at a TSN that
is no longer in the queue and fails with `ErrInflightQueueTsnPop`. The
association never acknowledges data again: outbound bytes never drain and the
data channel is dead while ICE and DTLS stay up. The logs show one
`Invalid SystemTime` (or other error) and then `unable to be popped from
inflight queue TSN` on every SACK. The NAT lab reproduces it by stepping one
peer's wall clock back with libfaketime (`scripts/netlab/README.md`): the
unpatched crate stalls in 10/10 runs, this copy passes 10/10 (plan step 6a).

## The fix

`process_selective_ack` is split into two phases:

1. **Validate, no state change.** Reject the SACK (return the existing error,
   which `handle_inbound` logs and ignores) if:
   - the cumulative TSN ack is at or past `my_next_tsn` (acks data never sent);
   - a TSN in `ack point + 1 ..= cumulative TSN ack` is not in the in-flight
     queue, or the queue front is not `ack point + 1` (`pop` is front-only);
   - a gap ack block has `start > end`, or names a TSN that is not in the
     in-flight queue.
2. **Apply, cannot fail.** Pop and mark chunks as before. When the clock
   stepped back, the RTT sample for that chunk is skipped (logged at debug)
   instead of returning `ErrInvalidSystemTime`. This is the one behaviour
   change beyond "validate first".

Gap ack block offset 0 names the cumulative TSN ack itself, which RFC 4960
§3.3.4 rules out (a gap starts after the cumulative TSN). The upstream code
fails on it after popping; the patch skips offset 0 in both phases instead of
rejecting the whole SACK, so a peer that sends it does not stall us.

Reviewed and left unchanged: `process_fast_retransmission` can also return
`ErrTsnRequestNotExist` after changing `miss_indicator`s, but it does not pop
and runs after the ack point has been advanced, so it cannot desync the queue.
`inflight_queue.pop` has no other caller.

Unit tests for the bad-SACK cases are at the end of
`src/association/association_internal/association_internal_test.rs`.
Run them from this directory: `cargo test --lib association_internal`.

## Dropping the patch

When an upstream `webrtc-sctp` release contains an equivalent fix:

1. Delete the `[patch.crates-io]` block from `src-tauri/Cargo.toml`.
2. Delete `src-tauri/patches/webrtc-sctp/`.
3. Bump `webrtc` (and so `webrtc-sctp`) and run `cargo update -p webrtc-sctp`.
4. Re-run the NAT lab loss rows (`scripts/netlab/`, plan step 6a).

If `webrtc` is bumped while the patch is kept, re-vendor the matching
`webrtc-sctp` version and re-apply the fix: `[patch]` only applies when the
versions match, and cargo prints `Patch webrtc-sctp ... was not used` otherwise.
Check with `cargo tree -i webrtc-sctp` (the path must point here).

Draft upstream issue and PR text: `docs/upstream/webrtc-sctp-sack.md`.
