import { describe, it, expect, vi, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'

// ── Hoist mock fns so vi.mock() factories can reference them ─────────────────
const { mockSoundPlay, mockSendNotification, mockIsPermissionGranted } = vi.hoisted(() => ({
  mockSoundPlay:           vi.fn(),
  mockSendNotification:    vi.fn(),
  mockIsPermissionGranted: vi.fn(),
}))

// ── Mutable state for per-test overrides ─────────────────────────────────────
let mockWindowFocused = false
let mockSettings = {
  notificationsEnabled: true,
  soundEnabled: true,
  serverNotificationPrefs: {} as Record<string, { level?: string; muteUntil?: number }>,
  channelNotificationPrefs: {} as Record<string, { level?: string; muteUntil?: number }>,
  keywordFilters: [] as Array<{ id: string; keyword: string; serverId?: string }>,
}

// ── Module mocks ─────────────────────────────────────────────────────────────
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    isFocused: vi.fn().mockImplementation(() => Promise.resolve(mockWindowFocused)),
  }),
}))

vi.mock('@tauri-apps/plugin-notification', () => ({
  sendNotification:    mockSendNotification,
  isPermissionGranted: mockIsPermissionGranted,
  requestPermission:   vi.fn().mockResolvedValue('granted'),
}))

vi.mock('@/services/soundService', () => ({
  soundService: {
    play:             mockSoundPlay,
    setCustomSound:   vi.fn(),
    clearCustomSound: vi.fn(),
    loadFromSettings: vi.fn(),
  },
}))

vi.mock('@/stores/settingsStore', () => ({
  useSettingsStore: () => ({ settings: mockSettings }),
}))

vi.mock('@/stores/identityStore', () => ({
  useIdentityStore: () => ({ displayName: 'Alice', userId: 'user-alice' }),
}))

// ── Import store after mocks are set up ──────────────────────────────────────
import { useNotificationStore } from '../notificationStore'

// ── Tests ────────────────────────────────────────────────────────────────────
describe('notificationStore — rules hierarchy', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    mockSoundPlay.mockResolvedValue(undefined)
    mockIsPermissionGranted.mockResolvedValue(true)
    mockWindowFocused = false
    mockSettings = {
      notificationsEnabled: true,
      soundEnabled: true,
      serverNotificationPrefs: {},
      channelNotificationPrefs: {},
      keywordFilters: [],
    }
  })

  it('fires OS notification + sound for a mention when window is not focused', async () => {
    const store = useNotificationStore()
    await store.notify({
      type:      'mention',
      serverId:  'srv1',
      channelId: 'ch1',
      content:   'hey @Alice check this out',
      titleText: 'Bob mentioned you',
      bodyText:  'hey @Alice check this out',
    })
    expect(mockSendNotification).toHaveBeenCalledOnce()
    expect(mockSoundPlay).toHaveBeenCalledWith('mention')
  })

  it('plays sound but suppresses OS notification when window IS focused', async () => {
    mockWindowFocused = true
    const store = useNotificationStore()
    await store.notify({
      type:      'mention',
      serverId:  'srv1',
      channelId: 'ch1',
      content:   'hey @Alice',
      titleText: 'Mention',
      bodyText:  'hey @Alice',
    })
    expect(mockSendNotification).not.toHaveBeenCalled()
    expect(mockSoundPlay).toHaveBeenCalledWith('mention')
  })

  it('blocks everything when channel is muted (muteUntil in future)', async () => {
    mockSettings.channelNotificationPrefs['ch1'] = {
      level: 'inherit',
      muteUntil: Date.now() + 3_600_000,
    }
    const store = useNotificationStore()
    await store.notify({
      type:      'mention',
      serverId:  'srv1',
      channelId: 'ch1',
      content:   'hey @Alice',
      titleText: 'Mention',
      bodyText:  'hey @Alice',
    })
    expect(mockSendNotification).not.toHaveBeenCalled()
    expect(mockSoundPlay).not.toHaveBeenCalled()
  })

  it('passes when muteUntil is in the past', async () => {
    mockSettings.channelNotificationPrefs['ch1'] = {
      level: 'inherit',
      muteUntil: Date.now() - 1000,
    }
    const store = useNotificationStore()
    await store.notify({
      type:      'mention',
      serverId:  'srv1',
      channelId: 'ch1',
      content:   'hey @Alice',
      titleText: 'Mention',
      bodyText:  'hey @Alice',
    })
    expect(mockSoundPlay).toHaveBeenCalled()
  })

  it('blocks non-mention message when server level is "mentions"', async () => {
    mockSettings.serverNotificationPrefs['srv1'] = { level: 'mentions' }
    const store = useNotificationStore()
    await store.notify({
      type:      'message',
      serverId:  'srv1',
      channelId: 'ch1',
      content:   'just a regular message',
      titleText: 'Bob',
      bodyText:  'just a regular message',
    })
    expect(mockSendNotification).not.toHaveBeenCalled()
    expect(mockSoundPlay).not.toHaveBeenCalled()
  })

  it('passes non-mention when server level is "all"', async () => {
    mockSettings.serverNotificationPrefs['srv1'] = { level: 'all' }
    const store = useNotificationStore()
    await store.notify({
      type:      'message',
      serverId:  'srv1',
      channelId: 'ch1',
      content:   'hello everyone',
      titleText: 'Bob',
      bodyText:  'hello everyone',
    })
    expect(mockSoundPlay).toHaveBeenCalled()
  })

  it('keyword match elevates a "mentions"-level server event to pass', async () => {
    mockSettings.serverNotificationPrefs['srv1'] = { level: 'mentions' }
    mockSettings.keywordFilters = [{ id: 'k1', keyword: 'urgent' }]
    const store = useNotificationStore()
    await store.notify({
      type:      'message',
      serverId:  'srv1',
      channelId: 'ch1',
      content:   'this is urgent!!',
      titleText: 'Bob',
      bodyText:  'this is urgent!!',
    })
    expect(mockSoundPlay).toHaveBeenCalled()
  })

  it('keyword does NOT override a mute', async () => {
    mockSettings.serverNotificationPrefs['srv1'] = { level: 'muted' }
    mockSettings.keywordFilters = [{ id: 'k1', keyword: 'urgent' }]
    const store = useNotificationStore()
    await store.notify({
      type:      'message',
      serverId:  'srv1',
      channelId: 'ch1',
      content:   'this is urgent!!',
      titleText: 'Bob',
      bodyText:  'this is urgent!!',
    })
    expect(mockSoundPlay).not.toHaveBeenCalled()
    expect(mockSendNotification).not.toHaveBeenCalled()
  })

  it('plays join_other sound for voice join event', async () => {
    const store = useNotificationStore()
    await store.notify({
      type:      'join_other',
      serverId:  'srv1',
      channelId: 'ch1',
      titleText: 'Bob joined voice',
      bodyText:  undefined,
    })
    expect(mockSoundPlay).toHaveBeenCalledWith('join_other')
  })
})
