import { defineStore } from 'pinia'
import { ref } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import type { CustomEmoji } from '@/types/core'
import { APP_STORAGE_PREFIX } from '@/appConfig'

const RECENT_KEY = APP_STORAGE_PREFIX + 'recent_emoji'
const MAX_RECENT = 20

export const useEmojiStore = defineStore('emoji', () => {
  // [serverId][emojiId] → CustomEmoji metadata
  const custom     = ref<Record<string, Record<string, CustomEmoji>>>({})
  // emojiId → data: URI
  const imageCache = ref<Record<string, string>>({})
  // recent emoji ids (max 20)
  const recent     = ref<string[]>(loadRecent())

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
  }

  return {
    custom,
    imageCache,
    recent,
    loadEmoji,
    getEmojiImage,
    receiveEmojiSync,
    useEmoji,
  }
})

function loadRecent(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY)
    return raw ? JSON.parse(raw) : []
  } catch { return [] }
}
