/**
 * Auto-update service using tauri-plugin-updater.
 */

import { useUIStore } from '@/stores/uiStore'
import { APP_NAME } from '@/appConfig'

const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

export interface UpdateResult {
  available: boolean
  version?: string
  body?: string | null
}

export async function checkForUpdate(): Promise<UpdateResult> {
  if (import.meta.env.DEV || !isTauri) return { available: false }

  try {
    const { check } = await import('@tauri-apps/plugin-updater')
    const update = await check()
    if (update) return { available: true, version: update.version, body: update.body }
    return { available: false }
  } catch (e) {
    console.warn('[updater] Failed to check for updates:', e)
    return { available: false }
  }
}

export async function downloadAndInstallUpdate(): Promise<void> {
  if (import.meta.env.DEV || !isTauri) return

  const uiStore = useUIStore()

  try {
    const { check } = await import('@tauri-apps/plugin-updater')
    const update = await check()

    if (!update) {
      uiStore.showNotification('No update available.', 'info')
      return
    }

    uiStore.showNotification('Downloading update…', 'info', 0)
    await update.downloadAndInstall()

    uiStore.showNotification(
      'Update installed — restart to apply.',
      'success',
      0,
      {
        label: 'Restart now',
        callback: async () => {
          const { relaunch } = await import('@tauri-apps/plugin-process')
          await relaunch()
        },
      }
    )
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    uiStore.showNotification(`Update failed: ${msg}`, 'error')
  }
}

export async function autoCheckForUpdate(): Promise<void> {
  const result = await checkForUpdate()
  if (result.available && result.version) {
    const uiStore = useUIStore()
    uiStore.showNotification(
      `${APP_NAME} v${result.version} is available`,
      'info',
      0,
      { label: 'Install update', callback: () => downloadAndInstallUpdate() }
    )
  }
}
