/**
 * useBreakpoint — reactive window-width breakpoints via matchMedia.
 *
 * Breakpoint ranges:
 *   mobile  : width < 640 px
 *   tablet  : 640 px ≤ width ≤ 1024 px
 *   desktop : width > 1024 px
 */
import { ref, computed, onMounted, onUnmounted } from 'vue'

export type Breakpoint = 'mobile' | 'tablet' | 'desktop'

const MOBILE_MAX   = 639   // px
const TABLET_MIN   = 640   // px
const TABLET_MAX   = 1024  // px

function resolveBreakpoint(): Breakpoint {
  if (typeof window === 'undefined') return 'desktop'
  const w = window.innerWidth
  if (w <= MOBILE_MAX) return 'mobile'
  if (w <= TABLET_MAX) return 'tablet'
  return 'desktop'
}

export function useBreakpoint() {
  const breakpoint = ref<Breakpoint>(resolveBreakpoint())

  // Two MediaQueryList objects cover the full range cleanly.
  let mobileMedia: MediaQueryList | null = null
  let tabletMedia: MediaQueryList | null = null

  function update() {
    breakpoint.value = resolveBreakpoint()
  }

  onMounted(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    mobileMedia = window.matchMedia(`(max-width: ${MOBILE_MAX}px)`)
    tabletMedia = window.matchMedia(`(min-width: ${TABLET_MIN}px) and (max-width: ${TABLET_MAX}px)`)
    mobileMedia.addEventListener('change', update)
    tabletMedia.addEventListener('change', update)
  })

  onUnmounted(() => {
    mobileMedia?.removeEventListener('change', update)
    tabletMedia?.removeEventListener('change', update)
  })

  const isMobile  = computed(() => breakpoint.value === 'mobile')
  const isTablet  = computed(() => breakpoint.value === 'tablet')
  const isDesktop = computed(() => breakpoint.value === 'desktop')

  return { breakpoint, isMobile, isTablet, isDesktop }
}
