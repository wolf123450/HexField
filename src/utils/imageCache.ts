import { invoke, convertFileSrc } from '@tauri-apps/api/core'

export interface ImageEntry {
  url: string
  mimeType: string
}

const cache = new Map<string, ImageEntry>()
const inflight = new Map<string, Promise<ImageEntry | null>>()

/**
 * Resolve a BLAKE3 content hash to an asset:// URL + MIME type.
 * Uses Tauri's asset protocol for native browser file loading — no base64 round-trip.
 * Results are cached in memory for the lifetime of the app session.
 * Returns null if hash is empty or the image file is not found on disk.
 */
export async function resolveImageHash(hash: string | null | undefined): Promise<ImageEntry | null> {
  if (!hash) return null

  const cached = cache.get(hash)
  if (cached) return cached

  // Deduplicate concurrent requests for the same hash
  const existing = inflight.get(hash)
  if (existing) return existing

  const promise = (async () => {
    try {
      const info = await invoke<{ path: string; mime_type: string }>('get_image_info', { contentHash: hash })
      const entry: ImageEntry = {
        url: convertFileSrc(info.path),
        mimeType: info.mime_type,
      }
      cache.set(hash, entry)
      return entry
    } catch {
      return null
    } finally {
      inflight.delete(hash)
    }
  })()

  inflight.set(hash, promise)
  return promise
}

/** Evict a single hash from the cache (e.g. after an avatar update). */
export function evictImageHash(hash: string): void {
  cache.delete(hash)
  inflight.delete(hash)
}

/** Clear the entire in-memory cache. Called during testing or on logout. */
export function clearImageCache(): void {
  cache.clear()
  inflight.clear()
}
