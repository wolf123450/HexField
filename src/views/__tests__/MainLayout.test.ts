/**
 * Tests for MainLayout.vue responsive behaviour.
 *
 * Verifies that the layout applies the correct CSS classes at each breakpoint,
 * and that the mobile bottom nav renders only on small screens.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { createTestingPinia } from '@pinia/testing'

// ── Component mocks (keep layout-test focused on MainLayout logic) ─────────────

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@/components/layout/ServerRail.vue',    () => ({ default: { template: '<div class="server-rail" />' } }))
vi.mock('@/components/layout/ChannelSidebar.vue',() => ({ default: { template: '<aside class="channel-sidebar" />' } }))
vi.mock('@/components/layout/MainPane.vue',      () => ({ default: { template: '<main class="main-pane" />' } }))
vi.mock('@/components/layout/MemberList.vue',    () => ({ default: { template: '<aside class="member-list" />' } }))

// ── Stub helpers ───────────────────────────────────────────────────────────────

// Reset module cache before every test so each `await import(...)` gets a
// fresh instance of MainLayout (and therefore a fresh useBreakpoint call that
// reads the stubbed innerWidth value).
beforeEach(() => {
  vi.resetModules()
  // jsdom doesn't implement matchMedia; prevent the composable's onMounted from throwing
  vi.stubGlobal('matchMedia', undefined)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

async function mountLayout(widthPx: number) {
  vi.stubGlobal('innerWidth', widthPx)
  const { default: MainLayout } = await import('@/views/MainLayout.vue')
  return mount(MainLayout, { global: { plugins: [createTestingPinia()] } })
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('MainLayout — breakpoint classes', () => {
  it('adds layout-mobile class below 640 px', async () => {
    const wrapper = await mountLayout(375)
    expect(wrapper.classes()).toContain('layout-mobile')
    expect(wrapper.classes()).not.toContain('layout-desktop')
  })

  it('adds layout-tablet class at 768 px', async () => {
    const wrapper = await mountLayout(768)
    expect(wrapper.classes()).toContain('layout-tablet')
    expect(wrapper.classes()).not.toContain('layout-mobile')
    expect(wrapper.classes()).not.toContain('layout-desktop')
  })

  it('adds layout-desktop class above 1024 px', async () => {
    const wrapper = await mountLayout(1280)
    expect(wrapper.classes()).toContain('layout-desktop')
    expect(wrapper.classes()).not.toContain('layout-mobile')
  })
})

describe('MainLayout — mobile nav bar', () => {
  it('renders the mobile nav bar below 640 px', async () => {
    const wrapper = await mountLayout(375)
    expect(wrapper.find('.mobile-nav-bar').exists()).toBe(true)
  })

  it('does NOT render the mobile nav bar at 1280 px (desktop)', async () => {
    const wrapper = await mountLayout(1280)
    expect(wrapper.find('.mobile-nav-bar').exists()).toBe(false)
  })

  it('does NOT render the mobile nav bar at 768 px (tablet)', async () => {
    const wrapper = await mountLayout(768)
    expect(wrapper.find('.mobile-nav-bar').exists()).toBe(false)
  })

  it('nav bar has four buttons', async () => {
    const wrapper = await mountLayout(375)
    expect(wrapper.findAll('.mobile-nav-btn')).toHaveLength(4)
  })

  it('clicking Chat nav button calls setMobilePanelView("chat")', async () => {
    const wrapper = await mountLayout(375)
    const { useUIStore } = await import('@/stores/uiStore')
    const uiStore = useUIStore()

    const chatBtn = wrapper.findAll('.mobile-nav-btn')[2]
    await chatBtn.trigger('click')
    expect(uiStore.setMobilePanelView).toHaveBeenCalledWith('chat')
  })
})
