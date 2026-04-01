/**
 * contextMenuResolver
 *
 * Factory that returns a per-event context menu item resolver.
 */
import type { MenuItem } from '@/stores/uiStore'

const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

interface ResolverOptions {
  sidebarResetWidth: () => void
}

export function createContextMenuResolver(_opts: ResolverOptions) {
  return function resolveMenuItems(event: MouseEvent): MenuItem[] {
    const target = event.target as Element

    // ── Link (external http/https only) ────────────────────────────────
    const link = target.closest('a[href]') as HTMLAnchorElement | null
    if (link) {
      const href = link.getAttribute('href') ?? ''
      if (href.startsWith('http://') || href.startsWith('https://')) {
        return [
          {
            type: 'action',
            label: 'Open in browser',
            callback: () => {
              if (isTauri) {
                import('@tauri-apps/plugin-opener').then(m => m.openUrl(href))
              } else {
                window.open(href, '_blank', 'noopener')
              }
            },
          },
          {
            type: 'action',
            label: 'Copy link',
            callback: () => navigator.clipboard.writeText(href).catch(() => {}),
          },
        ]
      }
    }

    // ── Contenteditable (Cut / Copy / Paste) ───────────────────────────
    if (target.closest('[contenteditable]')) {
      const selection = window.getSelection()
      const hasText   = !!(selection && selection.toString().length > 0)
      const items: MenuItem[] = []

      if (hasText) {
        items.push(
          { type: 'action', label: 'Cut',  shortcut: 'Ctrl+X', callback: () => document.execCommand('cut') },
          { type: 'action', label: 'Copy', shortcut: 'Ctrl+C', callback: () => document.execCommand('copy') },
        )
      }

      items.push({ type: 'action', label: 'Paste', shortcut: 'Ctrl+V', callback: () => document.execCommand('paste') })
      return items
    }

    return []
  }
}
