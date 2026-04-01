# Spec 10 — Emoji System

> Parent: [Architecture Plan](../architecture-plan.md)

---

## 1. Storage: Files on Disk, Not SQLite Blobs

Custom emoji images are stored as files, not base64 in SQLite. A server with 100 emoji at ~15KB each would be 1.5MB loaded on every table query if stored inline.

**Layout**:
```
$APPDATA/gamechat/emoji/
  {serverId}/
    {emojiId}.webp      ← 128×128 WebP, 5–15KB each
```

The `custom_emoji` SQLite table stores only metadata + file path. `emojiStore` loads metadata on startup and lazily reads image bytes when the picker opens or an emoji appears in a message.

---

## 2. Custom Emoji Upload Flow

```typescript
async function uploadCustomEmoji(serverId: string, name: string, file: File): Promise<void> {
  // 1. Validate: PNG/WebP/GIF only, ≤256KB input
  if (!['image/png', 'image/webp', 'image/gif'].includes(file.type)) throw new Error('Invalid type')
  if (file.size > 256 * 1024) throw new Error('File too large')

  // 2. Resize to 128×128 via Canvas API → Blob (WebP, quality 0.85)
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 128
  const ctx = canvas.getContext('2d')!
  const img = await createImageBitmap(file)
  ctx.drawImage(img, 0, 0, 128, 128)
  const blob = await new Promise<Blob>(res => canvas.toBlob(res as any, 'image/webp', 0.85))

  // 3. Send to Rust: writes disk file + saves metadata row
  const id = uuidv7()
  const imageBytes = new Uint8Array(await blob.arrayBuffer())
  await invoke('db_save_emoji', {
    emoji: { id, serverId, name, uploadedBy: identityStore.userId, createdAt: new Date().toISOString() },
    imageBytes: Array.from(imageBytes)
  })

  // 4. Update emojiStore
  emojiStore.custom[serverId] ??= {}
  emojiStore.custom[serverId][id] = { id, serverId, name, uploadedBy: identityStore.userId!, createdAt: new Date().toISOString() }

  // 5. Broadcast metadata (NOT image bytes) to online members
  signalingService.broadcast({
    type: 'emoji_sync',
    serverId,
    emoji: { id, name, uploadedBy: identityStore.userId, createdAt: new Date().toISOString() }
  })
}
```

---

## 3. Gossip Distribution (Offline Members)

```typescript
// On reconnect: request full metadata from a random online peer
signalingService.send({ type: 'emoji_request', serverId, to: randomOnlinePeer.userId })

// Handling emoji_request: send metadata (no image bytes)
for (const emoji of Object.values(emojiStore.custom[serverId] ?? {})) {
  signalingService.send({ type: 'emoji_sync', serverId, emoji, to: from })
}

// Lazy image fetch: triggered when unknown emoji appears in rendered message
if (!emojiStore.imageCache[emojiId]) {
  signalingService.send({ type: 'emoji_image_request', emojiId, to: anyOnlinePeer.userId })
}
// Peer responds: { type: 'emoji_image', emojiId, imageBytes: base64 }
// Client: invoke('store_emoji_image', { emojiId, serverId, imageBytes })
//         emojiStore.imageCache[emojiId] = `data:image/webp;base64,${imageBytes}`
```

---

## 4. EmojiPicker.vue

- Teleported to `<body>`, absolutely positioned at anchor point
- Opens on click of emoji button in `MessageInput.vue` or emoji+ button on `ReactionBar.vue`
- Closes on outside click and Escape (uses existing ContextMenu pattern)

**Tab structure**:
1. **Recent** — last 20 used (from `emojiStore.recent`)
2. **{Server Name}** tabs — one per joined server with custom emoji (RecycleScroller grid, 8 columns)
3. **Unicode categories** — People, Nature, Food, etc. (from `emoji-data.json`)

**Search**: single input filters across all tabs simultaneously.

---

## 5. Unicode Emoji Data

Bundle `src/assets/emoji-data.json` (~80KB, ~1000 common emoji):

```json
[
  { "id": "1f600", "char": "😀", "name": "grinning_face", "category": "people" },
  { "id": "1f44d", "char": "👍", "name": "thumbs_up", "category": "people" },
  ...
]
```

Do not bundle a full emoji library (~1MB+). 1000 common emoji is sufficient for MVP.

---

## 6. Reaction Bar

Located in `ReactionBar.vue`, rendered below message content:

- **Display**: pill per distinct emoji with count (e.g. `😀 3`, `👍 1`)
- **Sort**: by count descending, then chronological order of first reaction
- **Max**: 20 distinct reactions per message (enforced in `addReaction`)
- **Self-reacted**: pill has highlighted border/background
- **Click**: add reaction if not self-reacted; remove if self-reacted
- **Emoji+ button**: opens EmojiPicker anchored to message for adding new reactions
- **Custom emoji**: displayed as `<img :src="imageCache[emojiId]">` from `emojiStore`
- **Optimistic**: reaction appears immediately; mutation saved to SQLite + broadcast async

---

## 7. Rust Commands

```rust
db_save_emoji(emoji: EmojiRow, image_bytes: Vec<u8>) -> ()
// 1. Write image to $APPDATA/gamechat/emoji/{serverId}/{emojiId}.webp
// 2. INSERT INTO custom_emoji (metadata only, no image_data column)

db_load_emoji(server_id: String) -> Vec<EmojiRow>
// Returns metadata only; image bytes loaded on demand

get_emoji_image(emoji_id: String, server_id: String) -> Vec<u8>
// fs::read($APPDATA/gamechat/emoji/{serverId}/{emojiId}.webp)

store_emoji_image(emoji_id: String, server_id: String, image_bytes: Vec<u8>) -> ()
// Write received peer image to disk (no DB row — metadata arrives via emoji_sync first)
```
