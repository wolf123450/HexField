/**
 * attachmentService: inline image previews (network-compatibility-plan 3d)
 * and the receiver download path.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { Attachment } from '@/types/core'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/plugin-fs', () => ({ readFile: vi.fn() }))

import { invoke } from '@tauri-apps/api/core'
import {
  isValidPreviewDataUrl,
  fitPreviewsToBudget,
  sanitizeAttachments,
  downloadAttachment,
  downloadProgress,
  addSeeder,
  receiveChunk,
  setRequestChunksFn,
  makeImagePreview,
  computePreviewTargetBytes,
  PREVIEW_MAX_CHARS,
  PREVIEW_TARGET_BYTES,
  MESSAGE_PREVIEW_BUDGET_CHARS,
} from '@/services/attachmentService'

const preview = (chars: number) => 'data:image/webp;base64,' + 'A'.repeat(chars - 'data:image/webp;base64,'.length)

function att(overrides: Partial<Attachment> = {}): Attachment {
  return {
    id: crypto.randomUUID(), name: 'pic.png', size: 50_000, mimeType: 'image/png',
    contentHash: 'blake3:abc123', transferState: 'complete', ...overrides,
  }
}

describe('isValidPreviewDataUrl', () => {
  it('accepts small raster data URLs', () => {
    expect(isValidPreviewDataUrl('data:image/webp;base64,UklGRg==')).toBe(true)
    expect(isValidPreviewDataUrl('data:image/jpeg;base64,/9j/4AAQ')).toBe(true)
  })

  it('rejects other types, schemes, oversized or malformed values', () => {
    expect(isValidPreviewDataUrl('data:image/svg+xml;base64,PHN2Zz4=')).toBe(false)
    expect(isValidPreviewDataUrl('data:text/html;base64,PGgxPg==')).toBe(false)
    expect(isValidPreviewDataUrl('https://example.com/a.png')).toBe(false)
    expect(isValidPreviewDataUrl('data:image/png;base64,abc"onerror=x')).toBe(false)
    expect(isValidPreviewDataUrl(preview(PREVIEW_MAX_CHARS + 1))).toBe(false)
    expect(isValidPreviewDataUrl(undefined)).toBe(false)
  })
})

describe('fitPreviewsToBudget', () => {
  it('keeps previews in order until the budget is used, drops the rest', () => {
    const out = fitPreviewsToBudget(
      [att({ previewDataUrl: preview(20_000) }), att({ previewDataUrl: preview(20_000) }), att()],
      36_000,
    )
    expect(out[0].previewDataUrl).toBeDefined()
    expect(out[1].previewDataUrl).toBeUndefined()
    expect(out[2].previewDataUrl).toBeUndefined()
  })

  it('leaves attachments without previews untouched', () => {
    const plain = att({ mimeType: 'application/pdf' })
    expect(fitPreviewsToBudget([plain])[0]).toEqual(plain)
  })
})

describe('sanitizeAttachments', () => {
  it('strips invalid previews and keeps valid ones', () => {
    const [bad, good] = sanitizeAttachments([
      att({ previewDataUrl: 'javascript:alert(1)' }),
      att({ previewDataUrl: 'data:image/png;base64,iVBORw0KGgo=' }),
    ])
    expect(bad.previewDataUrl).toBeUndefined()
    expect(good.previewDataUrl).toBe('data:image/png;base64,iVBORw0KGgo=')
  })
})

describe('makeImagePreview', () => {
  it('returns null for non-image files', async () => {
    expect(await makeImagePreview(new Blob(['x'], { type: 'application/pdf' }))).toBeNull()
  })
})

describe('computePreviewTargetBytes', () => {
  it('gives a single image the full per-image target', () => {
    expect(computePreviewTargetBytes(1)).toBe(PREVIEW_TARGET_BYTES)
    expect(computePreviewTargetBytes(0)).toBe(PREVIEW_TARGET_BYTES)
  })

  it('shrinks the per-image target as more images share the message budget', () => {
    const two = computePreviewTargetBytes(2)
    const four = computePreviewTargetBytes(4)
    expect(two).toBeLessThan(PREVIEW_TARGET_BYTES)
    expect(four).toBeLessThan(two)
  })

  it('never goes below a sane floor even with many images', () => {
    expect(computePreviewTargetBytes(100)).toBeGreaterThan(0)
    expect(computePreviewTargetBytes(100)).toBe(computePreviewTargetBytes(1000))
  })

  it('keeps N previews within the message budget once base64-encoded, above the size floor', () => {
    // Rough sanity check: N previews at their shared target, base64-encoded
    // (×4/3) plus a small per-image prefix allowance, should fit the budget —
    // as long as the per-image share hasn't hit the minimum-size floor (very
    // many images legitimately can't all fit; fitPreviewsToBudget is the
    // send-time safety net for that case).
    for (const n of [2, 3, 4, 5]) {
      const perImageBytes = computePreviewTargetBytes(n)
      const perImageChars = perImageBytes * (4 / 3) + 30 // + data-url prefix overhead
      expect(perImageChars * n).toBeLessThanOrEqual(MESSAGE_PREVIEW_BUDGET_CHARS)
    }
  })
})

describe('receiver download path', () => {
  beforeEach(() => { vi.mocked(invoke).mockReset() })

  it('a registered download requests missing chunks when a seeder appears, and resolves on completion', async () => {
    const hash = 'dl1'
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      switch (cmd) {
        case 'has_attachment':        return false
        case 'get_chunk_count':       return 2
        case 'get_received_chunks':   return []
        case 'save_attachment_chunk': return false
        default:                      return null
      }
    })
    const requests: Array<[string, string, number[]]> = []
    setRequestChunksFn((h, peer, missing) => requests.push([h, peer, missing]))

    let done = false
    const download = downloadAttachment(att({ contentHash: `blake3:${hash}` })).then(() => { done = true })
    await new Promise(r => setTimeout(r, 0))

    // No seeder known yet → nothing requested.
    expect(requests).toHaveLength(0)
    expect(downloadProgress(hash)).toBe(0)

    addSeeder(hash, 'peer-direct')
    expect(requests).toEqual([[hash, 'peer-direct', [0, 1]]])

    await receiveChunk(hash, 0, [1], 2)
    expect(downloadProgress(hash)).toBe(0.5)
    expect(done).toBe(false)

    vi.mocked(invoke).mockImplementation(async (cmd: string) => (cmd === 'save_attachment_chunk' ? true : null))
    await receiveChunk(hash, 1, [2], 2)
    await download
    expect(done).toBe(true)
    expect(downloadProgress(hash)).toBeNull()
  })
})
