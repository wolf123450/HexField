import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
  convertFileSrc: vi.fn((p: string) => `asset://localhost/${p}`),
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
    mockedInvoke.mockResolvedValueOnce({ path: '/images/deadbeef.png', mime_type: 'image/png' })

    const result1 = await resolveImageHash('deadbeef')
    expect(result1).toEqual({ url: 'asset://localhost//images/deadbeef.png', mimeType: 'image/png' })
    expect(mockedInvoke).toHaveBeenCalledWith('get_image_info', { contentHash: 'deadbeef' })

    // Second call should NOT invoke again
    mockedInvoke.mockClear()
    const result2 = await resolveImageHash('deadbeef')
    expect(result2).toEqual({ url: 'asset://localhost//images/deadbeef.png', mimeType: 'image/png' })
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
    mockedInvoke.mockResolvedValueOnce({ path: '/images/deadbeef.png', mime_type: 'image/png' })
    await resolveImageHash('deadbeef')

    clearImageCache()
    mockedInvoke.mockClear()
    mockedInvoke.mockResolvedValueOnce({ path: '/images/deadbeef2.png', mime_type: 'image/png' })

    const result = await resolveImageHash('deadbeef')
    expect(result).toEqual({ url: 'asset://localhost//images/deadbeef2.png', mimeType: 'image/png' })
    expect(mockedInvoke).toHaveBeenCalledTimes(1)
  })
})
