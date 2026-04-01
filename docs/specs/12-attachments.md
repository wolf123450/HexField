# Spec 12 — File & Attachment Strategy

> Parent: [Architecture Plan](../architecture-plan.md)

---

## Phase 1–2: Inline Embeddings

Small inline content only:

| Type | Handling |
|------|----------|
| External image URLs | Rendered inline with user-confirmation prompt (privacy — don't auto-load; URL stays as text until user accepts) |
| Files ≤100KB | Base64 encoded, stored in message `raw_attachments` JSON, synced via Negentropy |
| Images >100KB | Auto-downscaled client-side (Canvas API) before embedding; original never sent |
| Files >100KB (non-image) | Blocked in Phase 1; wait for Phase 5b |

**Inline attachment format** (stored in `raw_attachments` JSON column):

```json
[{
  "id": "<uuid v7>",
  "name": "screenshot.png",
  "mimeType": "image/png",
  "size": 45200,
  "inlineData": "<base64>"
}]
```

---

## Phase 4+: Content-Addressed P2P Distribution (torrent-style)

### Content Addressing

Every attachment identified by BLAKE3 hash. Message carries only metadata:

```json
{
  "id": "<uuid v7>",
  "name": "video.mp4",
  "mimeType": "video/mp4",
  "size": 52428800,
  "contentHash": "blake3:abc123...",
  "chunkSize": 262144
}
```

### Storage on Disk

```
$APPDATA/gamechat/attachments/
  {hash[0:2]}/{hash}.bin      ← complete file
  {hash[0:2]}/{hash}.part     ← incomplete download (chunks as bitfield)
```

### Download Flow

```
1. Recipient sees message with attachment metadata
2. Client broadcasts attachment_want { contentHash, to: [all online peers in channel] }
3. Any peer who has the file responds: attachment_have { contentHash, from: peerId }
4. Recipient opens WebRTC data channel to responding peer(s)
5. Download in 256KB chunks; multiple peers serve different chunks (BitTorrent-style)
6. Each chunk verified against content hash; corrupt chunks re-requested
7. On completion: rename .part → .bin
```

### Seeding

Once downloaded, clients automatically serve chunks to requesting peers for the configured retention period (default: 30 days, configurable). After retention period: file deleted from disk, but content hash + metadata in message remains.

**Sender responsibility**: sender continues to serve for the retention period. If sender goes offline before anyone downloads it, any peer who already has it becomes a seeder. If no peer has it and sender is offline: attachment unavailable until sender reconnects.

### Rust Commands (Phase 5b)

```rust
get_attachment_path(content_hash: String) -> Option<String>
// Returns $APPDATA/gamechat/attachments/{hash[0:2]}/{hash}.bin if it exists

save_attachment_chunk(content_hash: String, chunk_index: u32, data: Vec<u8>) -> ()
// Write chunk to .part file; update bitfield; if all chunks received: rename to .bin

read_attachment_chunk(content_hash: String, chunk_index: u32) -> Option<Vec<u8>>
// Read and return chunk for seeding to requesting peer
```

---

## Attachment Type in TypeScript

```typescript
export interface Attachment {
  id:              string
  name:            string
  size:            number
  mimeType:        string
  // Phase 1 inline:
  inlineData?:     string        // base64
  // Phase 5b P2P:
  contentHash?:    string        // blake3:...
  chunkSize?:      number
  url?:            string        // blob: URI after download completes
  transferState:   'pending' | 'transferring' | 'complete' | 'failed' | 'inline'
}
```

---

## AttachmentPreview.vue

Renders attachment based on type:

| MIME prefix | Rendering |
|-------------|-----------|
| `image/*` | Inline image thumbnail, click to expand |
| `video/*` | Video thumbnail with play button |
| `audio/*` | Audio player bar |
| `application/pdf` | PDF icon + filename + size |
| Other | Generic file icon + filename + size + download button |

For external URLs: show preview only after user explicitly clicks "Load image" (privacy protection). Store consent per-URL in local settings.

Progress indicator shown during `transferState === 'transferring'`: animated progress bar with percentage and peer count ("downloading from 2 peers").
