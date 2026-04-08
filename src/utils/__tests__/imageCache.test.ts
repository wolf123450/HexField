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
