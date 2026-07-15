import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createTestingPinia } from '@pinia/testing'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }))
vi.mock('@/utils/useFocusTrap', () => ({ useFocusTrap: vi.fn() }))
vi.mock('@/stores/uiStore', () => ({
  useUIStore: () => ({
    showSettings: true,
    theme: 'dark',
    showNotification: vi.fn(),
  }),
}))

// Render Teleport inline so wrapper queries work in jsdom
const TeleportStub = { template: '<div><slot /></div>' }

describe('SettingsNetworkTab', () => {
  it('has Network tab and Rendezvous URL absent from Voice & Video tab', async () => {
    const { default: Settings } = await import('@/components/Settings.vue')
    const wrapper = mount(Settings, {
      global: {
        plugins: [createTestingPinia({ createSpy: vi.fn })],
        stubs: {
          Teleport: TeleportStub,
          SettingsProfileTab: { template: '<div>Profile</div>' },
          SettingsVoiceTab: { template: '<div>Voice content</div>' },
          SettingsNetworkTab: { template: '<div><span>Rendezvous Server URL</span></div>' },
          SettingsPrivacyTab: { template: '<div>Privacy</div>' },
          SettingsNotificationsTab: { template: '<div>Notifications</div>' },
          SettingsAppearanceTab: { template: '<div>Appearance</div>' },
          SettingsShortcutsTab: { template: '<div>Shortcuts</div>' },
          SettingsExperimentalTab: { template: '<div>Experimental</div>' },
          SettingsHelpTab: { template: '<div>Help</div>' },
        },
      },
    })

    const tabButtons = wrapper.findAll('button.tab-btn')
    const tabLabels  = tabButtons.map(b => b.text())
    expect(tabLabels).toContain('Network')

    const voiceTabBtn = tabButtons.find(b => b.text() === 'Voice & Video')
    await voiceTabBtn!.trigger('click')
    expect(wrapper.text()).not.toContain('Rendezvous Server URL')

    const networkTabBtn = wrapper.findAll('button.tab-btn').find(b => b.text() === 'Network')
    await networkTabBtn!.trigger('click')
    expect(wrapper.text()).toContain('Rendezvous Server URL')
  })

  it('SettingsNetworkTab standalone has Rendezvous URL, TURN Servers, and NAT Type', async () => {
    const { default: SettingsNetworkTab } = await import('@/components/settings/SettingsNetworkTab.vue')
    const wrapper = mount(SettingsNetworkTab, {
      global: { plugins: [createTestingPinia({ createSpy: vi.fn })] },
    })
    expect(wrapper.text()).toContain('Rendezvous Server URL')
    expect(wrapper.text()).toContain('Custom TURN Servers')
    expect(wrapper.text()).toContain('NAT Type')
  })
})
