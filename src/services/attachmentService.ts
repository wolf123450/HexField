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

export const CHUNK_SIZE = 256 * 1024 // must match Rust CHUNK_SIZE

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
 * since the sender already has all the bytes.
 */
export async function prepareAttachment(file: File): Promise<Attachment> {
  const bytes = await readFileBytes(file)
  const hash = await hashBytes(bytes)
  const contentHash = `blake3:${hash}`

  await invoke('save_attachment', {
    contentHash: hash,
    data: Array.from(bytes),
  })

  return {
    id:            crypto.randomUUID(),
    name:          file.name,
    size:          file.size,
    mimeType:      file.type || 'application/octet-stream',
    contentHash,
    chunkSize:     CHUNK_SIZE,
    transferState: 'complete',
  }
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
 * Begin (or resume) downloading an attachment from one or more peers.
 * Returns a Promise that resolves when the download is complete.
 */
export async function downloadAttachment(
  attachment: Attachment,
  _peerId: string,
): Promise<void> {
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
    const missing = getMissingChunks(state!)
    if (missing.length > 0 && _requestChunksFn) {
      _requestChunksFn(hashHex, _peerId, missing)
    }
  })
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
