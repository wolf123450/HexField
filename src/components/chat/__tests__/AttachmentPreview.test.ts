/**
 * AttachmentPreview: what a receiver sees before / after the original arrives
 * (network-compatibility-plan 3d).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createTestingPinia } from '@pinia/testing'
import type { Attachment } from '@/types/core'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))

vi.mock('@/services/attachmentService', () => ({
  createBlobUrl:      vi.fn(),
  downloadAttachment: vi.fn(() => new Promise(() => {})), // never completes in these tests
  downloadProgress:   vi.fn(() => null),
  isValidPreviewDataUrl: (v: unknown) => typeof v === 'string' && v.startsWith('data:image/webp;base64,'),
}))

import AttachmentPreview from '../AttachmentPreview.vue'
import { createBlobUrl, downloadAttachment } from '@/services/attachmentService'
import { useNetworkStore } from '@/stores/networkStore'

const PREVIEW = 'data:image/webp;base64,UklGRg=='

function att(overrides: Partial<Attachment> = {}): Attachment {
  return {
    id: 'a1', name: 'cat.png', size: 120_000, mimeType: 'image/png',
    contentHash: 'blake3:abc', transferState: 'complete', ...overrides,
  }
}

function mountPreview(attachment: Attachment) {
  return mount(AttachmentPreview, {
    props: { attachment, messageId: 'm1', serverId: 's1' },
    global: {
      stubs: { AppIcon: true, Teleport: true },
      plugins: [createTestingPinia({ createSpy: vi.fn })],
    },
  })
}

describe('AttachmentPreview', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('shows the original when it is stored locally', async () => {
    vi.mocked(createBlobUrl).mockResolvedValue('blob:local')
    const wrapper = mountPreview(att({ previewDataUrl: PREVIEW }))
    await flushPromises()
    expect(wrapper.find('img.preview-image').attributes('src')).toBe('blob:local')
    expect(wrapper.find('.preview-badge').exists()).toBe(false)
    expect(downloadAttachment).not.toHaveBeenCalled()
  })

  it('shows the inline preview and fetches the original when not local', async () => {
    vi.mocked(createBlobUrl).mockResolvedValue(null)
    const wrapper = mountPreview(att({ previewDataUrl: PREVIEW }))
    await flushPromises()
    expect(wrapper.find('img.is-preview').attributes('src')).toBe(PREVIEW)
    expect(wrapper.find('.preview-badge').exists()).toBe(true)
    expect(downloadAttachment).toHaveBeenCalledTimes(1)
    expect(useNetworkStore().broadcastAttachmentWant).toHaveBeenCalledWith('blake3:abc', 'm1')
  })

  it('asks again when the set of connected peers changes mid-download', async () => {
    vi.mocked(createBlobUrl).mockResolvedValue(null)
    mountPreview(att({ previewDataUrl: PREVIEW }))
    await flushPromises()
    const networkStore = useNetworkStore()
    networkStore.connectedPeers = ['peer-direct']
    await flushPromises()
    expect(networkStore.broadcastAttachmentWant).toHaveBeenCalledTimes(2)
  })

  it('never renders an invalid preview', async () => {
    vi.mocked(createBlobUrl).mockResolvedValue(null)
    const wrapper = mountPreview(att({ previewDataUrl: 'data:image/svg+xml;base64,PHN2Zz4=' }))
    await flushPromises()
    expect(wrapper.find('img').exists()).toBe(false)
  })

  it('non-image files wait for a click instead of downloading automatically', async () => {
    vi.mocked(createBlobUrl).mockResolvedValue(null)
    const wrapper = mountPreview(att({ name: 'doc.pdf', mimeType: 'application/pdf' }))
    await flushPromises()
    expect(downloadAttachment).not.toHaveBeenCalled()
    await wrapper.find('.transfer-chip.clickable').trigger('click')
    expect(downloadAttachment).toHaveBeenCalledTimes(1)
  })
})
