import { defineStore } from 'pinia'
import type { SoundEvent } from '@/types/core'
import { soundService } from '@/services/soundService'

export interface NotificationEvent {
  type:       SoundEvent
  serverId?:  string
  channelId?: string
  authorId?:  string
  content?:   string   // raw plaintext for mention/keyword detection
  titleText:  string
  bodyText?:  string
}

export const useNotificationStore = defineStore('notifications', () => {

  async function notify(event: NotificationEvent): Promise<void> {
    const { useSettingsStore }  = await import('./settingsStore')
    const { useIdentityStore }  = await import('./identityStore')
    const settings   = useSettingsStore().settings
    const myName     = useIdentityStore().displayName ?? ''
    const now        = Date.now()

    const chPrefs  = event.channelId ? settings.channelNotificationPrefs[event.channelId]  : undefined
    const srvPrefs = event.serverId  ? settings.serverNotificationPrefs[event.serverId]    : undefined

    // ── Step 1–2: timed mutes ──────────────────────────────────────────────
    if (chPrefs?.muteUntil  && chPrefs.muteUntil  > now) return
    if (srvPrefs?.muteUntil && srvPrefs.muteUntil > now) return

    // ── Step 3: channel-level override (not inherit) ───────────────────────
    const chLevel = chPrefs?.level && chPrefs.level !== 'inherit' ? chPrefs.level : undefined

    if (chLevel === 'muted') return

    // ── Step 4: server-level fallback ──────────────────────────────────────
    const srvLevel = srvPrefs?.level ?? 'mentions'  // default = 'mentions'

    if (srvLevel === 'muted') return

    // Effective level = channel override if set, else server level
    const effectiveLevel = chLevel ?? srvLevel

    // ── Step 5: mention/keyword check when level = 'mentions' ──────────────
    // Voice events (join_self, join_other, leave) are sounds, not messages;
    // they are never filtered by the message-level rules.
    const isMessageEvent = event.type === 'message' || event.type === 'mention'

    if (isMessageEvent && effectiveLevel === 'mentions') {
      const content = (event.content ?? '').toLowerCase()
      const mentioned = myName && content.includes(`@${myName.toLowerCase()}`)

      const keywordMatch = settings.keywordFilters.some(f => {
        // Scope: undefined = global; if scoped, only match that server
        if (f.serverId && f.serverId !== event.serverId) return false
        return content.includes(f.keyword.toLowerCase())
      })

      if (!mentioned && !keywordMatch) return
    }

    // ── Event passes — dispatch sound and/or OS notification ──────────────
    if (settings.soundEnabled) {
      soundService.play(event.type).catch(() => {})
    }

    if (settings.notificationsEnabled) {
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window')
        const focused = await getCurrentWindow().isFocused()
        if (!focused) {
          const { sendNotification, isPermissionGranted, requestPermission } =
            await import('@tauri-apps/plugin-notification')
          let granted = await isPermissionGranted()
          if (!granted) {
            const perm = await requestPermission()
            granted = perm === 'granted'
          }
          if (granted) {
            sendNotification({
              title: event.titleText,
              body:  event.bodyText?.slice(0, 120),
            })
          }
        }
      } catch {
        // Tauri APIs unavailable in browser dev mode — ignore
      }
    }
  }

  return { notify }
})
