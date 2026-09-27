/**
 * attachmentService.ts
 *
 * Handles Phase 5b P2P file attachments:
 *   - BLAKE3 hashing via Rust IPC
 *   - Saving sender files to the local attachment store
 *   - Coordinating chunk downloads from peers
 *   - Serving chunks to requesting peers (seeding)
 *   - Exposing blob: URLs for completed downloads
 */

import { invoke } from '@tauri-apps/api/core'
import { readFile } from '@tauri-apps/plugin-fs'
import type { Attachment } from '@/types/core'

export const CHUNK_SIZE = 16 * 1024 // must match Rust CHUNK_SIZE — 16 KB so JSON-serialized chunks fit within ~65 KB SCTP limit

// ── Hashing ───────────────────────────────────────────────────────────────────

/** Compute BLAKE3 hash of arbitrary bytes via Rust. Returns hex string (no prefix). */
export async function hashBytes(data: Uint8Array): Promise<string> {
  return invoke<string>('blake3_hash', { data: Array.from(data) })
}

/** Read a File into a Uint8Array. */
export function readFileBytes(file: File): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer))
    reader.onerror = reject
    reader.readAsArrayBuffer(file)
  })
}

// ── Sender path ───────────────────────────────────────────────────────────────

/**
 * Hash a file, store it locally, and return a fully built Attachment record
 * ready to be included in a message. The `transferState` is set to 'complete'
 * since the sender already has all the bytes. Images get an inline preview.
 */
export async function prepareAttachment(file: File, previewTargetBytes?: number): Promise<Attachment> {
  const bytes = await readFileBytes(file)
  const hash = await hashBytes(bytes)
  const contentHash = `blake3:${hash}`

  await invoke('save_attachment', {
    contentHash: hash,
    data: Array.from(bytes),
  })

  const previewDataUrl = await makeImagePreview(file, previewTargetBytes)
  return {
    id:            crypto.randomUUID(),
    name:          file.name,
    size:          file.size,
    mimeType:      file.type || 'application/octet-stream',
    contentHash,
    chunkSize:     CHUNK_SIZE,
    transferState: 'complete',
    ...(previewDataUrl ? { previewDataUrl } : {}),
  }
}

// ── Image previews ────────────────────────────────────────────────────────────
// Relay policy (docs/network-compatibility-plan.md, step 3d): full attachments
// never cross a TURN relay, so each image carries a small inline preview in the
// message itself. It must fit the ~64 KB data-channel frame together with the
// rest of the message, hence the per-message budget.

/** Longest side of the preview, tried in order until the size target is met. */
const PREVIEW_MAX_SIDES = [640, 480, 320]
const PREVIEW_QUALITIES = [0.72, 0.55, 0.4]
/** Encoded preview size target (bytes); ~32 K chars once base64-encoded. */
export const PREVIEW_TARGET_BYTES = 24_000
/** Total preview characters allowed in one message (all attachments). */
export const MESSAGE_PREVIEW_BUDGET_CHARS = 36_000
/** Upper bound accepted from peers. */
export const PREVIEW_MAX_CHARS = 40_000
/** Never shrink a per-image target below this, however many images are attached. */
const PREVIEW_MIN_TARGET_BYTES = 4_000
/** Base64 inflates raw bytes by ~4/3; leave headroom for the `data:image/...;base64,` prefix. */
const BASE64_CHAR_PER_BYTE = 0.72

/**
 * Per-image preview target (bytes) so `imageCount` images sharing one message
 * still fit MESSAGE_PREVIEW_BUDGET_CHARS between them, instead of the first
 * preview claiming the whole budget and the rest being dropped.
 */
export function computePreviewTargetBytes(
  imageCount: number,
  budget = MESSAGE_PREVIEW_BUDGET_CHARS,
): number {
  if (imageCount <= 1) return PREVIEW_TARGET_BYTES
  const share = Math.floor((budget / imageCount) * BASE64_CHAR_PER_BYTE)
  return Math.max(PREVIEW_MIN_TARGET_BYTES, Math.min(PREVIEW_TARGET_BYTES, share))
}

const PREVIEWABLE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/bmp', 'image/avif'])
const PREVIEW_DATA_URL = /^data:image\/(webp|jpeg|png);base64,[A-Za-z0-9+/]+={0,2}$/

/** True for a preview we're willing to render: small raster data URL, nothing else. */
export function isValidPreviewDataUrl(value: unknown): value is string {
  return typeof value === 'string' && value.length <= PREVIEW_MAX_CHARS && PREVIEW_DATA_URL.test(value)
}

/**
 * Downscaled WebP (JPEG where the WebView can't encode WebP) preview of an image,
 * at most PREVIEW_TARGET_BYTES. Null for non-images or if it can't be made small enough.
 */
export async function makeImagePreview(
  file: Blob,
  targetBytes: number = PREVIEW_TARGET_BYTES,
): Promise<string | null> {
  if (!PREVIEWABLE_TYPES.has(file.type) || typeof createImageBitmap !== 'function') return null
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file)
  } catch {
    return null
  }
  try {
    for (const side of PREVIEW_MAX_SIDES) {
      const scale = Math.min(1, side / Math.max(bitmap.width, bitmap.height))
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.round(bitmap.width * scale))
      canvas.height = Math.max(1, Math.round(bitmap.height * scale))
      const ctx = canvas.getContext('2d')
      if (!ctx) return null
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
      for (const quality of PREVIEW_QUALITIES) {
        const blob = await encodeCanvas(canvas, quality)
        if (blob && blob.size <= targetBytes) return await blobToDataUrl(blob)
      }
    }
    return null
  } finally {
    bitmap.close()
  }
}

async function encodeCanvas(canvas: HTMLCanvasElement, quality: number): Promise<Blob | null> {
  const webp = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/webp', quality))
  // toBlob silently falls back to PNG when WebP encoding isn't supported.
  if (webp?.type === 'image/webp') return webp
  return new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', quality))
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = reject
    reader.readAsDataURL(blob)
  })
}

/**
 * Keep previews in attachment order while they fit MESSAGE_PREVIEW_BUDGET_CHARS;
 * drop the rest (those attachments show a download chip until the original arrives).
 */
export function fitPreviewsToBudget(
  attachments: Attachment[],
  budget = MESSAGE_PREVIEW_BUDGET_CHARS,
): Attachment[] {
  let used = 0
  return attachments.map(att => {
    if (!att.previewDataUrl) return att
    if (used + att.previewDataUrl.length > budget) {
      const { previewDataUrl: _dropped, ...rest } = att
      return rest
    }
    used += att.previewDataUrl.length
    return att
  })
}

/** Remove previews that fail validation (received from peers or history sync). */
export function sanitizeAttachments(attachments: Attachment[]): Attachment[] {
  return attachments.map(att => {
    if (att.previewDataUrl === undefined || isValidPreviewDataUrl(att.previewDataUrl)) return att
    const { previewDataUrl: _invalid, ...rest } = att
    return rest
  })
}

// ── Receiver path ─────────────────────────────────────────────────────────────

/** Active download state per contentHash. */
interface DownloadState {
  totalChunks:   number
  receivedChunks: Set<number>
  /** Callbacks waiting for this download to finish. */
  resolvers:     Array<() => void>
}

const activeDownloads = new Map<string, DownloadState>()

/** Called by networkStore when an `attachment_have` comes in (new seeder found). */
let _requestChunksFn: ((contentHash: string, peerId: string, missing: number[]) => void) | null = null

export function setRequestChunksFn(
  fn: (contentHash: string, peerId: string, missing: number[]) => void
) {
  _requestChunksFn = fn
}

/**
 * Register a download so seeders found via `attachment_have` (see `addSeeder`)
 * are asked for the missing chunks. The caller broadcasts `attachment_want` to
 * find seeders. Resolves when the file is complete locally.
 */
export async function downloadAttachment(attachment: Attachment): Promise<void> {
  const hashHex = attachment.contentHash?.replace('blake3:', '')
  if (!hashHex) throw new Error('No contentHash on attachment')

  // Already complete?
  const alreadyHave = await invoke<boolean>('has_attachment', { contentHash: hashHex })
  if (alreadyHave) return

  const totalChunks = await invoke<number>('get_chunk_count', {
    fileSize: attachment.size,
  })

  let state = activeDownloads.get(hashHex)
  if (!state) {
    const received = await invoke<number[]>('get_received_chunks', { contentHash: hashHex })
    state = {
      totalChunks,
      receivedChunks: new Set(received),
      resolvers: [],
    }
    activeDownloads.set(hashHex, state)
  }

  return new Promise((resolve) => {
    state!.resolvers.push(resolve)
  })
}

/** Progress (0–1) of an active download, or null if none is registered. */
export function downloadProgress(contentHash: string): number | null {
  const state = activeDownloads.get(contentHash.replace('blake3:', ''))
  if (!state || state.totalChunks === 0) return null
  return state.receivedChunks.size / state.totalChunks
}

function getMissingChunks(state: DownloadState): number[] {
  const missing: number[] = []
  for (let i = 0; i < state.totalChunks; i++) {
    if (!state.receivedChunks.has(i)) missing.push(i)
  }
  return missing
}

/**
 * Called by networkStore when an `attachment_chunk` arrives.
 * Returns true when the download is complete.
 */
export async function receiveChunk(
  contentHash: string,
  chunkIndex: number,
  data: number[],
  totalChunks: number,
): Promise<boolean> {
  const complete = await invoke<boolean>('save_attachment_chunk', {
    contentHash,
    chunkIndex,
    totalChunks,
    data,
  })

  const state = activeDownloads.get(contentHash)
  if (state) {
    state.receivedChunks.add(chunkIndex)
    if (complete) {
      const resolvers = state.resolvers.splice(0)
      activeDownloads.delete(contentHash)
      resolvers.forEach(r => r())
    }
  }
  return complete
}

/**
 * Add a newly discovered seeder for an in-progress download and request
 * missing chunks from them.
 */
export function addSeeder(contentHash: string, peerId: string) {
  const state = activeDownloads.get(contentHash)
  if (!state || !_requestChunksFn) return
  const missing = getMissingChunks(state)
  if (missing.length > 0) {
    _requestChunksFn(contentHash, peerId, missing)
  }
}

// ── Seeder path ───────────────────────────────────────────────────────────────

/**
 * Read a single chunk for serving to a requesting peer.
 * Returns null if the chunk is not locally available.
 */
export async function readChunkForSeeding(
  contentHash: string,
  chunkIndex: number,
): Promise<number[] | null> {
  return invoke<number[] | null>('read_attachment_chunk', {
    contentHash,
    chunkIndex,
  })
}

// ── URL creation ──────────────────────────────────────────────────────────────

/**
 * Create a blob: URL for a complete locally-stored attachment so the browser can
 * display or offer it for download. Caller is responsible for revoking when done.
 */
export async function createBlobUrl(contentHash: string, mimeType: string): Promise<string | null> {
  const hashHex = contentHash.replace('blake3:', '')
  const isComplete = await invoke<boolean>('has_attachment', { contentHash: hashHex })
  if (!isComplete) return null

  const path = await invoke<string | null>('get_attachment_path', { contentHash: hashHex })
  if (!path) return null

  try {
    const bytes = await readFile(path)
    const blob = new Blob([bytes], { type: mimeType })
    return URL.createObjectURL(blob)
  } catch {
    return null
  }
}
