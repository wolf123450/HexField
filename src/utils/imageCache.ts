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
