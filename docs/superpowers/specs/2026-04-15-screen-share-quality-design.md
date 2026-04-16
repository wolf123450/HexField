# Screen Share Quality & Simulcast — Design Spec

**Date**: 2026-04-15
**Status**: Draft
**Scope**: 2-tier simulcast encoding, quality selector UI, 1080p 60fps support, delay reduction

---

## Problem Statement

The current screen share pipeline has several quality and performance limitations:

1. **Capped at 720p 30fps** — `MAX_W = 1280` hardcoded; `videoQuality` setting exists in settingsStore but is never wired
2. **Low-quality previews** — local preview is 640px JPEG at 75% quality, received frames also JPEG 75%
3. **No per-viewer quality control** — one shared `TrackLocalStaticSample`, all peers receive identical stream
4. **~150ms end-to-end delay** — partially caused by unnecessary JPEG round-trip on both send and receive sides
5. **Redundant pixel conversions** — BGRA → RGBA swap + RGBA → YUV420 are two separate passes over the pixel data

---

## Architecture Overview

### Current Pipeline (Sender)

```
WGC → BGRA (4K) → fused downscale+swap → RGBA (720p) → YUV420 → H.264 → 1 shared track → all peers
                   ~~~~~~~~~~~~~~~~~~~~   ~~~~~~~~~~~   ~~~~~~~~
                   pass 1: 17ms           intermediate   pass 2: 6ms
```

### Proposed Pipeline (Sender)

```
WGC → BGRA (4K) → fused downscale + BGRA→YUV420 → H.264 → per-quality track → peers who want it
                   ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~   ~~~~~
                   single pass: ~12ms                 encode
                   
                   × 2 tiers (720p + 1080p) in parallel threads
```

### Current Pipeline (Receiver)

```
RTP → depacketize → H.264 decode → YUV → RGB → JPEG encode → file write → IPC → asset:// → <img>
                                                ~~~~~~~~~~~~   ~~~~~~~~~~
                                                ~8ms           ~3ms (wasteful)
```

### Proposed Pipeline (Receiver)

```
RTP → depacketize → H.264 decode → YUV → RGB → base64 PNG/JPEG → IPC event → data: URL → <img>
                                                (OR)
RTP → depacketize → H.264 decode → YUV → RGB → raw bytes → shared memory → display
```

The receiver pipeline change should be validated by profiling before committing to an approach (see Phase 3).

---

## Design Sections

### 1. Two-Tier Simulcast Encoding

**Two encoder threads** run in parallel, each with a separate `TrackLocalStaticSample`:

| Tier | Resolution | Target FPS | Bitrate | Use Case |
|------|-----------|-----------|---------|----------|
| Low  | 1280×720  | 60 | 2 Mbps  | Default, bandwidth-constrained peers |
| High | 1920×1080 | 60 | 6 Mbps  | Full-quality viewing |

**Thread architecture**:

```
Capture thread (WGC callback)
  │
  ├──► channel ──► Encoder thread 1 (720p → track_low)
  │                  └─ downscale to 720p + BGRA→YUV420 (fused) → encode
  │
  └──► channel ──► Encoder thread 2 (1080p → track_high)
                     └─ downscale to 1080p + BGRA→YUV420 (fused) → encode
                     
For sources ≤ 1080p: encoder 2 skips downscale (passthrough)
For sources ≤ 720p:  only encoder 1 runs (single tier)
```

Each `TrackLocalStaticSample` is added only to peer connections that request that quality tier.

**Peer quality selection protocol**:
- Peers send `{ type: 'quality_request', tier: 'low' | 'high' }` via data channel
- Default tier on connect: `'low'`
- When a peer upgrades, the sender adds the high track to that peer's PC and triggers SDP renegotiation
- When a peer downgrades, the sender removes the high track (or replaces it with the low track)

**Memory budget** per frame (retained briefly in channel buffer):
- 720p BGRA: ~3.6 MB
- 1080p BGRA: ~8.3 MB
- Channel depth: 2 frames (double buffer) = ~24 MB total

### 2. Fused BGRA→YUV420 Conversion

Eliminate the RGBA intermediate. The current pipeline does:
1. Swap B↔R in each pixel (BGRA → RGBA)
2. `YUVBuffer::from_rgb_source()` reads RGBA, computes YUV420

Replace with a single-pass custom conversion that reads BGRA and computes YUV420 directly:

```rust
// BT.709 coefficients (HD content)
// Y  =  0.2126 * R + 0.7152 * G + 0.0722 * B
// Cb = -0.1146 * R - 0.3854 * G + 0.5000 * B + 128
// Cr =  0.5000 * R - 0.4542 * G - 0.0458 * B + 128
//
// In BGRA layout: pixel = [B, G, R, A]
// So we read: b = pixel[0], g = pixel[1], r = pixel[2]
```

This also fuses with the downscale step — the nearest-neighbor sampling reads source BGRA pixels and writes directly to the YUV420 planar buffers.

**Expected savings**: Current swap+yuv = ~23ms → estimated ~12ms (single pass).

### 3. Quality Selector UI (YouTube-Style Gear)

A gear icon overlay on each video tile in `VoiceContentPane.vue`:

```
┌─────────────────────────────┐
│                             │
│       [screen share]        │
│                             │
│                      ⚙      │  ← gear icon, bottom-right
└─────────────────────────────┘
                         │
                         ▼
                   ┌──────────┐
                   │ ● 1080p  │
                   │   720p   │
                   │   Auto   │
                   └──────────┘
```

**Behavior**:
- `Auto`: Default. Uses 720p. (Future: auto-select based on bandwidth estimation.)
- `720p`: Request low tier from sender.
- `1080p`: Request high tier from sender.

**Implementation**:
- New component: `QualitySelector.vue` — positioned absolute within the video tile
- Emits `quality-change` event with `'low' | 'high'`
- `voiceStore` sends `quality_request` message to the sharing peer via data channel
- Sender's `webrtc_manager` updates which track is active for that peer

**Display resolution label**: Show current resolution in the gear menu (e.g., "1080p ✓") based on the most recent decoded frame dimensions.

### 4. Delay Reduction

**Target**: Reduce end-to-end latency from ~150ms to ~80ms.

#### 4a. Fused BGRA→YUV (sender side)

Saves ~11ms by eliminating the RGBA intermediate pass. See section 2.

#### 4b. 60 FPS Capture

Reduces capture interval from 33ms average wait → 16.7ms. Net savings: ~16ms average.

#### 4c. Receiver JPEG Elimination (needs profiling)

Current receive pipeline: decode H.264 → write JPEG to file → emit event → `<img src="asset://...">`.

**Two alternatives to profile before choosing**:

| Approach | Pros | Cons | Expected Savings |
|----------|------|------|-----------------|
| **A: Base64 data URL** | No file I/O, in-memory | +33% IPC payload size (~130KB vs ~100KB) | ~3-5ms |
| **B: Keep file, raise JPEG quality** | Simple | Still writes to disk | 0ms (but better visual quality) |

**Plan**: Add a compile-time or runtime toggle to switch between file-based and base64 output. Profile both approaches using the existing timing infrastructure. Commit to whichever shows a measurable improvement.

### 5. Settings Integration

Wire the existing `videoQuality` setting to control default quality:

```typescript
// settingsStore.ts (already exists, just unused)
videoQuality: 'auto' | '360p' | '720p' | '1080p'    // default: 'auto'
videoFrameRate: 10 | 15 | 30 | 60                    // default: 60 (changed from 30)
videoBitrate: 'auto' | '500kbps' | '1mbps' | '2.5mbps' | '5mbps' | '10mbps'
```

The per-tile quality selector overrides the default for that specific stream.

### 6. Local Preview Improvements

Current: 640px, every-other-frame, JPEG 75%.

**Change to**: Use the same 720p frame that encoder 1 produces (already in memory), skip separate downscale. Emit every 3rd frame (20fps visual update) instead of every 2nd. Raise JPEG quality to 85%.

---

## Performance Budget

At 1080p 60fps (16.7ms budget per frame):

| Step | Time (est.) | Thread |
|------|------------|--------|
| WGC frame arrival | 0ms | WGC callback |
| Channel send to encoder | <1ms | WGC callback |
| Downscale + BGRA→YUV420 (fused) | ~15ms (1080p) / ~8ms (720p) | Encoder thread |
| H.264 encode | ~12ms (1080p) / ~7ms (720p) | Encoder thread |
| write_sample | <1ms | Encoder thread |

**1080p**: ~28ms total per frame in encoder thread → **35 FPS achievable** with current hexfield opt-level 1. To hit 60fps:
- Raise `[profile.dev.package.hexfield]` opt-level to 2 (estimated 40-50% speedup → ~16ms, just within budget)
- OR: accept 30fps for 1080p tier, 60fps for 720p tier

**720p**: ~16ms total → **60 FPS achievable** at opt-level 1.

---

## Data Flow: Quality Negotiation

```
Viewer                                Sharer
  │                                     │
  │ ─── quality_request: 'high' ───►    │
  │                                     │
  │     [sender adds track_high to      │
  │      this peer's PC, triggers       │
  │      SDP renegotiation]             │
  │                                     │
  │ ◄── renegotiation offer/answer ──►  │
  │                                     │
  │ ◄── RTP (1080p H.264 stream) ────   │
  │                                     │
  │ ─── quality_request: 'low' ────►    │
  │                                     │
  │     [sender removes track_high,     │
  │      adds track_low, renegotiates]  │
```

---

## Out of Scope

- **GPU hardware encoding** (NVENC/QSV/AMF) — significant DirectX interop work, deferred to future optimization pass
- **Browser-native getDisplayMedia** — would require dual WebRTC stacks, not practical
- **3+ quality tiers** — 2 tiers (720p + 1080p) is sufficient for P2P with ≤8 participants
- **Adaptive bitrate** (REMB/TWCC congestion control) — valuable but separate feature
- **VP9/AV1 codec switch** — H.264 is adequate; alternatives are slower in software

---

## Implementation Strategy

**Parallel implementation with profiling before switchover.** The new pipeline will be built alongside the current one, selectable via a runtime flag (Tauri command parameter or env var). Both pipelines will share the same profiling instrumentation so we can do apples-to-apples comparison.

### Phases

1. **Fused BGRA→YUV420 + 60fps** — new codepath behind flag, profile vs current
2. **2-tier simulcast threading** — encoder threads, per-peer track assignment, quality_request protocol
3. **Quality selector UI** — gear icon on tiles, QualitySelector component
4. **Receiver delay profiling** — base64 vs file, commit to winner
5. **Settings wiring** — connect videoQuality/videoFrameRate to the pipeline
6. **Preview quality boost** — use 720p encoder output, raise JPEG quality

Each phase is profiled against the prior state. Only after profiling confirms improvement do we remove the old codepath.

---

## Risks

| Risk | Mitigation |
|------|-----------|
| 1080p 60fps exceeds CPU budget at opt-level 1 | Fall back to 1080p 30fps + 720p 60fps; profile with opt-level 2 |
| SDP renegotiation when switching tracks causes brief freeze | Pre-add both tracks to PC, use `replaceTrack()` to swap without renegotiation |
| Channel buffer backpressure if encoder is slower than capture | Use bounded channel (depth 2), drop oldest frame on overflow |
| openh264 thread-safety | Each encoder is a separate `Encoder` instance on its own thread; no shared state |
