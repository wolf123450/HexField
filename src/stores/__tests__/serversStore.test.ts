import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { Server, ServerMember } from '@/types/core'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeServer(id = 's-1'): Server {
  return {
    id,
    name:        'Test Server',
    ownerId:     'user-alice',
    memberCount: 1,
    createdAt:   '2025-01-01T00:00:00.000Z',
    customEmoji: [],
  }
}

function makeMemberPayload(overrides: Partial<ServerMember & { avatarDataUrl?: string }> = {}) {
  return {
    userId:        'user-bob',
    serverId:      's-1',
    displayName:   'Bob',
    publicSignKey: 'sign-pub-bob',
    publicDHKey:   'dh-pub-bob',
    roles:         ['member'] as string[],
    joinedAt:      '2025-01-01T00:00:00.000Z',
    onlineStatus:  'online' as const,
    ...overrides,
  }
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('serversStore.upsertMember', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  it('silently rejects upsert for an unknown serverId', async () => {
    const { useServersStore } = await import('@/stores/serversStore')
    const { invoke } = await import('@tauri-apps/api/core')
    const store = useServersStore()

    // No server seeded — the guard should prevent any action
    await store.upsertMember(makeMemberPayload())

    expect(invoke).not.toHaveBeenCalled()
    expect(store.members['s-1']).toBeUndefined()
  })

  it('adds member to reactive state after DB upsert', async () => {
    const { useServersStore } = await import('@/stores/serversStore')
    const { invoke } = await import('@tauri-apps/api/core')
    const store = useServersStore()

    // Seed the server so the guard passes
    store.servers['s-1'] = makeServer()
    vi.mocked(invoke).mockResolvedValue(undefined)

    await store.upsertMember(makeMemberPayload({ displayName: 'Bob' }))

    expect(invoke).toHaveBeenCalledWith('db_upsert_member', expect.anything())
    expect(store.members['s-1']?.['user-bob']).toMatchObject({
      userId:      'user-bob',
      displayName: 'Bob',
    })
  })

  it('applies incoming avatarDataUrl to the reactive entry', async () => {
    const { useServersStore } = await import('@/stores/serversStore')
    const { invoke } = await import('@tauri-apps/api/core')
    const store = useServersStore()

    store.servers['s-1'] = makeServer()
    vi.mocked(invoke).mockResolvedValue(undefined)

    await store.upsertMember(makeMemberPayload({ avatarDataUrl: 'data:image/png;base64,abc' }))

    expect(store.members['s-1']?.['user-bob']?.avatarDataUrl).toBe('data:image/png;base64,abc')
  })

  it('preserves existing avatarDataUrl when caller omits it', async () => {
    const { useServersStore } = await import('@/stores/serversStore')
    const { invoke } = await import('@tauri-apps/api/core')
    const store = useServersStore()

    store.servers['s-1'] = makeServer()
    vi.mocked(invoke).mockResolvedValue(undefined)

    // First upsert sets the avatar
    await store.upsertMember(makeMemberPayload({ avatarDataUrl: 'data:image/png;base64,original' }))
    expect(store.members['s-1']?.['user-bob']?.avatarDataUrl).toBe('data:image/png;base64,original')

    // Second upsert (e.g. name change) does not supply avatarDataUrl
    await store.upsertMember(makeMemberPayload({ displayName: 'Bobby' }))

    // Avatar must be preserved
    expect(store.members['s-1']?.['user-bob']?.avatarDataUrl).toBe('data:image/png;base64,original')
    expect(store.members['s-1']?.['user-bob']?.displayName).toBe('Bobby')
  })

  it('a newer upsert can overwrite avatarDataUrl with a new value', async () => {
    const { useServersStore } = await import('@/stores/serversStore')
    const { invoke } = await import('@tauri-apps/api/core')
    const store = useServersStore()

    store.servers['s-1'] = makeServer()
    vi.mocked(invoke).mockResolvedValue(undefined)

    await store.upsertMember(makeMemberPayload({ avatarDataUrl: 'data:image/png;base64,old' }))
    await store.upsertMember(makeMemberPayload({ avatarDataUrl: 'data:image/png;base64,new' }))

    expect(store.members['s-1']?.['user-bob']?.avatarDataUrl).toBe('data:image/png;base64,new')
  })
})
