import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import { v7 as uuidv7 } from 'uuid'
import type { CustomEmoji } from '@/types/core'
import { APP_STORAGE_PREFIX } from '@/appConfig'

const RECENT_KEY = APP_STORAGE_PREFIX + 'recent_emoji'
const USAGE_KEY  = APP_STORAGE_PREFIX + 'emoji_usage'
const MAX_RECENT = 20
const TOP_N      = 3

export const useEmojiStore = defineStore('emoji', () => {
  // [serverId][emojiId] → CustomEmoji metadata
  const custom     = ref<Record<string, Record<string, CustomEmoji>>>({})
  // emojiId → data: URI
  const imageCache = ref<Record<string, string>>({})
  // recent emoji ids (max 20)
  const recent       = ref<string[]>(loadRecent())
  // emojiId → usage count (persisted)
  const usageCounts  = ref<Record<string, number>>(loadUsageCounts())

  // top N emoji by usage count
  const topEmoji = computed<string[]>(() =>
    Object.entries(usageCounts.value)
      .sort((a, b) => b[1] - a[1])
      .slice(0, TOP_N)
      .map(([id]) => id)
  )

  async function loadEmoji(serverId: string) {
    const rows = await invoke<any[]>('db_load_emoji', { serverId })
    const map: Record<string, CustomEmoji> = {}
    for (const r of rows) {
      map[r.id] = {
        id:         r.id,
        serverId:   r.server_id,
        name:       r.name,
        uploadedBy: r.uploaded_by,
        createdAt:  r.created_at,
      }
    }
    custom.value[serverId] = map
  }

  async function getEmojiImage(emojiId: string, serverId: string): Promise<string> {
    if (imageCache.value[emojiId]) return imageCache.value[emojiId]

    const bytes = await invoke<number[]>('get_emoji_image', { emojiId, serverId })
    const base64 = btoa(String.fromCharCode(...new Uint8Array(bytes)))
    const dataUrl = `data:image/webp;base64,${base64}`
    imageCache.value[emojiId] = dataUrl
    return dataUrl
  }

  function receiveEmojiSync(metadata: CustomEmoji) {
    if (!custom.value[metadata.serverId]) custom.value[metadata.serverId] = {}
    custom.value[metadata.serverId][metadata.id] = metadata
  }

  function useEmoji(emojiId: string) {
    recent.value = [emojiId, ...recent.value.filter(id => id !== emojiId)].slice(0, MAX_RECENT)
    localStorage.setItem(RECENT_KEY, JSON.stringify(recent.value))
    usageCounts.value[emojiId] = (usageCounts.value[emojiId] ?? 0) + 1
    localStorage.setItem(USAGE_KEY, JSON.stringify(usageCounts.value))
  }

  async function uploadCustomEmoji(serverId: string, name: string, file: File): Promise<void> {
    if (!['image/png', 'image/webp', 'image/gif'].includes(file.type)) {
      throw new Error('Invalid type: only PNG, WebP, or GIF allowed')
    }
    if (file.size > 256 * 1024) throw new Error('File too large: max 256KB')

    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 128
    const ctx = canvas.getContext('2d')!
    const img = await createImageBitmap(file)
    ctx.drawImage(img, 0, 0, 128, 128)
    const blob = await new Promise<Blob>((res, rej) =>
      canvas.toBlob(b => b ? res(b) : rej(new Error('Canvas toBlob failed')), 'image/webp', 0.85)
    )

    const { useIdentityStore } = await import('./identityStore')
    const identityStore = useIdentityStore()

    const id = uuidv7()
    const imageBytes = Array.from(new Uint8Array(await blob.arrayBuffer()))
    const emojiMeta: CustomEmoji = {
      id,
      serverId,
      name,
      uploadedBy: identityStore.userId!,
      createdAt: new Date().toISOString(),
    }

    await invoke('db_save_emoji', { emoji: {
      id: emojiMeta.id,
      server_id: emojiMeta.serverId,
      name: emojiMeta.name,
      uploaded_by: emojiMeta.uploadedBy,
      created_at: emojiMeta.createdAt,
    }, imageBytes })

    if (!custom.value[serverId]) custom.value[serverId] = {}
    custom.value[serverId][id] = emojiMeta

    const dataUrl = `data:image/webp;base64,${btoa(String.fromCharCode(...new Uint8Array(imageBytes)))}`
    imageCache.value[id] = dataUrl

    const { useNetworkStore } = await import('./networkStore')
    useNetworkStore().broadcast({
      type: 'emoji_sync',
      serverId,
      emoji: { id, name, uploadedBy: emojiMeta.uploadedBy, createdAt: emojiMeta.createdAt },
    })
  }

  async function storeEmojiImage(emojiId: string, serverId: string, imageBytes: number[]): Promise<void> {
    await invoke('store_emoji_image', { emojiId, serverId, imageBytes })
    const base64 = btoa(String.fromCharCode(...new Uint8Array(imageBytes)))
    imageCache.value[emojiId] = `data:image/webp;base64,${base64}`
  }

  return {
    custom,
    imageCache,
    recent,
    topEmoji,
    usageCounts,
    loadEmoji,
    getEmojiImage,
    receiveEmojiSync,
    useEmoji,
    uploadCustomEmoji,
    storeEmojiImage,
  }
})

function loadRecent(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY)
    return raw ? JSON.parse(raw) : []
  } catch { return [] }
}

function loadUsageCounts(): Record<string, number> {
  try {
    const raw = localStorage.getItem(USAGE_KEY)
    return raw ? JSON.parse(raw) : {}
  } catch { return {} }
}
