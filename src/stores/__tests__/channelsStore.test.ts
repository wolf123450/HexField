import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('channelsStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  // ── createChannel ──────────────────────────────────────────────────────────

  it('createChannel adds the channel to channels[serverId]', async () => {
    const { useChannelsStore } = await import('@/stores/channelsStore')
    const { invoke } = await import('@tauri-apps/api/core')
    const store = useChannelsStore()

    vi.mocked(invoke).mockResolvedValue(undefined)

    const ch = await store.createChannel('srv-1', 'general', 'text')

    expect(ch.name).toBe('general')
    expect(ch.type).toBe('text')
    expect(ch.serverId).toBe('srv-1')
    expect(store.channels['srv-1']).toHaveLength(1)
    expect(store.channels['srv-1'][0].id).toBe(ch.id)
  })

  it('createChannel assigns incremental positions', async () => {
    const { useChannelsStore } = await import('@/stores/channelsStore')
    const { invoke } = await import('@tauri-apps/api/core')
    const store = useChannelsStore()

    vi.mocked(invoke).mockResolvedValue(undefined)

    const ch0 = await store.createChannel('srv-1', 'first',  'text')
    const ch1 = await store.createChannel('srv-1', 'second', 'text')
    const ch2 = await store.createChannel('srv-1', 'third',  'text')

    expect(ch0.position).toBe(0)
    expect(ch1.position).toBe(1)
    expect(ch2.position).toBe(2)
  })

  it('createChannel calls db_save_channel with the correct payload', async () => {
    const { useChannelsStore } = await import('@/stores/channelsStore')
    const { invoke } = await import('@tauri-apps/api/core')
    const store = useChannelsStore()

    vi.mocked(invoke).mockResolvedValue(undefined)

    const ch = await store.createChannel('srv-1', 'voice-lobby', 'voice')

    expect(invoke).toHaveBeenCalledWith('db_save_channel', expect.objectContaining({
      channel: expect.objectContaining({
        id:        ch.id,
        server_id: 'srv-1',
        name:      'voice-lobby',
        type:      'voice',
      }),
    }))
  })

  it('createChannel defaults type to text', async () => {
    const { useChannelsStore } = await import('@/stores/channelsStore')
    const { invoke } = await import('@tauri-apps/api/core')
    const store = useChannelsStore()

    vi.mocked(invoke).mockResolvedValue(undefined)

    const ch = await store.createChannel('srv-1', 'default-channel')
    expect(ch.type).toBe('text')
  })

  // ── deleteChannel ──────────────────────────────────────────────────────────

  it('deleteChannel removes the channel from the reactive list', async () => {
    const { useChannelsStore } = await import('@/stores/channelsStore')
    const { invoke } = await import('@tauri-apps/api/core')
    const store = useChannelsStore()

    vi.mocked(invoke).mockResolvedValue(undefined)

    const ch = await store.createChannel('srv-1', 'to-delete', 'text')
    await store.createChannel('srv-1', 'keep-me', 'text')

    expect(store.channels['srv-1']).toHaveLength(2)

    await store.deleteChannel(ch.id)

    expect(store.channels['srv-1']).toHaveLength(1)
    expect(store.channels['srv-1'][0].name).toBe('keep-me')
  })

  it('deleteChannel calls db_delete_channel with the correct id', async () => {
    const { useChannelsStore } = await import('@/stores/channelsStore')
    const { invoke } = await import('@tauri-apps/api/core')
    const store = useChannelsStore()

    vi.mocked(invoke).mockResolvedValue(undefined)

    const ch = await store.createChannel('srv-1', 'bye', 'text')
    vi.clearAllMocks()
    vi.mocked(invoke).mockResolvedValue(undefined)

    await store.deleteChannel(ch.id)
    expect(invoke).toHaveBeenCalledWith('db_delete_channel', { channelId: ch.id })
  })

  it('deleteChannel clears activeChannelId when it matches the deleted channel', async () => {
    const { useChannelsStore } = await import('@/stores/channelsStore')
    const { invoke } = await import('@tauri-apps/api/core')
    const store = useChannelsStore()

    vi.mocked(invoke).mockResolvedValue(undefined)

    const ch = await store.createChannel('srv-1', 'active', 'text')
    store.setActiveChannel(ch.id)
    expect(store.activeChannelId).toBe(ch.id)

    await store.deleteChannel(ch.id)
    expect(store.activeChannelId).toBeNull()
  })

  // ── renameChannel ──────────────────────────────────────────────────────────

  it('renameChannel updates the channel name in reactive state', async () => {
    const { useChannelsStore } = await import('@/stores/channelsStore')
    const { invoke } = await import('@tauri-apps/api/core')
    const store = useChannelsStore()

    vi.mocked(invoke).mockResolvedValue(undefined)

    const ch = await store.createChannel('srv-1', 'old-name', 'text')
    await store.renameChannel(ch.id, 'new-name')

    const found = store.channels['srv-1'].find(c => c.id === ch.id)
    expect(found?.name).toBe('new-name')
  })

  it('renameChannel calls db_save_channel with the new name', async () => {
    const { useChannelsStore } = await import('@/stores/channelsStore')
    const { invoke } = await import('@tauri-apps/api/core')
    const store = useChannelsStore()

    vi.mocked(invoke).mockResolvedValue(undefined)

    const ch = await store.createChannel('srv-1', 'original', 'text')
    vi.clearAllMocks()
    vi.mocked(invoke).mockResolvedValue(undefined)

    await store.renameChannel(ch.id, 'renamed')
    expect(invoke).toHaveBeenCalledWith('db_save_channel', expect.objectContaining({
      channel: expect.objectContaining({ id: ch.id, name: 'renamed' }),
    }))
  })

  // ── setActiveChannel ───────────────────────────────────────────────────────

  it('setActiveChannel updates activeChannelId', async () => {
    const { useChannelsStore } = await import('@/stores/channelsStore')
    const store = useChannelsStore()

    store.setActiveChannel('ch-abc')
    expect(store.activeChannelId).toBe('ch-abc')
  })

  it('setActiveChannel accepts null to clear selection', async () => {
    const { useChannelsStore } = await import('@/stores/channelsStore')
    const store = useChannelsStore()

    store.setActiveChannel('ch-abc')
    store.setActiveChannel(null)
    expect(store.activeChannelId).toBeNull()
  })
})
