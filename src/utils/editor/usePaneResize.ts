/**
 * usePaneResize
 *
 * Drag-to-resize helper for sidebar / right-panel panes.
 * Updates a CSS variable on :root and persists the width to localStorage.
 */
export interface PaneResizeOptions {
  cssVar: string
  min: number
  max: number
  storageKey: string
  getWidth: (clientX: number) => number
}

export function usePaneResize(opts: PaneResizeOptions) {
  function restoreWidth() {
    const saved = localStorage.getItem(opts.storageKey)
    if (saved) {
      const w = parseInt(saved, 10)
      if (w >= opts.min && w <= opts.max) {
        document.documentElement.style.setProperty(opts.cssVar, `${w}px`)
      }
    }
  }

  function onDividerMousedown(e: MouseEvent) {
    if (e.button !== 0) return
    e.preventDefault()

    document.body.style.userSelect = 'none'
    document.body.classList.add('pane-resizing')

    function onMousemove(me: MouseEvent) {
      const w = Math.min(opts.max, Math.max(opts.min, opts.getWidth(me.clientX)))
      document.documentElement.style.setProperty(opts.cssVar, `${w}px`)
    }

    function onMouseup() {
      document.body.style.userSelect = ''
      document.body.classList.remove('pane-resizing')
      const current = getComputedStyle(document.documentElement)
        .getPropertyValue(opts.cssVar)
        .trim()
        .replace('px', '')
      localStorage.setItem(opts.storageKey, current)
      window.removeEventListener('mousemove', onMousemove)
      window.removeEventListener('mouseup', onMouseup)
    }

    window.addEventListener('mousemove', onMousemove)
    window.addEventListener('mouseup', onMouseup)
  }

  function resetWidth() {
    localStorage.removeItem(opts.storageKey)
    document.documentElement.style.removeProperty(opts.cssVar)
  }

  return { onDividerMousedown, restoreWidth, resetWidth }
}
