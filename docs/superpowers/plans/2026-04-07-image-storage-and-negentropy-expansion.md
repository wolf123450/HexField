# Content-Addressed Image Storage + Negentropy Sync Expansion

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move all image data (avatars, banners, server icons) from base64 data URLs in SQLite to content-addressed files on disk, then extend negentropy set-reconciliation to sync all persistent state — eliminating gossip for everything except pre-auth crypto bootstrap and ephemeral data (presence, typing, voice).

**Architecture:** Two-phase migration. Phase 1 moves image blobs to BLAKE3-hashed files in `$APPDATA/hexfield/attachments/` (reusing existing attachment infrastructure), referenced by hash in DB. Phase 2 extends the mutation log to cover member, channel, and emoji state changes — since mutations already sync via negentropy, this automatically gives us full state sync without gossip. Mutable tables (`members`, `channels`, `custom_emoji`) become materialized views rebuilt from mutations.

**Tech Stack:** Rust (rusqlite, blake3, tauri v2), TypeScript/Vue 3 (Pinia, Tauri IPC), negentropy-rs, existing attachment chunk protocol (attachment_want/have/chunk)

---

## Dependencies

Phase 2 depends on Phase 1: `member_profile_update` mutations reference `avatarHash` (not base64 data URLs), so images must be stored on disk first. Complete all Phase 1 tasks before starting Phase 2.

## Key Design Decisions

1. **Reuse attachment storage** — images go in the same `attachments/{hash[0:2]}/{hash}.bin` directory. No separate `images/` dir. Retention policy differentiation (attachments expire, avatars don't) is a future concern.

2. **Rendering via IPC data URL with cache** — `AvatarImage` calls `invoke('load_image_data_url', { contentHash })` once per hash; result cached in a `Map<hash, dataUrl>`. Simpler than configuring Tauri's asset protocol. Optimize to `convertFileSrc` later if needed.

3. **Mutation-log for mutable state** — rather than adding mutable tables to negentropy (which does set-difference and can't detect value changes), all state changes go through the `mutations` table as typed log entries (`member_join`, `member_profile_update`, `channel_create`, etc.). Since mutations already sync via negentropy, this gives us full sync for free.

4. **Backward-compatible migration** — old `avatar_data_url`/`banner_data_url` columns are kept during transition. A startup migration extracts existing data URLs to files and sets hash columns. The old columns are ignored after migration.

5. **Image transfer stays peer-to-peer** — when a peer receives a mutation containing `avatarHash`, they check if the file exists locally. If not, they request it via the existing `attachment_want → attachment_have → attachment_chunk` protocol. No new wire protocol needed.

## File Map

### New Files
| File | Responsibility |
|------|---------------|
| `src-tauri/migrations/011_image_hashes.sql` | Migration: add `avatar_hash`, `banner_hash` columns |
| `src/utils/imageCache.ts` | In-memory cache: `hash → dataUrl`, lazy IPC resolution |

### Modified Files — Phase 1 (Images)
| File | Changes |
|------|---------|
| `src-tauri/src/commands/attachment_commands.rs` | Add `save_image`, `load_image_data_url`, `migrate_data_urls_to_files` commands |
| `src-tauri/src/commands/mod.rs` | Re-export new commands |
| `src-tauri/src/lib.rs` | Register new commands in `invoke_handler` |
| `src-tauri/src/db/types.rs` | Add `avatar_hash`, `banner_hash` to `MemberRow`; add `avatar_hash` to `ServerRow` |
| `src-tauri/src/commands/db_commands.rs` | Update `db_load_members`, `db_upsert_member`, `db_load_servers` SQL; add `db_update_server_avatar_hash` |
| `src/components/AvatarImage.vue` | Add `hash` prop; resolve via `imageCache` |
| `src/components/modals/UserProfileModal.vue` | Upload → hash → save to disk → store hash |
| `src/components/modals/ServerSettingsModal.vue` | Upload → hash → save to disk → store hash |
| `src/stores/identityStore.ts` | `avatarHash` / `bannerHash` refs; load/save hash keys |
| `src/stores/serversStore.ts` | `avatarHash` per server; load/save hash |
| `src/stores/networkStore.ts` | Gossip sends hash instead of data URL; trigger attachment fetch on receipt |
| `src/types/core.ts` | Add `avatarHash`, `bannerHash` to `ServerMember`, `Server` |

### Modified Files — Phase 2 (Negentropy Expansion)
| File | Changes |
|------|---------|
| `src/types/core.ts` | Add `member_join`, `member_profile_update`, `emoji_add`, `emoji_remove` to `MutationType` |
| `src-tauri/src/commands/db_commands.rs` | Add side effects for new mutation types in `db_save_mutation` |
| `src/stores/channelsStore.ts` | `createChannel`/`deleteChannel` → create mutations; remove `receiveChannelGossip` |
| `src/stores/serversStore.ts` | Add `member_join`/`member_profile_update` mutation creation + apply; remove `upsertMember` gossip path |
| `src/stores/emojiStore.ts` | Emoji add/remove → mutations; remove `receiveEmojiSync` |
| `src/stores/networkStore.ts` | Remove gossip functions; update `onConnected`; add mutation hydration after sync |
| `src/services/syncService.ts` | After receiving synced mutations, trigger materialized table refresh |
| `src/utils/peerValidator.ts` | Remove validators for deleted gossip types; add validators for new types |

---

## Phase 1: Content-Addressed Image Storage

### Task 1: Rust Image Save/Load Commands

**Files:**
- Modify: `src-tauri/src/commands/attachment_commands.rs`
- Modify: `src-tauri/src/commands/mod.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Write Rust unit tests for save_image and load_image_data_url**

In `src-tauri/src/commands/attachment_commands.rs`, add at the bottom:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn test_save_image_returns_blake3_hash() {
        let dir = tempfile::tempdir().unwrap();
        let data = b"fake png content".to_vec();
        let expected_hash = blake3::hash(&data).to_hex().to_string();

        let hash = save_image_to(&dir.path().to_path_buf(), &data).unwrap();
        assert_eq!(hash, expected_hash);

        // File should exist at the expected path
        let file_path = bin_path(&dir.path().to_path_buf(), &hash);
        assert!(file_path.exists());
        assert_eq!(std::fs::read(&file_path).unwrap(), data);
    }

    #[test]
    fn test_save_image_idempotent() {
        let dir = tempfile::tempdir().unwrap();
        let data = b"same content".to_vec();

        let hash1 = save_image_to(&dir.path().to_path_buf(), &data).unwrap();
        let hash2 = save_image_to(&dir.path().to_path_buf(), &data).unwrap();
        assert_eq!(hash1, hash2);
    }

    #[test]
    fn test_load_image_data_url_png() {
        let dir = tempfile::tempdir().unwrap();
        // Minimal PNG magic bytes + content
        let mut data = vec![0x89, 0x50, 0x4E, 0x47]; // PNG magic
        data.extend_from_slice(b"rest of png");

        let hash = save_image_to(&dir.path().to_path_buf(), &data).unwrap();
        let data_url = load_image_data_url_from(&dir.path().to_path_buf(), &hash).unwrap();

        assert!(data_url.starts_with("data:image/png;base64,"));
    }

    #[test]
    fn test_load_image_data_url_gif() {
        let dir = tempfile::tempdir().unwrap();
        let mut data = b"GIF89a".to_vec(); // GIF magic
        data.extend_from_slice(b"rest of gif");

        let hash = save_image_to(&dir.path().to_path_buf(), &data).unwrap();
        let data_url = load_image_data_url_from(&dir.path().to_path_buf(), &hash).unwrap();

        assert!(data_url.starts_with("data:image/gif;base64,"));
    }

    #[test]
    fn test_load_image_not_found() {
        let dir = tempfile::tempdir().unwrap();
        let result = load_image_data_url_from(&dir.path().to_path_buf(), "nonexistent");
        assert!(result.is_err());
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd src-tauri && cargo test -- tests::test_save_image
```

Expected: compile errors — `save_image_to` and `load_image_data_url_from` don't exist yet.

- [ ] **Step 3: Implement save_image_to and load_image_data_url_from**

Add to `src-tauri/src/commands/attachment_commands.rs`, above the `#[cfg(test)]` block:

```rust
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};

/// Detect MIME type from file magic bytes.
fn detect_image_mime(data: &[u8]) -> &'static str {
    if data.starts_with(b"\x89PNG") {
        "image/png"
    } else if data.starts_with(b"GIF87a") || data.starts_with(b"GIF89a") {
        "image/gif"
    } else if data.starts_with(b"\xFF\xD8\xFF") {
        "image/jpeg"
    } else if data.len() >= 12 && &data[0..4] == b"RIFF" && &data[8..12] == b"WEBP" {
        "image/webp"
    } else {
        "application/octet-stream"
    }
}

/// Hash image data with BLAKE3, save to content-addressed storage, return hash.
pub(crate) fn save_image_to(dir: &PathBuf, data: &[u8]) -> Result<String, String> {
    let hash = blake3::hash(data).to_hex().to_string();
    save_attachment_to(dir, &hash, data)?;
    Ok(hash)
}

/// Load an image from content-addressed storage, return as `data:<mime>;base64,...` URL.
pub(crate) fn load_image_data_url_from(dir: &PathBuf, content_hash: &str) -> Result<String, String> {
    let path = bin_path(dir, content_hash);
    let data = std::fs::read(&path).map_err(|e| format!("image not found: {e}"))?;
    let mime = detect_image_mime(&data);
    let b64 = B64.encode(&data);
    Ok(format!("data:{};base64,{}", mime, b64))
}

#[tauri::command]
pub fn save_image(
    app_handle: tauri::AppHandle,
    data: Vec<u8>,
) -> Result<String, String> {
    let dir = attachments_dir(&app_handle)?;
    save_image_to(&dir, &data)
}

#[tauri::command]
pub fn load_image_data_url(
    app_handle: tauri::AppHandle,
    content_hash: String,
) -> Result<String, String> {
    let dir = attachments_dir(&app_handle)?;
    load_image_data_url_from(&dir, &content_hash)
}
```

Add to `Cargo.toml` (`base64` is already present):

```toml
[dev-dependencies]
tempfile = "3"
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd src-tauri && cargo test -- tests::test_save_image && cargo test -- tests::test_load_image
```

Expected: all 5 tests pass.

- [ ] **Step 5: Register commands and commit**

In `src-tauri/src/commands/mod.rs`, ensure `attachment_commands` is exported (it should already be).

In `src-tauri/src/lib.rs`, add `save_image` and `load_image_data_url` to the `invoke_handler![]` macro call:

```rust
save_image,
load_image_data_url,
```

```bash
cd src-tauri && cargo check
git add src-tauri/src/commands/attachment_commands.rs src-tauri/src/lib.rs src-tauri/Cargo.toml
git commit -m "feat: add save_image and load_image_data_url Rust commands"
```

---

### Task 2: DB Migration — Hash Columns

**Files:**
- Create: `src-tauri/migrations/011_image_hashes.sql`
- Modify: `src-tauri/src/db/migrations.rs`
- Modify: `src-tauri/src/db/types.rs`

- [ ] **Step 1: Create migration SQL**

```sql
-- 011: Add content-addressed hash columns for images.
-- Old avatar_data_url / banner_data_url columns are kept for backward compat
-- during migration; ignored after startup migration runs.
ALTER TABLE members ADD COLUMN avatar_hash TEXT;
ALTER TABLE members ADD COLUMN banner_hash TEXT;
ALTER TABLE servers ADD COLUMN avatar_hash TEXT;
```

- [ ] **Step 2: Register migration in migrations.rs**

Find the `Migrations::new(vec![...])` call in `src-tauri/src/db/migrations.rs`. Add a new entry at the end of the vector:

```rust
M::up(include_str!("../../migrations/011_image_hashes.sql")),
```

- [ ] **Step 3: Update MemberRow in types.rs**

Add two new fields to `MemberRow`:

```rust
pub struct MemberRow {
    pub user_id: String,
    pub server_id: String,
    pub display_name: String,
    pub roles: Option<String>,
    pub joined_at: String,
    pub public_sign_key: String,
    pub public_dh_key: String,
    pub online_status: String,
    pub avatar_data_url: Option<String>,
    pub bio: Option<String>,
    pub banner_color: Option<String>,
    pub banner_data_url: Option<String>,
    pub avatar_hash: Option<String>,    // NEW
    pub banner_hash: Option<String>,    // NEW
}
```

Add one field to `ServerRow` (or the struct used for server loading — check exact name):

```rust
pub avatar_hash: Option<String>,    // NEW
```

- [ ] **Step 4: Update SQL queries in db_commands.rs**

Update `db_load_members` SELECT to include new columns:

```sql
SELECT user_id, server_id, display_name, roles, joined_at,
       public_sign_key, public_dh_key, online_status, avatar_data_url,
       bio, banner_color, banner_data_url, avatar_hash, banner_hash
FROM members WHERE server_id = ?1
```

Update the row mapping to read the two new columns.

Update `db_upsert_member` INSERT to include new columns:

```sql
INSERT OR REPLACE INTO members
  (user_id, server_id, display_name, roles, joined_at, public_sign_key, public_dh_key,
   online_status, avatar_data_url, bio, banner_color, banner_data_url, avatar_hash, banner_hash)
VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)
```

- [ ] **Step 5: Verify and commit**

```bash
cd src-tauri && cargo check
git add src-tauri/migrations/011_image_hashes.sql src-tauri/src/db/migrations.rs \
        src-tauri/src/db/types.rs src-tauri/src/commands/db_commands.rs
git commit -m "feat: add avatar_hash/banner_hash columns to members and servers"
```

---

### Task 3: Frontend Image Cache Utility

**Files:**
- Create: `src/utils/imageCache.ts`
- Test: `src/utils/__tests__/imageCache.test.ts`

- [ ] **Step 1: Write failing test**

Create `src/utils/__tests__/imageCache.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}))

import { resolveImageHash, clearImageCache } from '../imageCache'
import { invoke } from '@tauri-apps/api/core'

const mockedInvoke = invoke as ReturnType<typeof vi.fn>

describe('imageCache', () => {
  beforeEach(() => {
    clearImageCache()
    mockedInvoke.mockReset()
  })

  it('calls invoke on first resolve and caches the result', async () => {
    mockedInvoke.mockResolvedValueOnce('data:image/png;base64,abc123')

    const result1 = await resolveImageHash('deadbeef')
    expect(result1).toBe('data:image/png;base64,abc123')
    expect(mockedInvoke).toHaveBeenCalledWith('load_image_data_url', { contentHash: 'deadbeef' })

    // Second call should NOT invoke again
    mockedInvoke.mockClear()
    const result2 = await resolveImageHash('deadbeef')
    expect(result2).toBe('data:image/png;base64,abc123')
    expect(mockedInvoke).not.toHaveBeenCalled()
  })

  it('returns null for null/undefined/empty hash', async () => {
    expect(await resolveImageHash(null)).toBeNull()
    expect(await resolveImageHash(undefined)).toBeNull()
    expect(await resolveImageHash('')).toBeNull()
    expect(mockedInvoke).not.toHaveBeenCalled()
  })

  it('returns null on invoke error (image not found)', async () => {
    mockedInvoke.mockRejectedValueOnce('image not found')
    const result = await resolveImageHash('missing')
    expect(result).toBeNull()
  })

  it('clearImageCache resets the cache', async () => {
    mockedInvoke.mockResolvedValue('data:image/png;base64,abc123')
    await resolveImageHash('deadbeef')

    clearImageCache()
    mockedInvoke.mockClear()
    mockedInvoke.mockResolvedValue('data:image/png;base64,xyz789')

    const result = await resolveImageHash('deadbeef')
    expect(result).toBe('data:image/png;base64,xyz789')
    expect(mockedInvoke).toHaveBeenCalledTimes(1)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm run test -- --run src/utils/__tests__/imageCache.test.ts
```

Expected: FAIL — module `../imageCache` not found.

- [ ] **Step 3: Implement imageCache.ts**

Create `src/utils/imageCache.ts`:

```typescript
import { invoke } from '@tauri-apps/api/core'

const cache = new Map<string, string>()
const inflight = new Map<string, Promise<string | null>>()

/**
 * Resolve a BLAKE3 content hash to a renderable data URL.
 * Results are cached in memory for the lifetime of the app session.
 * Returns null if hash is empty or the image file is not found on disk.
 */
export async function resolveImageHash(hash: string | null | undefined): Promise<string | null> {
  if (!hash) return null

  const cached = cache.get(hash)
  if (cached) return cached

  // Deduplicate concurrent requests for the same hash
  const existing = inflight.get(hash)
  if (existing) return existing

  const promise = invoke<string>('load_image_data_url', { contentHash: hash })
    .then((dataUrl) => {
      cache.set(hash, dataUrl)
      return dataUrl
    })
    .catch(() => null)
    .finally(() => inflight.delete(hash))

  inflight.set(hash, promise)
  return promise
}

/** Clear the in-memory cache. Called during testing or on logout. */
export function clearImageCache(): void {
  cache.clear()
  inflight.clear()
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npm run test -- --run src/utils/__tests__/imageCache.test.ts
```

Expected: all 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/utils/imageCache.ts src/utils/__tests__/imageCache.test.ts
git commit -m "feat: add imageCache utility for hash → data URL resolution"
```

---

### Task 4: AvatarImage Component — Hash Support

**Files:**
- Modify: `src/components/AvatarImage.vue`
- Test: `src/components/__tests__/AvatarImage.test.ts` (create if not exists)

- [ ] **Step 1: Write failing test**

Create `src/components/__tests__/AvatarImage.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import AvatarImage from '../AvatarImage.vue'

vi.mock('@/utils/imageCache', () => ({
  resolveImageHash: vi.fn(),
}))

import { resolveImageHash } from '@/utils/imageCache'
const mockedResolve = resolveImageHash as ReturnType<typeof vi.fn>

describe('AvatarImage', () => {
  beforeEach(() => {
    mockedResolve.mockReset()
  })

  it('renders initials when no src and no hash', () => {
    const wrapper = mount(AvatarImage, { props: { name: 'Alice Bob' } })
    expect(wrapper.find('.avatar-initials').text()).toBe('AB')
    expect(wrapper.find('img').exists()).toBe(false)
  })

  it('renders img when src is provided (backward compat)', () => {
    const wrapper = mount(AvatarImage, {
      props: { src: 'data:image/png;base64,abc', name: 'Test' },
    })
    expect(wrapper.find('img').exists()).toBe(true)
    expect(wrapper.find('img').attributes('src')).toBe('data:image/png;base64,abc')
  })

  it('resolves hash via imageCache and renders img', async () => {
    mockedResolve.mockResolvedValueOnce('data:image/png;base64,resolved')

    const wrapper = mount(AvatarImage, {
      props: { hash: 'deadbeef', name: 'Hash User' },
    })

    expect(mockedResolve).toHaveBeenCalledWith('deadbeef')

    await flushPromises()

    expect(wrapper.find('img').exists()).toBe(true)
    expect(wrapper.find('img').attributes('src')).toBe('data:image/png;base64,resolved')
  })

  it('shows initials when hash resolves to null', async () => {
    mockedResolve.mockResolvedValueOnce(null)

    const wrapper = mount(AvatarImage, {
      props: { hash: 'missing', name: 'No Avatar' },
    })

    await flushPromises()

    expect(wrapper.find('.avatar-initials').text()).toBe('NA')
    expect(wrapper.find('img').exists()).toBe(false)
  })

  it('prefers hash over src when both provided', async () => {
    mockedResolve.mockResolvedValueOnce('data:image/png;base64,from-hash')

    const wrapper = mount(AvatarImage, {
      props: { src: 'data:image/png;base64,from-src', hash: 'abc', name: 'T' },
    })

    await flushPromises()

    expect(wrapper.find('img').attributes('src')).toBe('data:image/png;base64,from-hash')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm run test -- --run src/components/__tests__/AvatarImage.test.ts
```

Expected: FAIL — `hash` prop not recognized; `resolveImageHash` never called.

- [ ] **Step 3: Update AvatarImage.vue**

Add hash-based resolution to `AvatarImage.vue`. Changes:

1. Add `hash` prop to the `defineProps`:

```typescript
const props = withDefaults(defineProps<{
  src?: string | null
  hash?: string | null    // NEW: BLAKE3 content hash — resolved via imageCache
  name?: string
  size?: number
  animate?: boolean
}>(), {
  src: null,
  hash: null,
  name: '',
  size: 32,
  animate: false,
})
```

2. Add hash resolution logic in `<script setup>`:

```typescript
import { resolveImageHash } from '@/utils/imageCache'

const hashResolvedSrc = ref<string | null>(null)

watch(() => props.hash, async (newHash) => {
  if (newHash) {
    hashResolvedSrc.value = await resolveImageHash(newHash)
  } else {
    hashResolvedSrc.value = null
  }
}, { immediate: true })
```

3. Update `resolvedSrc` to prefer hash over src:

```typescript
const resolvedSrc = computed(() => hashResolvedSrc.value || props.src || null)
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm run test -- --run src/components/__tests__/AvatarImage.test.ts
```

Expected: all 5 tests pass.

- [ ] **Step 5: Build check and commit**

```bash
npx vue-tsc --noEmit
git add src/components/AvatarImage.vue src/components/__tests__/AvatarImage.test.ts
git commit -m "feat: AvatarImage supports hash prop for content-addressed images"
```

---

### Task 5: TypeScript Interface Updates

**Files:**
- Modify: `src/types/core.ts`

- [ ] **Step 1: Add hash fields to ServerMember**

Find the `ServerMember` interface and add:

```typescript
export interface ServerMember {
  // ... existing fields ...
  avatarDataUrl?: string    // DEPRECATED — use avatarHash
  avatarHash?: string       // NEW: BLAKE3 hash of avatar image on disk
  bio?: string
  bannerColor?: string
  bannerDataUrl?: string    // DEPRECATED — use bannerHash
  bannerHash?: string       // NEW: BLAKE3 hash of banner image on disk
}
```

- [ ] **Step 2: Add hash field to Server**

Find the `Server` interface and add:

```typescript
export interface Server {
  // ... existing fields ...
  avatarDataUrl?: string    // DEPRECATED — use avatarHash
  avatarHash?: string       // NEW: BLAKE3 hash of server icon on disk
}
```

- [ ] **Step 3: Build check and commit**

```bash
npx vue-tsc --noEmit
git add src/types/core.ts
git commit -m "feat: add avatarHash/bannerHash fields to ServerMember and Server interfaces"
```

---

### Task 6: Identity Store — Hash-Based Avatar Storage

**Files:**
- Modify: `src/stores/identityStore.ts`

- [ ] **Step 1: Add hash refs alongside existing data URL refs**

Add new refs:

```typescript
const avatarHash     = ref<string | null>(null)
const bannerHash     = ref<string | null>(null)
```

- [ ] **Step 2: Update initializeIdentity to load hashes**

After the existing `db_load_key` calls for `local_avatar_data`, add:

```typescript
const existingAvatarHash = await invoke<string | null>('db_load_key', { keyId: 'local_avatar_hash' })
  .catch(() => null)
if (existingAvatarHash) avatarHash.value = existingAvatarHash

const existingBannerHash = await invoke<string | null>('db_load_key', { keyId: 'local_banner_hash' })
  .catch(() => null)
if (existingBannerHash) bannerHash.value = existingBannerHash
```

- [ ] **Step 3: Add updateAvatarHash action**

```typescript
async function updateAvatarHash(hash: string) {
  avatarHash.value = hash
  avatarDataUrl.value = null  // Clear deprecated field
  await invoke('db_save_key', { keyId: 'local_avatar_hash', keyType: 'avatar_hash', keyData: hash })
}

async function updateBannerHash(hash: string | null) {
  bannerHash.value = hash
  bannerDataUrl.value = null
  if (hash) {
    await invoke('db_save_key', { keyId: 'local_banner_hash', keyType: 'banner_hash', keyData: hash })
  }
}
```

- [ ] **Step 4: Expose new refs and actions in store return**

Add `avatarHash`, `bannerHash`, `updateAvatarHash`, `updateBannerHash` to the return object.

- [ ] **Step 5: Build check and commit**

```bash
npx vue-tsc --noEmit
git add src/stores/identityStore.ts
git commit -m "feat: identityStore supports hash-based avatar/banner storage"
```

---

### Task 7: Upload Flow — UserProfileModal

**Files:**
- Modify: `src/components/modals/UserProfileModal.vue`

- [ ] **Step 1: Update saveAvatar to write file to disk and store hash**

Replace the existing `saveAvatar` function body. The new flow:
1. Convert data URL to bytes
2. `invoke('save_image', { data: bytes })` → returns hash
3. `identityStore.updateAvatarHash(hash)`
4. Update member records with hash
5. Broadcast profile with hash

```typescript
async function saveAvatar(dataUrl: string) {
  // Convert data URL to bytes for disk storage
  const base64 = dataUrl.split(',')[1]
  const binaryStr = atob(base64)
  const bytes = new Uint8Array(binaryStr.length)
  for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i)

  const { invoke } = await import('@tauri-apps/api/core')
  const hash = await invoke<string>('save_image', { data: Array.from(bytes) })

  // Store hash (replaces old data URL persistence)
  await identityStore.updateAvatarHash(hash)

  // Update self in all server member lists
  const uid = identityStore.userId
  if (uid) {
    for (const sid of serversStore.joinedServerIds) {
      const m = serversStore.members[sid]?.[uid]
      if (m) {
        m.avatarHash = hash
        m.avatarDataUrl = undefined
      }
    }
  }

  // Broadcast to peers — send hash, not data URL
  networkStore.broadcastProfile({ avatarHash: hash }).catch(() => {})
}
```

- [ ] **Step 2: Update saveBanner similarly**

If the modal has a banner upload flow, apply the same pattern: data URL → bytes → `save_image` → hash → `identityStore.updateBannerHash(hash)`.

- [ ] **Step 3: Build check and commit**

```bash
npx vue-tsc --noEmit
git add src/components/modals/UserProfileModal.vue
git commit -m "feat: avatar upload saves to disk with content hash"
```

---

### Task 8: Upload Flow — ServerSettingsModal

**Files:**
- Modify: `src/components/modals/ServerSettingsModal.vue`

- [ ] **Step 1: Update onIconSelected to write file to disk and store hash**

Replace the avatar/icon persistence in `onIconSelected`. After the canvas/GIF processing produces a `dataUrl`:

```typescript
async function saveServerIcon(serverId: string, dataUrl: string) {
  const base64 = dataUrl.split(',')[1]
  const binaryStr = atob(base64)
  const bytes = new Uint8Array(binaryStr.length)
  for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i)

  const { invoke } = await import('@tauri-apps/api/core')
  const hash = await invoke<string>('save_image', { data: Array.from(bytes) })

  await serversStore.updateServerAvatarHash(serverId, hash)
  networkStore.broadcastServerAvatar(serverId, hash).catch(() => {})
}
```

Update the `onIconSelected` function to call `saveServerIcon(sid, dataUrl)` instead of `serversStore.updateServerAvatar(sid, dataUrl)`.

- [ ] **Step 2: Build check and commit**

```bash
npx vue-tsc --noEmit
git add src/components/modals/ServerSettingsModal.vue
git commit -m "feat: server icon upload saves to disk with content hash"
```

---

### Task 9: Servers Store — Hash-Based Server Icons

**Files:**
- Modify: `src/stores/serversStore.ts`

- [ ] **Step 1: Add updateServerAvatarHash action**

```typescript
async function updateServerAvatarHash(serverId: string, hash: string | null) {
  if (servers.value[serverId]) {
    servers.value[serverId].avatarHash = hash
    servers.value[serverId].avatarDataUrl = undefined
  }
  await invoke('db_save_key', {
    keyId:   `server_avatar_hash_${serverId}`,
    keyType: 'server_avatar_hash',
    keyData: hash ?? '',
  })
}
```

- [ ] **Step 2: Update loadServers to load hash keys**

After the existing server avatar loading loop, add hash loading:

```typescript
for (const serverId of joinedServerIds.value) {
  const hash = await invoke<string | null>('db_load_key', { keyId: `server_avatar_hash_${serverId}` })
    .catch(() => null)
  if (hash && servers.value[serverId]) {
    servers.value[serverId].avatarHash = hash
  }
}
```

- [ ] **Step 3: Expose action and commit**

Add `updateServerAvatarHash` to the store's return object.

```bash
npx vue-tsc --noEmit
git add src/stores/serversStore.ts
git commit -m "feat: serversStore supports hash-based server icons"
```

---

### Task 10: Gossip Layer — Send Hash + Trigger Attachment Fetch

**Files:**
- Modify: `src/stores/networkStore.ts`

- [ ] **Step 1: Update gossipOwnProfile to send hash**

In `gossipOwnProfile`, change the payload to include hash instead of data URL:

```typescript
async function gossipOwnProfile(peerId: string) {
  const { useIdentityStore } = await import('./identityStore')
  const identityStore = useIdentityStore()
  webrtcService.sendToPeer(peerId, {
    type: 'profile_update',
    payload: {
      displayName:   identityStore.displayName,
      avatarHash:    identityStore.avatarHash,      // hash instead of data URL
      bio:           identityStore.bio,
      bannerColor:   identityStore.bannerColor,
      bannerHash:    identityStore.bannerHash,       // hash instead of data URL
    },
  })
}
```

- [ ] **Step 2: Update broadcastProfile to accept hash fields**

`broadcastProfile` is called from upload flows — it already accepts a payload object, so the callers just need to pass `{ avatarHash }` instead of `{ avatarDataUrl }` (done in Task 7).

- [ ] **Step 3: Update handleProfileUpdate to fetch images**

In `handleProfileUpdate`, add image fetching logic:

```typescript
async function handleProfileUpdate(userId: string, msg: Record<string, unknown>) {
  const payload = msg.payload as Record<string, unknown>
  if (!payload || typeof payload !== 'object') return

  const { useServersStore } = await import('./serversStore')
  const serversStore = useServersStore()

  // Apply text fields immediately
  serversStore.updateMemberProfile(userId, {
    displayName:  payload.displayName as string | undefined,
    avatarHash:   payload.avatarHash as string | undefined,
    bio:          payload.bio as string | undefined,
    bannerColor:  payload.bannerColor as string | undefined,
    bannerHash:   payload.bannerHash as string | undefined,
  })

  // Trigger attachment protocol for images we don't have locally
  const hashesToFetch = [payload.avatarHash, payload.bannerHash].filter(Boolean) as string[]
  for (const hash of hashesToFetch) {
    const has = await invoke<boolean>('has_attachment', { contentHash: hash }).catch(() => false)
    if (!has) {
      broadcast({ type: 'attachment_want', contentHash: hash, messageId: '' })
    }
  }
}
```

- [ ] **Step 4: Update gossipServerAvatars to send hash**

```typescript
async function gossipServerAvatars(peerId: string) {
  const { useServersStore } = await import('./serversStore')
  const serversStore = useServersStore()
  for (const sid of serversStore.joinedServerIds) {
    const avatarHash = serversStore.servers[sid]?.avatarHash
    if (avatarHash) {
      webrtcService.sendToPeer(peerId, { type: 'server_avatar_update', serverId: sid, avatarHash })
    }
  }
}
```

- [ ] **Step 5: Update handleServerAvatarUpdate to accept hash**

```typescript
async function handleServerAvatarUpdate(msg: Record<string, unknown>) {
  const serverId  = msg.serverId as string | undefined
  const avatarHash = msg.avatarHash as string | undefined
  if (!serverId) return

  const { useServersStore } = await import('./serversStore')
  const serversStore = useServersStore()
  if (serversStore.joinedServerIds.includes(serverId) && avatarHash) {
    serversStore.updateServerAvatarHash(serverId, avatarHash)

    // Fetch image if not local
    const has = await invoke<boolean>('has_attachment', { contentHash: avatarHash }).catch(() => false)
    if (!has) {
      broadcast({ type: 'attachment_want', contentHash: avatarHash, messageId: '' })
    }
  }
}
```

- [ ] **Step 6: Update gossipOwnMembership to include hash**

In `gossipOwnMembership`, the member objects sent should include `avatarHash` instead of `avatarDataUrl`:

```typescript
// When building member objects for gossip:
const memberData = {
  userId: m.userId,
  serverId: m.serverId,
  displayName: m.displayName,
  roles: m.roles,
  joinedAt: m.joinedAt,
  publicSignKey: m.publicSignKey,
  publicDHKey: m.publicDHKey,
  onlineStatus: m.onlineStatus,
  avatarHash: m.avatarHash,  // hash instead of data URL
}
```

- [ ] **Step 7: Update serversStore.updateMemberProfile to accept hashes**

In `serversStore.ts`, update `updateMemberProfile` to handle `avatarHash` and `bannerHash` fields from the payload. Persist to DB via `db_upsert_member` with the hash columns.

- [ ] **Step 8: Build check and commit**

```bash
npx vue-tsc --noEmit
git add src/stores/networkStore.ts src/stores/serversStore.ts
git commit -m "feat: gossip sends image hashes, receivers fetch via attachment protocol"
```

---

### Task 11: Update All AvatarImage Callers

**Files:**
- Modify: Components that pass `src` prop to `<AvatarImage>` for member/server avatars

- [ ] **Step 1: Search for all AvatarImage usage**

```bash
grep -rn "AvatarImage" src/components/ src/views/ --include="*.vue" | grep -v "import\|test\|__tests__"
```

- [ ] **Step 2: Update callers to pass hash prop**

For each `<AvatarImage :src="member.avatarDataUrl" ...>`, change to:

```vue
<AvatarImage :hash="member.avatarHash" :src="member.avatarDataUrl" :name="member.displayName" />
```

This provides backward compatibility: if `avatarHash` is set, it's preferred (Task 4 logic); otherwise falls back to `avatarDataUrl`.

Key locations to update:
- `MessageBubble.vue` — author avatar
- `MemberList.vue` — member list avatars
- `ChannelSidebar.vue` — voice participants, server header
- `ServerRail.vue` — server icons
- `Settings.vue` (profile section) — own avatar
- Any modal that shows user/server avatars

For server icons in `ServerRail.vue`:
```vue
<AvatarImage :hash="server.avatarHash" :src="server.avatarDataUrl" :name="server.name" />
```

- [ ] **Step 3: Build check and commit**

```bash
npx vue-tsc --noEmit
git add src/components/ src/views/
git commit -m "feat: pass avatarHash to AvatarImage throughout the UI"
```

---

### Task 12: One-Time Data URL Migration

**Files:**
- Modify: `src-tauri/src/commands/attachment_commands.rs` (add migration command)
- Modify: `src-tauri/src/lib.rs` (register command)
- Modify: `src/main.ts` or `src/stores/identityStore.ts` (call on startup)

- [ ] **Step 1: Write Rust migration command**

Add to `attachment_commands.rs`:

```rust
#[tauri::command]
pub fn migrate_data_urls_to_files(
    app_handle: tauri::AppHandle,
    state: tauri::State<AppState>,
) -> Result<u32, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let dir = attachments_dir(&app_handle)?;
    let mut migrated: u32 = 0;

    // Migrate member avatars
    let mut stmt = conn.prepare(
        "SELECT user_id, server_id, avatar_data_url FROM members WHERE avatar_data_url IS NOT NULL AND avatar_hash IS NULL"
    ).map_err(|e| e.to_string())?;
    let rows: Vec<(String, String, String)> = stmt.query_map([], |row| {
        Ok((row.get(0)?, row.get(1)?, row.get(2)?))
    }).map_err(|e| e.to_string())?
      .collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?;
    drop(stmt);

    for (user_id, server_id, data_url) in &rows {
        if let Some(bytes) = decode_data_url(data_url) {
            if let Ok(hash) = save_image_to(&dir, &bytes) {
                let _ = conn.execute(
                    "UPDATE members SET avatar_hash = ?1 WHERE user_id = ?2 AND server_id = ?3",
                    rusqlite::params![hash, user_id, server_id],
                );
                migrated += 1;
            }
        }
    }

    // Migrate member banners
    let mut stmt = conn.prepare(
        "SELECT user_id, server_id, banner_data_url FROM members WHERE banner_data_url IS NOT NULL AND banner_hash IS NULL"
    ).map_err(|e| e.to_string())?;
    let banner_rows: Vec<(String, String, String)> = stmt.query_map([], |row| {
        Ok((row.get(0)?, row.get(1)?, row.get(2)?))
    }).map_err(|e| e.to_string())?
      .collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?;
    drop(stmt);

    for (user_id, server_id, data_url) in &banner_rows {
        if let Some(bytes) = decode_data_url(data_url) {
            if let Ok(hash) = save_image_to(&dir, &bytes) {
                let _ = conn.execute(
                    "UPDATE members SET banner_hash = ?1 WHERE user_id = ?2 AND server_id = ?3",
                    rusqlite::params![hash, user_id, server_id],
                );
                migrated += 1;
            }
        }
    }

    // Migrate key_store avatar/banner entries
    let mut stmt = conn.prepare(
        "SELECT key_id, key_data FROM key_store WHERE key_type IN ('avatar', 'banner_data', 'server_avatar') AND key_data LIKE 'data:%'"
    ).map_err(|e| e.to_string())?;
    let key_rows: Vec<(String, String)> = stmt.query_map([], |row| {
        Ok((row.get(0)?, row.get(1)?))
    }).map_err(|e| e.to_string())?
      .collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?;
    drop(stmt);

    for (key_id, data_url) in &key_rows {
        if let Some(bytes) = decode_data_url(&data_url) {
            if let Ok(hash) = save_image_to(&dir, &bytes) {
                // Save hash in a parallel key (e.g. local_avatar_data → local_avatar_hash)
                let hash_key = key_id.replace("_data", "_hash")
                    .replace("server_avatar_", "server_avatar_hash_");
                let _ = conn.execute(
                    "INSERT OR REPLACE INTO key_store (key_id, key_type, key_data, created_at) VALUES (?1, ?2, ?3, datetime('now'))",
                    rusqlite::params![hash_key, "hash", hash],
                );
                migrated += 1;
            }
        }
    }

    Ok(migrated)
}

/// Decode a `data:<mime>;base64,<content>` URL into raw bytes.
fn decode_data_url(data_url: &str) -> Option<Vec<u8>> {
    let parts: Vec<&str> = data_url.splitn(2, ',').collect();
    if parts.len() != 2 { return None; }
    B64.decode(parts[1]).ok()
}
```

- [ ] **Step 2: Register command**

Add `migrate_data_urls_to_files` to `invoke_handler![]` in `lib.rs`.

- [ ] **Step 3: Call migration on app startup**

In `src/stores/identityStore.ts`, at the end of `initializeIdentity()`:

```typescript
// One-time migration: convert existing data URL images to disk files
try {
  const migrated = await invoke<number>('migrate_data_urls_to_files')
  if (migrated > 0) {
    console.log(`[identity] migrated ${migrated} data URL images to disk`)
    // Reload hashes after migration
    const newAvatarHash = await invoke<string | null>('db_load_key', { keyId: 'local_avatar_hash' })
      .catch(() => null)
    if (newAvatarHash) avatarHash.value = newAvatarHash
  }
} catch (e) {
  console.warn('[identity] data URL migration failed:', e)
}
```

- [ ] **Step 4: Build check and commit**

```bash
cd src-tauri && cargo check && cd .. && npx vue-tsc --noEmit
git add src-tauri/src/commands/attachment_commands.rs src-tauri/src/lib.rs src/stores/identityStore.ts
git commit -m "feat: one-time migration of data URL images to content-addressed disk files"
```

---

## Phase 2: Negentropy Sync for All Persistent State

### Architectural Overview

Currently, only `messages` and `mutations` sync via negentropy. This phase makes ALL persistent state changes go through the `mutations` table. Since mutations already sync via negentropy, this gives us full-state sync for free.

**New mutation types to add:**
- `member_join` — peer joins server, carries initial member data
- `member_profile_update` — display name, avatar hash, bio, banner changes
- `emoji_add` — new custom emoji (carries metadata; image transfers via attachment protocol)
- `emoji_remove` — emoji deleted

**Existing mutation types that already work but aren't created by code:**
- `channel_create` — apply logic exists in `channelsStore.applyChannelMutation()` but `createChannel()` uses gossip instead
- `channel_update` — apply logic exists
- `channel_delete` — apply logic exists
- `device_attest` — Rust side effect exists in `db_save_mutation`
- `device_revoke` — Rust side effect exists

**Pattern for each:** create mutation → `applyMutation()` (persist + in-memory) → `broadcast({ type: 'mutation', mutation })` → peers receive via `handleMutationMessage` → Rust side effects in `db_save_mutation`.

---

### Task 13: Add New Mutation Types

**Files:**
- Modify: `src/types/core.ts`

- [ ] **Step 1: Add new types to MutationType union**

```typescript
export type MutationType =
  | 'edit' | 'delete' | 'reaction_add' | 'reaction_remove'
  | 'server_update' | 'server_rebaseline'
  | 'role_assign' | 'role_revoke'
  | 'channel_create' | 'channel_update' | 'channel_delete' | 'channel_acl_update'
  | 'device_attest' | 'device_revoke'
  | 'member_kick' | 'member_ban' | 'member_unban'
  | 'member_join' | 'member_profile_update'          // NEW
  | 'emoji_add' | 'emoji_remove'                      // NEW
  | 'voice_kick' | 'voice_mute' | 'voice_unmute'
  | 'access_mode_update'
```

- [ ] **Step 2: Build check and commit**

```bash
npx vue-tsc --noEmit
git add src/types/core.ts
git commit -m "feat: add member_join, member_profile_update, emoji_add, emoji_remove mutation types"
```

---

### Task 14: Rust Side Effects for New Mutation Types

**Files:**
- Modify: `src-tauri/src/commands/db_commands.rs`

- [ ] **Step 1: Write test for member_join side effect**

Add to the test module in `db_commands.rs` (or a separate test file):

```rust
#[cfg(test)]
mod mutation_side_effect_tests {
    use super::*;

    fn test_conn() -> rusqlite::Connection {
        let mut conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::db::migrations::run(&mut conn);
        // Insert a test server so FK constraints pass
        conn.execute(
            "INSERT INTO servers (id, name, owner_id, created_at, raw_json) VALUES ('s1', 'Test', 'u1', '2024-01-01', '{}')",
            [],
        ).unwrap();
        conn
    }

    #[test]
    fn test_member_join_creates_member_row() {
        let conn = test_conn();
        // ... save mutation with type member_join, verify member row exists
        let mutation = MutationRow {
            id: "m1".into(),
            mutation_type: "member_join".into(),
            target_id: "user42".into(),
            channel_id: "__server__".into(),
            author_id: "user42".into(),
            new_content: Some(r#"{"userId":"user42","serverId":"s1","displayName":"Alice","publicSignKey":"pk1","publicDHKey":"dk1","roles":["member"],"joinedAt":"2024-01-01T00:00:00Z"}"#.into()),
            emoji_id: None,
            logical_ts: "1000-000000".into(),
            created_at: "2024-01-01T00:00:00Z".into(),
            verified: true,
        };
        // Call the side-effect logic directly
        apply_mutation_side_effects(&conn, &mutation).unwrap();

        let display_name: String = conn.query_row(
            "SELECT display_name FROM members WHERE user_id = 'user42' AND server_id = 's1'",
            [], |r| r.get(0),
        ).unwrap();
        assert_eq!(display_name, "Alice");
    }

    #[test]
    fn test_member_profile_update_sets_hash() {
        let conn = test_conn();
        // Pre-insert a member
        conn.execute(
            "INSERT INTO members (user_id, server_id, display_name, roles, joined_at, public_sign_key, public_dh_key, online_status) VALUES ('u1', 's1', 'Old', '[]', '2024-01-01', 'pk', 'dk', 'online')",
            [],
        ).unwrap();

        let mutation = MutationRow {
            id: "m2".into(),
            mutation_type: "member_profile_update".into(),
            target_id: "u1".into(),
            channel_id: "__server__".into(),
            author_id: "u1".into(),
            new_content: Some(r#"{"serverId":"s1","displayName":"New","avatarHash":"abc123"}"#.into()),
            emoji_id: None,
            logical_ts: "2000-000000".into(),
            created_at: "2024-06-01T00:00:00Z".into(),
            verified: true,
        };
        apply_mutation_side_effects(&conn, &mutation).unwrap();

        let (name, hash): (String, Option<String>) = conn.query_row(
            "SELECT display_name, avatar_hash FROM members WHERE user_id = 'u1' AND server_id = 's1'",
            [], |r| Ok((r.get(0)?, r.get(1)?)),
        ).unwrap();
        assert_eq!(name, "New");
        assert_eq!(hash, Some("abc123".into()));
    }

    #[test]
    fn test_channel_create_inserts_channel() {
        let conn = test_conn();
        let mutation = MutationRow {
            id: "m3".into(),
            mutation_type: "channel_create".into(),
            target_id: "ch1".into(),
            channel_id: "__server__".into(),
            author_id: "u1".into(),
            new_content: Some(r#"{"id":"ch1","serverId":"s1","name":"general","type":"text","position":0}"#.into()),
            emoji_id: None,
            logical_ts: "1000-000000".into(),
            created_at: "2024-01-01T00:00:00Z".into(),
            verified: true,
        };
        apply_mutation_side_effects(&conn, &mutation).unwrap();

        let name: String = conn.query_row(
            "SELECT name FROM channels WHERE id = 'ch1'", [], |r| r.get(0),
        ).unwrap();
        assert_eq!(name, "general");
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd src-tauri && cargo test -- mutation_side_effect_tests
```

Expected: FAIL — `apply_mutation_side_effects` doesn't exist.

- [ ] **Step 3: Extract side effects into a helper function and add new cases**

Refactor `db_save_mutation` to extract the `match mutation.mutation_type.as_str()` block into a standalone function. Then add cases:

```rust
fn apply_mutation_side_effects(
    conn: &rusqlite::Connection,
    mutation: &MutationRow,
) -> Result<(), String> {
    match mutation.mutation_type.as_str() {
        // ... existing cases (delete, edit, server_update, role_assign, etc.) ...

        "member_join" => {
            if let Some(new_content) = &mutation.new_content {
                if let Ok(payload) = serde_json::from_str::<serde_json::Value>(new_content) {
                    let user_id = payload.get("userId").and_then(|v| v.as_str()).unwrap_or("");
                    let server_id = payload.get("serverId").and_then(|v| v.as_str()).unwrap_or("");
                    let display_name = payload.get("displayName").and_then(|v| v.as_str()).unwrap_or("");
                    let public_sign_key = payload.get("publicSignKey").and_then(|v| v.as_str()).unwrap_or("");
                    let public_dh_key = payload.get("publicDHKey").and_then(|v| v.as_str()).unwrap_or("");
                    let roles = payload.get("roles").map(|v| v.to_string()).unwrap_or_else(|| "[]".into());
                    let joined_at = payload.get("joinedAt").and_then(|v| v.as_str()).unwrap_or(&mutation.created_at);

                    conn.execute(
                        "INSERT OR IGNORE INTO members
                         (user_id, server_id, display_name, roles, joined_at,
                          public_sign_key, public_dh_key, online_status)
                         VALUES (?1,?2,?3,?4,?5,?6,?7,'offline')",
                        rusqlite::params![user_id, server_id, display_name, roles, joined_at,
                                          public_sign_key, public_dh_key],
                    ).map_err(|e| e.to_string())?;
                }
            }
        }

        "member_profile_update" => {
            if let Some(new_content) = &mutation.new_content {
                if let Ok(patch) = serde_json::from_str::<serde_json::Value>(new_content) {
                    let server_id = patch.get("serverId").and_then(|v| v.as_str()).unwrap_or("");
                    let target_id = &mutation.target_id;

                    if let Some(name) = patch.get("displayName").and_then(|v| v.as_str()) {
                        conn.execute(
                            "UPDATE members SET display_name = ?1 WHERE user_id = ?2 AND server_id = ?3",
                            [name, target_id, server_id],
                        ).map_err(|e| e.to_string())?;
                    }
                    if let Some(hash) = patch.get("avatarHash").and_then(|v| v.as_str()) {
                        conn.execute(
                            "UPDATE members SET avatar_hash = ?1 WHERE user_id = ?2 AND server_id = ?3",
                            [hash, target_id, server_id],
                        ).map_err(|e| e.to_string())?;
                    }
                    if let Some(bio) = patch.get("bio").and_then(|v| v.as_str()) {
                        conn.execute(
                            "UPDATE members SET bio = ?1 WHERE user_id = ?2 AND server_id = ?3",
                            [bio, target_id, server_id],
                        ).map_err(|e| e.to_string())?;
                    }
                    if let Some(hash) = patch.get("bannerHash").and_then(|v| v.as_str()) {
                        conn.execute(
                            "UPDATE members SET banner_hash = ?1 WHERE user_id = ?2 AND server_id = ?3",
                            [hash, target_id, server_id],
                        ).map_err(|e| e.to_string())?;
                    }
                    if let Some(color) = patch.get("bannerColor").and_then(|v| v.as_str()) {
                        conn.execute(
                            "UPDATE members SET banner_color = ?1 WHERE user_id = ?2 AND server_id = ?3",
                            [color, target_id, server_id],
                        ).map_err(|e| e.to_string())?;
                    }
                }
            }
        }

        "channel_create" => {
            if let Some(new_content) = &mutation.new_content {
                if let Ok(ch) = serde_json::from_str::<serde_json::Value>(new_content) {
                    let id = ch.get("id").and_then(|v| v.as_str()).unwrap_or("");
                    let server_id = ch.get("serverId").and_then(|v| v.as_str()).unwrap_or("");
                    let name = ch.get("name").and_then(|v| v.as_str()).unwrap_or("");
                    let ch_type = ch.get("type").and_then(|v| v.as_str()).unwrap_or("text");
                    let position = ch.get("position").and_then(|v| v.as_i64()).unwrap_or(0);
                    let topic = ch.get("topic").and_then(|v| v.as_str());

                    conn.execute(
                        "INSERT OR IGNORE INTO channels (id, server_id, name, type, position, topic, created_at)
                         VALUES (?1,?2,?3,?4,?5,?6,?7)",
                        rusqlite::params![id, server_id, name, ch_type, position, topic, mutation.created_at],
                    ).map_err(|e| e.to_string())?;
                }
            }
        }

        "channel_update" => {
            if let Some(new_content) = &mutation.new_content {
                if let Ok(patch) = serde_json::from_str::<serde_json::Value>(new_content) {
                    if let Some(name) = patch.get("name").and_then(|v| v.as_str()) {
                        conn.execute(
                            "UPDATE channels SET name = ?1 WHERE id = ?2",
                            [name, &mutation.target_id],
                        ).map_err(|e| e.to_string())?;
                    }
                    if let Some(topic) = patch.get("topic").and_then(|v| v.as_str()) {
                        conn.execute(
                            "UPDATE channels SET topic = ?1 WHERE id = ?2",
                            [topic, &mutation.target_id],
                        ).map_err(|e| e.to_string())?;
                    }
                    if let Some(position) = patch.get("position").and_then(|v| v.as_i64()) {
                        conn.execute(
                            "UPDATE channels SET position = ?1 WHERE id = ?2",
                            rusqlite::params![position, mutation.target_id],
                        ).map_err(|e| e.to_string())?;
                    }
                }
            }
        }

        "channel_delete" => {
            conn.execute(
                "DELETE FROM channels WHERE id = ?1",
                [&mutation.target_id],
            ).map_err(|e| e.to_string())?;
        }

        "emoji_add" => {
            if let Some(new_content) = &mutation.new_content {
                if let Ok(emoji) = serde_json::from_str::<serde_json::Value>(new_content) {
                    let id = emoji.get("id").and_then(|v| v.as_str()).unwrap_or("");
                    let server_id = emoji.get("serverId").and_then(|v| v.as_str()).unwrap_or("");
                    let name = emoji.get("name").and_then(|v| v.as_str()).unwrap_or("");
                    let file_path = emoji.get("filePath").and_then(|v| v.as_str()).unwrap_or("");
                    let uploaded_by = emoji.get("uploadedBy").and_then(|v| v.as_str()).unwrap_or("");

                    conn.execute(
                        "INSERT OR IGNORE INTO custom_emoji (id, server_id, name, file_path, uploaded_by, created_at)
                         VALUES (?1,?2,?3,?4,?5,?6)",
                        rusqlite::params![id, server_id, name, file_path, uploaded_by, mutation.created_at],
                    ).map_err(|e| e.to_string())?;
                }
            }
        }

        "emoji_remove" => {
            conn.execute(
                "DELETE FROM custom_emoji WHERE id = ?1",
                [&mutation.target_id],
            ).map_err(|e| e.to_string())?;
        }

        _ => {}
    }
    Ok(())
}
```

Update `db_save_mutation` to call `apply_mutation_side_effects(&conn, &mutation)` instead of the inline match block.

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd src-tauri && cargo test -- mutation_side_effect_tests
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/commands/db_commands.rs
git commit -m "feat: Rust side effects for member_join, member_profile_update, channel_create/update/delete, emoji_add/remove mutations"
```

---

### Task 15: Channel Operations → Mutation-Based

**Files:**
- Modify: `src/stores/channelsStore.ts`
- Test: `src/stores/__tests__/channelsStore.test.ts`

- [ ] **Step 1: Write test for createChannel creating a mutation**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))

import { invoke } from '@tauri-apps/api/core'
const mockedInvoke = invoke as ReturnType<typeof vi.fn>

describe('channelsStore mutation-based operations', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    mockedInvoke.mockReset()
    mockedInvoke.mockResolvedValue(undefined)
  })

  it('createChannel saves a channel_create mutation', async () => {
    const { useChannelsStore } = await import('../channelsStore')
    const store = useChannelsStore()

    await store.createChannel('server1', 'general', 'text')

    // Should have called db_save_mutation with type: channel_create
    const mutationCall = mockedInvoke.mock.calls.find(
      (c: any[]) => c[0] === 'db_save_mutation',
    )
    expect(mutationCall).toBeDefined()
    expect(mutationCall![1].mutation.type).toBe('channel_create')

    const payload = JSON.parse(mutationCall![1].mutation.new_content)
    expect(payload.name).toBe('general')
    expect(payload.serverId).toBe('server1')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm run test -- --run src/stores/__tests__/channelsStore.test.ts
```

Expected: FAIL — `createChannel` still calls `db_save_channel` directly, not `db_save_mutation`.

- [ ] **Step 3: Rewrite createChannel to use mutations**

First, add the `generateHLC` import at the top of `channelsStore.ts`:

```typescript
import { generateHLC } from '@/utils/hlc'
```

Then replace `createChannel`:

```typescript
async function createChannel(serverId: string, name: string, type: ChannelType = 'text'): Promise<Channel> {
  const { useIdentityStore } = await import('./identityStore')
  const identityStore = useIdentityStore()
  const { useMessagesStore } = await import('./messagesStore')
  const messagesStore = useMessagesStore()

  const existing = channels.value[serverId] ?? []
  const channel: Channel = {
    id:       uuidv7(),
    serverId,
    name,
    type,
    position: existing.length,
  }

  const mutation: Mutation = {
    id:        uuidv7(),
    type:      'channel_create',
    targetId:  channel.id,
    channelId: '__server__',
    authorId:  identityStore.userId!,
    newContent: JSON.stringify(channel),
    logicalTs:  generateHLC(),
    createdAt:  new Date().toISOString(),
    verified:   true,
  }

  // Persist mutation (Rust side effects create the channel row)
  await messagesStore.applyMutation(mutation)
  // Update in-memory state
  channels.value[serverId] = [...existing, channel]

  // Broadcast mutation to peers
  const { useNetworkStore } = await import('./networkStore')
  useNetworkStore().broadcast({ type: 'mutation', serverId, mutation: serializeMutation(mutation) })

  return channel
}
```

Note: `serializeMutation` is defined in `serversStore.ts`. Either import it (`const { serializeMutation } = await import('./serversStore')`) or move it to a shared utility (e.g. `src/utils/mutations.ts`) since both `channelsStore` and `serversStore` now need it. The function body is:
```typescript
function serializeMutation(m: Mutation) {
  return {
    id: m.id, type: m.type, targetId: m.targetId,
    channelId: m.channelId, authorId: m.authorId,
    newContent: m.newContent, logicalTs: m.logicalTs, createdAt: m.createdAt,
  }
}
```

- [ ] **Step 4: Rewrite deleteChannel to use mutations**

```typescript
async function deleteChannel(channelId: string) {
  const { useIdentityStore } = await import('./identityStore')
  const identityStore = useIdentityStore()
  const { useMessagesStore } = await import('./messagesStore')
  const messagesStore = useMessagesStore()

  // Find serverId for this channel
  let serverId = ''
  for (const [sid, list] of Object.entries(channels.value)) {
    if (list.find(c => c.id === channelId)) { serverId = sid; break }
  }

  const mutation: Mutation = {
    id:        uuidv7(),
    type:      'channel_delete',
    targetId:  channelId,
    channelId: '__server__',
    authorId:  identityStore.userId!,
    logicalTs:  generateHLC(),
    createdAt:  new Date().toISOString(),
    verified:   true,
  }

  await messagesStore.applyMutation(mutation)

  for (const [sid, list] of Object.entries(channels.value)) {
    channels.value[sid] = list.filter(c => c.id !== channelId)
  }
  if (activeChannelId.value === channelId) activeChannelId.value = null

  if (serverId) {
    const { useNetworkStore } = await import('./networkStore')
    useNetworkStore().broadcast({ type: 'mutation', serverId, mutation: serializeMutation(mutation) })
  }
}
```

- [ ] **Step 5: Run tests and commit**

```bash
npm run test -- --run src/stores/__tests__/channelsStore.test.ts
npx vue-tsc --noEmit
git add src/stores/channelsStore.ts src/stores/__tests__/channelsStore.test.ts
git commit -m "feat: channel create/delete go through mutation log instead of gossip"
```

---

### Task 16: Member Join/Profile Mutations

**Files:**
- Modify: `src/stores/serversStore.ts`
- Test: `src/stores/__tests__/serversStore.test.ts`

- [ ] **Step 1: Write test for createMemberJoinMutation**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))

import { invoke } from '@tauri-apps/api/core'
const mockedInvoke = invoke as ReturnType<typeof vi.fn>

describe('serversStore member mutations', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    mockedInvoke.mockReset()
    mockedInvoke.mockResolvedValue(undefined)
  })

  it('createMemberJoinMutation persists a member_join mutation', async () => {
    const { useServersStore } = await import('../serversStore')
    const store = useServersStore()

    await store.createMemberJoinMutation({
      userId: 'user1',
      serverId: 'server1',
      displayName: 'Alice',
      publicSignKey: 'pk1',
      publicDHKey: 'dk1',
      roles: ['member'],
      joinedAt: '2024-01-01T00:00:00Z',
    })

    const mutationCall = mockedInvoke.mock.calls.find(
      (c: any[]) => c[0] === 'db_save_mutation',
    )
    expect(mutationCall).toBeDefined()
    expect(mutationCall![1].mutation.type).toBe('member_join')
  })

  it('broadcastProfileMutation creates member_profile_update', async () => {
    const { useServersStore } = await import('../serversStore')
    const store = useServersStore()

    await store.broadcastProfileMutation('server1', {
      displayName: 'New Name',
      avatarHash: 'abc123',
    })

    const mutationCall = mockedInvoke.mock.calls.find(
      (c: any[]) => c[0] === 'db_save_mutation',
    )
    expect(mutationCall).toBeDefined()
    expect(mutationCall![1].mutation.type).toBe('member_profile_update')
    const payload = JSON.parse(mutationCall![1].mutation.new_content)
    expect(payload.avatarHash).toBe('abc123')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm run test -- --run src/stores/__tests__/serversStore.test.ts
```

- [ ] **Step 3: Implement createMemberJoinMutation and broadcastProfileMutation**

Add to `serversStore.ts`:

```typescript
async function createMemberJoinMutation(member: {
  userId: string
  serverId: string
  displayName: string
  publicSignKey: string
  publicDHKey: string
  roles: string[]
  joinedAt: string
}): Promise<void> {
  const { useIdentityStore } = await import('./identityStore')
  const identityStore = useIdentityStore()
  const { useMessagesStore } = await import('./messagesStore')
  const messagesStore = useMessagesStore()

  const mutation: Mutation = {
    id:         uuidv7(),
    type:       'member_join',
    targetId:   member.userId,
    channelId:  '__server__',
    authorId:   member.userId,
    newContent: JSON.stringify(member),
    logicalTs:  generateHLC(),
    createdAt:  new Date().toISOString(),
    verified:   true,
  }

  await messagesStore.applyMutation(mutation)

  // Also upsert locally so member appears immediately
  if (!members.value[member.serverId]) members.value[member.serverId] = {}
  members.value[member.serverId][member.userId] = {
    userId: member.userId,
    serverId: member.serverId,
    displayName: member.displayName,
    roles: member.roles,
    joinedAt: member.joinedAt,
    publicSignKey: member.publicSignKey,
    publicDHKey: member.publicDHKey,
    onlineStatus: 'online',
  }

  const { useNetworkStore } = await import('./networkStore')
  useNetworkStore().broadcast({ type: 'mutation', serverId: member.serverId, mutation: serializeMutation(mutation) })
}

async function broadcastProfileMutation(serverId: string, profile: {
  displayName?: string
  avatarHash?: string
  bio?: string
  bannerColor?: string
  bannerHash?: string
}): Promise<void> {
  const { useIdentityStore } = await import('./identityStore')
  const identityStore = useIdentityStore()
  const { useMessagesStore } = await import('./messagesStore')
  const messagesStore = useMessagesStore()

  const mutation: Mutation = {
    id:         uuidv7(),
    type:       'member_profile_update',
    targetId:   identityStore.userId!,
    channelId:  '__server__',
    authorId:   identityStore.userId!,
    newContent: JSON.stringify({ serverId, ...profile }),
    logicalTs:  generateHLC(),
    createdAt:  new Date().toISOString(),
    verified:   true,
  }

  await messagesStore.applyMutation(mutation)

  // Update local member record
  const m = members.value[serverId]?.[identityStore.userId!]
  if (m) {
    if (profile.displayName) m.displayName = profile.displayName
    if (profile.avatarHash) m.avatarHash = profile.avatarHash
    if (profile.bio !== undefined) m.bio = profile.bio
    if (profile.bannerColor !== undefined) m.bannerColor = profile.bannerColor
    if (profile.bannerHash) m.bannerHash = profile.bannerHash
  }

  const { useNetworkStore } = await import('./networkStore')
  useNetworkStore().broadcast({ type: 'mutation', serverId, mutation: serializeMutation(mutation) })
}
```

Expose both in the store return object.

- [ ] **Step 4: Run tests and commit**

```bash
npm run test -- --run src/stores/__tests__/serversStore.test.ts
npx vue-tsc --noEmit
git add src/stores/serversStore.ts src/stores/__tests__/serversStore.test.ts
git commit -m "feat: member join and profile update go through mutation log"
```

---

### Task 17: Emoji Operations → Mutation-Based

**Files:**
- Modify: `src/stores/emojiStore.ts`

- [ ] **Step 1: Find emoji add/remove functions in emojiStore.ts**

Read the store to understand the current add/delete flow. Look for functions that call `db_save_emoji`, `broadcast emoji_sync`.

- [ ] **Step 2: Rewrite emoji add to use mutations**

After the existing `db_save_emoji` call, add mutation creation:

```typescript
async function addEmoji(serverId: string, name: string, imageBytes: Uint8Array): Promise<void> {
  const { useIdentityStore } = await import('./identityStore')
  const identityStore = useIdentityStore()
  const { useMessagesStore } = await import('./messagesStore')
  const messagesStore = useMessagesStore()

  const emojiId = uuidv7()
  // Save emoji image to disk and get file path
  const { invoke } = await import('@tauri-apps/api/core')
  await invoke('db_save_emoji', {
    emoji: { id: emojiId, server_id: serverId, name, file_path: `emoji/${serverId}/${emojiId}.webp`, uploaded_by: identityStore.userId, created_at: new Date().toISOString() },
    imageBytes: Array.from(imageBytes),
  })

  // Create mutation
  const mutation: Mutation = {
    id:         uuidv7(),
    type:       'emoji_add',
    targetId:   emojiId,
    channelId:  '__server__',
    authorId:   identityStore.userId!,
    newContent: JSON.stringify({ id: emojiId, serverId, name, filePath: `emoji/${serverId}/${emojiId}.webp`, uploadedBy: identityStore.userId }),
    logicalTs:  generateHLC(),
    createdAt:  new Date().toISOString(),
    verified:   true,
  }

  await messagesStore.applyMutation(mutation)

  const { useNetworkStore } = await import('./networkStore')
  useNetworkStore().broadcast({ type: 'mutation', serverId, mutation: serializeMutation(mutation) })
}
```

- [ ] **Step 3: Rewrite emoji remove to use mutations**

```typescript
async function removeEmoji(serverId: string, emojiId: string): Promise<void> {
  const { useIdentityStore } = await import('./identityStore')
  const identityStore = useIdentityStore()
  const { useMessagesStore } = await import('./messagesStore')
  const messagesStore = useMessagesStore()

  const mutation: Mutation = {
    id:         uuidv7(),
    type:       'emoji_remove',
    targetId:   emojiId,
    channelId:  '__server__',
    authorId:   identityStore.userId!,
    logicalTs:  generateHLC(),
    createdAt:  new Date().toISOString(),
    verified:   true,
  }

  await messagesStore.applyMutation(mutation)

  const { useNetworkStore } = await import('./networkStore')
  useNetworkStore().broadcast({ type: 'mutation', serverId, mutation: serializeMutation(mutation) })
}
```

- [ ] **Step 4: Build check and commit**

```bash
npx vue-tsc --noEmit
git add src/stores/emojiStore.ts
git commit -m "feat: emoji add/remove go through mutation log"
```

---

### Task 18: Apply Channel/Member Mutations on Sync Receipt

**Files:**
- Modify: `src/stores/networkStore.ts` (`handleMutationMessage`)
- Modify: `src/services/syncService.ts` (`_onPush`)

- [ ] **Step 1: Add channel/member mutation handling to handleMutationMessage**

In `handleMutationMessage`, after the existing `if (['server_update', ...].includes(mutation.type))` block, add:

```typescript
// Channel mutations
if (['channel_create', 'channel_update', 'channel_delete'].includes(mutation.type)) {
  const { useChannelsStore } = await import('./channelsStore')
  await useChannelsStore().applyChannelMutation(mutation)
}

// Member mutations
if (mutation.type === 'member_join' && mutation.newContent) {
  const { useServersStore } = await import('./serversStore')
  const serversStore = useServersStore()
  const payload = JSON.parse(mutation.newContent)
  if (payload.serverId && payload.userId) {
    if (!serversStore.members[payload.serverId]) serversStore.members[payload.serverId] = {}
    serversStore.members[payload.serverId][payload.userId] = {
      userId: payload.userId,
      serverId: payload.serverId,
      displayName: payload.displayName ?? '',
      roles: payload.roles ?? ['member'],
      joinedAt: payload.joinedAt ?? mutation.createdAt,
      publicSignKey: payload.publicSignKey ?? '',
      publicDHKey: payload.publicDHKey ?? '',
      onlineStatus: 'offline',
    }
  }
}

if (mutation.type === 'member_profile_update' && mutation.newContent) {
  const { useServersStore } = await import('./serversStore')
  const serversStore = useServersStore()
  const patch = JSON.parse(mutation.newContent)
  if (patch.serverId) {
    const m = serversStore.members[patch.serverId]?.[mutation.targetId]
    if (m) {
      if (patch.displayName) m.displayName = patch.displayName
      if (patch.avatarHash) m.avatarHash = patch.avatarHash
      if (patch.bio !== undefined) m.bio = patch.bio
      if (patch.bannerColor !== undefined) m.bannerColor = patch.bannerColor
      if (patch.bannerHash) m.bannerHash = patch.bannerHash
    }
  }
  // Trigger image fetch for new hashes
  const hashesToFetch = [patch.avatarHash, patch.bannerHash].filter(Boolean) as string[]
  for (const hash of hashesToFetch) {
    const has = await invoke<boolean>('has_attachment', { contentHash: hash }).catch(() => false)
    if (!has) {
      broadcast({ type: 'attachment_want', contentHash: hash, messageId: '' })
    }
  }
}

// Emoji mutations
if (mutation.type === 'emoji_add' && mutation.newContent) {
  const { useEmojiStore } = await import('./emojiStore')
  const emojiStore = useEmojiStore()
  const payload = JSON.parse(mutation.newContent)
  emojiStore.applyEmojiAddMutation(payload)
}
if (mutation.type === 'emoji_remove') {
  const { useEmojiStore } = await import('./emojiStore')
  const emojiStore = useEmojiStore()
  emojiStore.applyEmojiRemoveMutation(mutation.targetId)
}
```

- [ ] **Step 2: Update syncService._onPush for server-level mutations**

In `_onPush`, when `wire.channelId === '__server__'`, after saving mutations, hydrate the affected tables:

```typescript
if (wire.channelId === '__server__' && wire.mutations && wire.mutations.length > 0) {
  // Hydrate channels, members, etc. from server-level mutations
  const { useChannelsStore } = await import('@/stores/channelsStore')
  const channelsStore = useChannelsStore()
  const { useServersStore } = await import('@/stores/serversStore')
  const serversStore = useServersStore()

  for (const mut of wire.mutations) {
    const mutation = rowToMutation(mut)
    if (['channel_create', 'channel_update', 'channel_delete'].includes(mutation.type)) {
      await channelsStore.applyChannelMutation(mutation)
    }
    if (mutation.type === 'member_join' && mutation.newContent) {
      const payload = JSON.parse(mutation.newContent)
      if (payload.serverId && payload.userId) {
        if (!serversStore.members[payload.serverId]) serversStore.members[payload.serverId] = {}
        serversStore.members[payload.serverId][payload.userId] = {
          userId: payload.userId,
          serverId: payload.serverId,
          displayName: payload.displayName ?? '',
          roles: payload.roles ?? ['member'],
          joinedAt: payload.joinedAt ?? mutation.createdAt,
          publicSignKey: payload.publicSignKey ?? '',
          publicDHKey: payload.publicDHKey ?? '',
          onlineStatus: 'offline',
        }
      }
    }
    if (mutation.type === 'member_profile_update' && mutation.newContent) {
      const patch = JSON.parse(mutation.newContent)
      if (patch.serverId) {
        const m = serversStore.members[patch.serverId]?.[mutation.targetId]
        if (m) Object.assign(m, patch)
      }
    }
  }
}
```

Note: `rowToMutation` is defined in `messagesStore.ts`. Import it or pass the conversion logic. Alternatively, the sync service can dispatch each mutation through `handleMutationMessage` in networkStore (but be careful not to re-broadcast).

- [ ] **Step 3: Build check and commit**

```bash
npx vue-tsc --noEmit
git add src/stores/networkStore.ts src/services/syncService.ts
git commit -m "feat: apply channel/member/emoji mutations received via sync and direct broadcast"
```

---

### Task 19: Remove Redundant Gossip Functions

**Files:**
- Modify: `src/stores/networkStore.ts`
- Modify: `src/stores/channelsStore.ts`
- Modify: `src/stores/emojiStore.ts`
- Modify: `src/utils/peerValidator.ts`

- [ ] **Step 1: Remove gossipOwnMembership**

Delete the `gossipOwnMembership` function. Remove the call from `onConnected`.

Members now arrive via mutations: when a peer syncs, they receive `member_join` mutations from the mutations table.

- [ ] **Step 2: Remove gossipServerAvatars**

Delete the `gossipServerAvatars` function. Remove the call from `onConnected`.

Server avatars now stored via `server_update` mutations with `avatarHash` field.

- [ ] **Step 3: Remove gossipOwnProfile (persistent fields)**

The `gossipOwnProfile` function currently sends display name, avatar, bio, banner. Replace with: no-op at connect time — data arrives via `member_profile_update` mutations during sync.

However, keep the `profile_update` message type for backward compatibility during the rollout period. Or remove entirely if all peers upgrade simultaneously.

Delete the `gossipOwnProfile` function. Delete the `requestProfile` function. Remove both calls from `onConnected`.

- [ ] **Step 4: Remove channel_gossip handler**

Remove the `case 'channel_gossip':` handler from `handleDataChannelMessage`. Channels now arrive via `channel_create` mutations.

In `channelsStore.ts`, remove `receiveChannelGossip` function.

- [ ] **Step 5: Remove emoji_sync handler**

Remove the `case 'emoji_sync':` handler from `handleDataChannelMessage`. Emoji metadata now arrives via `emoji_add` mutations. The emoji image transfer still uses `emoji_image_request`/`emoji_image` (or can be migrated to the attachment protocol).

In `emojiStore.ts`, remove `receiveEmojiSync` function.

- [ ] **Step 6: Remove member_announce handler**

Remove the `case 'member_announce':` handler from `handleDataChannelMessage`. Members now arrive via `member_join` mutations.

- [ ] **Step 7: Remove profile_update and profile_request handlers**

Remove both from `handleDataChannelMessage`. Profile data arrives via `member_profile_update` mutations.

- [ ] **Step 8: Remove server_avatar_update handler**

Remove from `handleDataChannelMessage`. Server icons arrive via `server_update` mutations.

- [ ] **Step 9: Clean up peerValidator.ts**

Remove validators for deleted gossip types:
- `isValidMemberAnnounce`
- `isValidProfileUpdate`
- `isValidEmojiSync`

Keep validators for types that remain:
- `isValidChatMessage`
- `isValidMutation`
- `isValidPresenceUpdate`
- `isValidTypingStart`
- `isValidVoiceJoin`

- [ ] **Step 10: Update onConnected handler**

The new `onConnected` should be:

```typescript
async function onConnected(userId: string) {
  connectedPeers.value.push(userId)

  // Pre-auth crypto bootstrap (stays gossip)
  gossipOwnDevice(userId).catch(e => console.warn('[net] gossipOwnDevice error:', e))

  // Ephemeral state (stays gossip)
  gossipOwnPresence(userId).catch(e => console.warn('[net] gossipOwnPresence error:', e))

  // Heartbeat baseline
  lastHeartbeatFrom.set(userId, Date.now())

  // Sync all persistent state via negentropy
  startSync(userId)
}
```

Removed gossip calls:
- ~~`gossipOwnMembership(userId)`~~ → arrives via mutations in sync
- ~~`gossipOwnPresence(userId)`~~ → KEPT (ephemeral)
- ~~`gossipOwnProfile(userId)`~~ → arrives via mutations in sync
- ~~`gossipServerAvatars(userId)`~~ → arrives via mutations in sync
- ~~`requestProfile(userId)`~~ → not needed, sync covers it

- [ ] **Step 11: Build check and commit**

```bash
npx vue-tsc --noEmit
git add src/stores/networkStore.ts src/stores/channelsStore.ts src/stores/emojiStore.ts src/utils/peerValidator.ts
git commit -m "feat: remove gossip for members, channels, emoji, profiles, server avatars — all sync via mutations"
```

---

### Task 20: Mutation Backfill for Existing Data

**Files:**
- Create: `src/utils/mutationBackfill.ts`
- Modify: `src/stores/identityStore.ts` (call backfill on startup)

- [ ] **Step 1: Implement backfill utility**

This runs once per database to create mutations for pre-existing data that was created before the mutation-log migration.

```typescript
import { invoke } from '@tauri-apps/api/core'
import { v7 as uuidv7 } from 'uuid'

/**
 * One-time backfill: creates member_join and channel_create mutations for
 * existing data that predates the mutation-based sync system.
 * Safe to call multiple times — uses INSERT OR IGNORE.
 */
export async function backfillMutations(): Promise<number> {
  let count = 0

  // Check if backfill has already run
  const marker = await invoke<string | null>('db_load_key', { keyId: 'mutation_backfill_v1' })
    .catch(() => null)
  if (marker) return 0

  // Backfill member_join for all existing members
  const servers = await invoke<any[]>('db_load_servers').catch(() => [])
  for (const serverRow of servers) {
    const serverId = serverRow.id
    const members = await invoke<any[]>('db_load_members', { serverId }).catch(() => [])
    for (const m of members) {
      const mutation = {
        id:           uuidv7(),
        type:         'member_join',
        target_id:    m.user_id,
        channel_id:   '__server__',
        author_id:    m.user_id,
        new_content:  JSON.stringify({
          userId: m.user_id,
          serverId,
          displayName: m.display_name,
          publicSignKey: m.public_sign_key,
          publicDHKey: m.public_dh_key,
          roles: JSON.parse(m.roles || '["member"]'),
          joinedAt: m.joined_at,
        }),
        logical_ts:   m.joined_at, // Use original join time for ordering
        created_at:   m.joined_at,
        verified:     true,
      }
      await invoke('db_save_mutation', { mutation }).catch(() => {})
      count++

      // If member has avatar_hash, also create member_profile_update
      if (m.avatar_hash) {
        const profileMut = {
          id:           uuidv7(),
          type:         'member_profile_update',
          target_id:    m.user_id,
          channel_id:   '__server__',
          author_id:    m.user_id,
          new_content:  JSON.stringify({
            serverId,
            avatarHash: m.avatar_hash,
            displayName: m.display_name,
            bio: m.bio,
            bannerColor: m.banner_color,
            bannerHash: m.banner_hash,
          }),
          logical_ts:   new Date().toISOString(),
          created_at:   new Date().toISOString(),
          verified:     true,
        }
        await invoke('db_save_mutation', { mutation: profileMut }).catch(() => {})
        count++
      }
    }

    // Backfill channel_create for all existing channels
    const channels = await invoke<any[]>('db_load_channels', { serverId }).catch(() => [])
    for (const ch of channels) {
      const mutation = {
        id:           uuidv7(),
        type:         'channel_create',
        target_id:    ch.id,
        channel_id:   '__server__',
        author_id:    serverRow.owner_id,
        new_content:  JSON.stringify({
          id: ch.id,
          serverId,
          name: ch.name,
          type: ch.type,
          position: ch.position,
          topic: ch.topic,
        }),
        logical_ts:   ch.created_at,
        created_at:   ch.created_at,
        verified:     true,
      }
      await invoke('db_save_mutation', { mutation }).catch(() => {})
      count++
    }
  }

  // Mark backfill as complete
  await invoke('db_save_key', { keyId: 'mutation_backfill_v1', keyType: 'system', keyData: new Date().toISOString() })
    .catch(() => {})

  return count
}
```

- [ ] **Step 2: Call backfill on startup**

In `identityStore.ts`, after `initializeIdentity()` completes and after the data URL migration:

```typescript
// One-time mutation backfill for existing data
try {
  const backfilled = await backfillMutations()
  if (backfilled > 0) {
    console.log(`[identity] backfilled ${backfilled} mutations for existing data`)
  }
} catch (e) {
  console.warn('[identity] mutation backfill failed:', e)
}
```

Import at the top of the file (or via dynamic import):

```typescript
import { backfillMutations } from '@/utils/mutationBackfill'
```

- [ ] **Step 3: Build check and commit**

```bash
npx vue-tsc --noEmit
git add src/utils/mutationBackfill.ts src/stores/identityStore.ts
git commit -m "feat: one-time mutation backfill for pre-existing members, channels, and profiles"
```

---

### Task 21: Reorder Sync Passes — Server Mutations First

**Files:**
- Modify: `src/services/syncService.ts`

- [ ] **Step 1: Move server-level mutations to the first sync pass**

Currently `startSync` runs: per-channel (messages, mutations), then server-level mutations last. With member/channel mutations in the server-level bucket, we want them to arrive FIRST so the UI populates quickly.

Reorder `startSync`:

```typescript
async function startSync(peerId: string): Promise<void> {
  // Pass 0: Server-level mutations FIRST (members, channels, devices, emoji, server updates)
  await _startNegSession(peerId, '__server__', 'mutations')

  // Then per-channel passes
  const channelIds = await invoke<string[]>('sync_list_channels')
  for (const channelId of channelIds) {
    await _startNegSession(peerId, channelId, 'messages')
    await _startNegSession(peerId, channelId, 'mutations')
  }
}
```

- [ ] **Step 2: Build check and commit**

```bash
npx vue-tsc --noEmit
git add src/services/syncService.ts
git commit -m "feat: sync server-level mutations first for fast member/channel hydration"
```

---

### Task 22: Wire Up Join Flow to Create Mutations

**Files:**
- Modify: `src/views/JoinView.vue`
- Modify: `src/stores/serversStore.ts` (in `joinFromManifest`)

- [ ] **Step 1: Create member_join mutation when joining a server**

In `serversStore.ts`, find `joinFromManifest`. After the server and member rows are created locally, create a `member_join` mutation:

```typescript
// After: await invoke('db_upsert_member', { member: ... })
// Create member_join mutation so it syncs via negentropy to other peers
await createMemberJoinMutation({
  userId: identityStore.userId!,
  serverId: server.id,
  displayName: identityStore.displayName!,
  publicSignKey: identityStore.publicSignKey!,
  publicDHKey: identityStore.publicDHKey!,
  roles: ['member'],
  joinedAt: new Date().toISOString(),
})
```

- [ ] **Step 2: Create member_join mutations for peers received in server manifest**

When receiving a server manifest (which includes the owner and existing members), create `member_join` mutations for each:

```typescript
// For the owner from the manifest:
await createMemberJoinMutation({
  userId: manifest.owner.userId,
  serverId: manifest.server.id,
  displayName: manifest.owner.displayName,
  publicSignKey: manifest.owner.publicSignKey,
  publicDHKey: manifest.owner.publicDHKey,
  roles: ['owner', 'admin'],
  joinedAt: manifest.server.createdAt,
})
```

- [ ] **Step 3: Build check and commit**

```bash
npx vue-tsc --noEmit
git add src/stores/serversStore.ts src/views/JoinView.vue
git commit -m "feat: join flow creates member_join mutations for negentropy sync"
```

---

### Task 23: Integration Test — Full Sync Flow

**Files:**
- Modify: `src/services/__tests__/crossPeerIntegration.test.ts`

- [ ] **Step 1: Add test for mutation-based sync flow**

```typescript
describe('mutation-based sync', () => {
  it('channel_create mutation is accepted by handleMutationMessage', async () => {
    const mutation = {
      id: 'mut1',
      type: 'channel_create',
      targetId: 'ch1',
      channelId: '__server__',
      authorId: 'user1',
      newContent: JSON.stringify({ id: 'ch1', serverId: 's1', name: 'general', type: 'text', position: 0 }),
      logicalTs: '1000-000000',
      createdAt: new Date().toISOString(),
    }

    // Verify isValidMutation accepts this
    expect(isValidMutation({ mutation })).toBe(true)
  })

  it('member_profile_update mutation with avatarHash is accepted', async () => {
    const mutation = {
      id: 'mut2',
      type: 'member_profile_update',
      targetId: 'user1',
      channelId: '__server__',
      authorId: 'user1',
      newContent: JSON.stringify({ serverId: 's1', displayName: 'Alice', avatarHash: 'abc123' }),
      logicalTs: '2000-000000',
      createdAt: new Date().toISOString(),
    }

    expect(isValidMutation({ mutation })).toBe(true)
  })
})
```

- [ ] **Step 2: Run test**

```bash
npm run test -- --run src/services/__tests__/crossPeerIntegration.test.ts
```

- [ ] **Step 3: Commit**

```bash
git add src/services/__tests__/crossPeerIntegration.test.ts
git commit -m "test: integration tests for mutation-based channel/member sync"
```

---

### Task 24: Final Build Verification

- [ ] **Step 1: Full frontend build**

```bash
npm run build
```

Expected: clean — no TypeScript errors.

- [ ] **Step 2: Full Rust check**

```bash
cd src-tauri && cargo check
```

Expected: clean — no Rust errors.

- [ ] **Step 3: Run all tests**

```bash
npm run test
cd src-tauri && cargo test
```

Expected: all tests pass.

- [ ] **Step 4: Update docs/TODO.md**

Mark the relevant tasks as complete. Add new entries if needed for follow-up work:
- [ ] Optimize AvatarImage to use `convertFileSrc` + asset protocol
- [ ] Add retention policy differentiation (pin avatar images vs. expire attachments)
- [ ] Remove deprecated `avatar_data_url` / `banner_data_url` columns after migration period
- [ ] Add negentropy sync for `devices` table (currently only attested via gossip on connect)

- [ ] **Step 5: Final commit**

```bash
git add docs/TODO.md
git commit -m "feat: complete image storage migration + negentropy sync expansion"
```

---

## Post-Migration State

### What gossips (ephemeral/pre-auth only):
| Wire message | Purpose |
|-------------|---------|
| `device_attest` | Pre-auth crypto bootstrap (establishes identity before sync) |
| `presence_update` | Ephemeral online/idle/dnd/offline status |
| `typing_start` / `typing_stop` | Ephemeral typing indicators |
| `voice_join` / `voice_leave` | Ephemeral voice session state |
| `voice_screen_share_*` | Ephemeral screen share state |
| `server_join_request` / `server_manifest` / `server_join_denied` | Join handshake (one-shot) |
| `device_link_request` / `device_link_confirm` | Device linking handshake |
| `chat_message` | Encrypted message delivery (also stored as message row for sync) |
| `attachment_want` / `attachment_have` / `attachment_chunk*` | P2P file transfer |

### What syncs via negentropy (persistent state):
| Mutation type | Table affected | Replaces gossip |
|--------------|---------------|----------------|
| `member_join` | `members` | `member_announce` |
| `member_profile_update` | `members` | `profile_update` |
| `channel_create` | `channels` | `channel_gossip` |
| `channel_update` | `channels` | `channel_gossip` |
| `channel_delete` | `channels` | `channel_gossip` |
| `emoji_add` | `custom_emoji` | `emoji_sync` |
| `emoji_remove` | `custom_emoji` | `emoji_sync` |
| `server_update` (avatarHash) | `servers` | `server_avatar_update` |
| `device_attest` | `devices` | (existed, now also via mutation) |
| `device_revoke` | `devices` | (existed) |
| All existing types | `messages`, `mutations` | (unchanged) |

### Image storage:
| Image type | Old storage | New storage |
|-----------|------------|-------------|
| User avatar | `key_store.local_avatar_data` (base64 data URL) | `attachments/{hash[0:2]}/{hash}.bin` + `key_store.local_avatar_hash` |
| User banner | `key_store.local_banner_data` (base64 data URL) | `attachments/{hash[0:2]}/{hash}.bin` + `key_store.local_banner_hash` |
| Server icon | `key_store.server_avatar_{id}` (base64 data URL) | `attachments/{hash[0:2]}/{hash}.bin` + `key_store.server_avatar_hash_{id}` |
| Peer avatar | `members.avatar_data_url` (base64 in SQLite) | `attachments/{hash[0:2]}/{hash}.bin` + `members.avatar_hash` |
| Peer banner | `members.banner_data_url` (base64 in SQLite) | `attachments/{hash[0:2]}/{hash}.bin` + `members.banner_hash` |
| Custom emoji | `$APPDATA/emoji/{sid}/{id}.webp` (already on disk) | Unchanged |
