/**
 * Tests for useBreakpoint composable.
 * Mocks window.matchMedia and window.innerWidth to simulate breakpoint boundaries.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { createApp, defineComponent } from 'vue'

// ── matchMedia mock factory ────────────────────────────────────────────────────

function stubMatchMedia(width: number) {
  vi.stubGlobal('innerWidth', width)
  vi.stubGlobal('matchMedia', (query: string): MediaQueryList => {
    // Parse "max-width: Npx" and "min-width: Npx" from the query string.
    const maxMatch = query.match(/max-width:\s*(\d+)px/)
    const minMatch = query.match(/min-width:\s*(\d+)px/)

    let matches: boolean
    if (maxMatch && minMatch) {
      // Compound: (min-width: A) and (max-width: B)
      matches = width >= parseInt(minMatch[1]) && width <= parseInt(maxMatch[1])
    } else if (maxMatch) {
      matches = width <= parseInt(maxMatch[1])
    } else if (minMatch) {
      matches = width >= parseInt(minMatch[1])
    } else {
      matches = false
    }

    return {
      matches,
      media:          query,
      onchange:       null,
      addListener:    vi.fn(),
      removeListener: vi.fn(),
      addEventListener:    vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent:  vi.fn(),
    } as unknown as MediaQueryList
  })
}

// ── Mount helper ───────────────────────────────────────────────────────────────

function mount<T>(composable: () => T): T {
  let result!: T
  const el = document.createElement('div')
  const app = createApp(defineComponent({
    setup() { result = composable(); return () => null },
  }))
  app.mount(el)
  return result
}

// ── Tests ──────────────────────────────────────────────────────────────────────

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('useBreakpoint', () => {
  it('returns "mobile" when width is below 640 px', async () => {
    stubMatchMedia(375)
    const { useBreakpoint } = await import('@/utils/useBreakpoint')
    const { breakpoint, isMobile, isTablet, isDesktop } = mount(() => useBreakpoint())

    expect(breakpoint.value).toBe('mobile')
    expect(isMobile.value).toBe(true)
    expect(isTablet.value).toBe(false)
    expect(isDesktop.value).toBe(false)
  })

  it('returns "mobile" exactly at the upper bound (639 px)', async () => {
    stubMatchMedia(639)
    const { useBreakpoint } = await import('@/utils/useBreakpoint')
    const { breakpoint } = mount(() => useBreakpoint())
    expect(breakpoint.value).toBe('mobile')
  })

  it('returns "tablet" when width is exactly 640 px (lower bound)', async () => {
    stubMatchMedia(640)
    const { useBreakpoint } = await import('@/utils/useBreakpoint')
    const { breakpoint, isTablet } = mount(() => useBreakpoint())
    expect(breakpoint.value).toBe('tablet')
    expect(isTablet.value).toBe(true)
  })

  it('returns "tablet" when width is within 640–1024 px', async () => {
    stubMatchMedia(800)
    const { useBreakpoint } = await import('@/utils/useBreakpoint')
    const { breakpoint } = mount(() => useBreakpoint())
    expect(breakpoint.value).toBe('tablet')
  })

  it('returns "tablet" exactly at the upper bound (1024 px)', async () => {
    stubMatchMedia(1024)
    const { useBreakpoint } = await import('@/utils/useBreakpoint')
    const { breakpoint } = mount(() => useBreakpoint())
    expect(breakpoint.value).toBe('tablet')
  })

  it('returns "desktop" when width is exactly 1025 px (lower bound)', async () => {
    stubMatchMedia(1025)
    const { useBreakpoint } = await import('@/utils/useBreakpoint')
    const { breakpoint, isDesktop } = mount(() => useBreakpoint())
    expect(breakpoint.value).toBe('desktop')
    expect(isDesktop.value).toBe(true)
  })

  it('returns "desktop" when width is 1280 px', async () => {
    stubMatchMedia(1280)
    const { useBreakpoint } = await import('@/utils/useBreakpoint')
    const { breakpoint } = mount(() => useBreakpoint())
    expect(breakpoint.value).toBe('desktop')
  })

  it('does not throw when matchMedia is unavailable (old browser guard)', async () => {
    stubMatchMedia(800)
    // Override matchMedia to be undefined after innerWidth is set
    vi.stubGlobal('matchMedia', undefined)
    const { useBreakpoint } = await import('@/utils/useBreakpoint')
    expect(() => mount(() => useBreakpoint())).not.toThrow()
  })
})
