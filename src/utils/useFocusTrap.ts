/**
 * useFocusTrap — traps keyboard focus inside a container while active.
 */
import { type Ref, nextTick, watch } from 'vue'

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
  'area[href]',
  'details > summary',
].join(',')

export function useFocusTrap(
  containerRef: Ref<HTMLElement | null>,
  active?: Ref<boolean>,
) {
  let previousFocus: HTMLElement | null = null

  function getFocusable(): HTMLElement[] {
    if (!containerRef.value) return []
    return Array.from(
      containerRef.value.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
    ).filter(el => !el.closest('[hidden]'))
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key !== 'Tab') return
    const focusable = getFocusable()
    if (focusable.length === 0) return
    const first = focusable[0]
    const last  = focusable[focusable.length - 1]
    if (e.shiftKey) {
      if (document.activeElement === first || document.activeElement === containerRef.value) {
        e.preventDefault()
        last.focus()
      }
    } else {
      if (document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }
  }

  function activate() {
    previousFocus = document.activeElement as HTMLElement | null
    nextTick(() => {
      if (!containerRef.value) return
      containerRef.value.addEventListener('keydown', onKeydown)
      const first = getFocusable()[0]
      ;(first ?? containerRef.value).focus()
    })
  }

  function deactivate() {
    containerRef.value?.removeEventListener('keydown', onKeydown)
    previousFocus?.focus()
    previousFocus = null
  }

  if (active) {
    watch(active, (val, old) => {
      if (val && !old) activate()
      else if (!val && old) deactivate()
    })
  }

  return { activate, deactivate }
}
