import { defineStore } from 'pinia'
import { ref, watch } from 'vue'

export const usePersonalBlocksStore = defineStore('personalBlocks', () => {
  const blockedUsers = ref<string[]>([])
  const mutedUsers   = ref<string[]>([])

  // ── Persistence ─────────────────────────────────────────────────────────────

  function blocksKey(userId: string)  { return `hexfield_personal_blocks_${userId}` }
  function mutesKey(userId: string)   { return `hexfield_personal_mutes_${userId}` }

  function load(myUserId: string) {
    try {
      const b = localStorage.getItem(blocksKey(myUserId))
      blockedUsers.value = b ? (JSON.parse(b) as string[]) : []
    } catch { blockedUsers.value = [] }
    try {
      const m = localStorage.getItem(mutesKey(myUserId))
      mutedUsers.value = m ? (JSON.parse(m) as string[]) : []
    } catch { mutedUsers.value = [] }
  }

  // myUserId must be set once identity is ready; call load() from the
  // component / composable that initialises the identity store.
  function init(myUserId: string) {
    load(myUserId)

    watch(blockedUsers, (val) => {
      localStorage.setItem(blocksKey(myUserId), JSON.stringify(val))
    }, { deep: true })

    watch(mutedUsers, (val) => {
      localStorage.setItem(mutesKey(myUserId), JSON.stringify(val))
      // Apply audio effect for any currently active peer streams
      import('@/services/audioService').then(({ audioService }) => {
        for (const uid of val) audioService.setPersonallyMuted(uid, true)
      })
    }, { deep: true })
  }

  // ── Actions ─────────────────────────────────────────────────────────────────

  function blockUser(userId: string) {
    if (!blockedUsers.value.includes(userId)) {
      blockedUsers.value = [...blockedUsers.value, userId]
    }
  }

  function unblockUser(userId: string) {
    blockedUsers.value = blockedUsers.value.filter(id => id !== userId)
  }

  function muteUser(userId: string) {
    if (!mutedUsers.value.includes(userId)) {
      mutedUsers.value = [...mutedUsers.value, userId]
      import('@/services/audioService').then(({ audioService }) => {
        audioService.setPersonallyMuted(userId, true)
      })
    }
  }

  function unmuteUser(userId: string) {
    mutedUsers.value = mutedUsers.value.filter(id => id !== userId)
    import('@/services/audioService').then(({ audioService }) => {
      audioService.setPersonallyMuted(userId, false)
    })
  }

  function isBlocked(userId: string): boolean {
    return blockedUsers.value.includes(userId)
  }

  function isMuted(userId: string): boolean {
    return mutedUsers.value.includes(userId)
  }

  return {
    blockedUsers,
    mutedUsers,
    init,
    load,
    blockUser,
    unblockUser,
    muteUser,
    unmuteUser,
    isBlocked,
    isMuted,
  }
})
