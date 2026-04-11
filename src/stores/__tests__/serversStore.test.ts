import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { Server, ServerMember } from '@/types/core'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))

// identityStore is dynamically imported inside createServer — stub it out
vi.mock('@/stores/identityStore', () => ({
  useIdentityStore: () => ({
    userId:       'user-alice',
    displayName:  'Alice',
    publicSignKey: 'sign-alice',
    publicDHKey:   'dh-alice',
    avatarDataUrl: null,
  }),
}))

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

function makeMemberPayload(overrides: Partial<ServerMember & { avatarHash?: string }> = {}) {
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

  it('applies incoming avatarHash to the reactive entry', async () => {
    const { useServersStore } = await import('@/stores/serversStore')
    const { invoke } = await import('@tauri-apps/api/core')
    const store = useServersStore()

    store.servers['s-1'] = makeServer()
    vi.mocked(invoke).mockResolvedValue(undefined)

    await store.upsertMember(makeMemberPayload({ avatarHash: 'abc123' }))

    expect(store.members['s-1']?.['user-bob']?.avatarHash).toBe('abc123')
  })

  it('preserves existing avatarHash when caller omits it', async () => {
    const { useServersStore } = await import('@/stores/serversStore')
    const { invoke } = await import('@tauri-apps/api/core')
    const store = useServersStore()

    store.servers['s-1'] = makeServer()
    vi.mocked(invoke).mockResolvedValue(undefined)

    // First upsert sets the avatar hash
    await store.upsertMember(makeMemberPayload({ avatarHash: 'hash-original' }))
    expect(store.members['s-1']?.['user-bob']?.avatarHash).toBe('hash-original')

    // Second upsert (e.g. name change) does not supply avatarHash
    await store.upsertMember(makeMemberPayload({ displayName: 'Bobby' }))

    // Hash must be preserved
    expect(store.members['s-1']?.['user-bob']?.avatarHash).toBe('hash-original')
    expect(store.members['s-1']?.['user-bob']?.displayName).toBe('Bobby')
  })

  it('a newer upsert can overwrite avatarHash with a new value', async () => {
    const { useServersStore } = await import('@/stores/serversStore')
    const { invoke } = await import('@tauri-apps/api/core')
    const store = useServersStore()

    store.servers['s-1'] = makeServer()
    vi.mocked(invoke).mockResolvedValue(undefined)

    await store.upsertMember(makeMemberPayload({ avatarHash: 'hash-old' }))
    await store.upsertMember(makeMemberPayload({ avatarHash: 'hash-new' }))

    expect(store.members['s-1']?.['user-bob']?.avatarHash).toBe('hash-new')
  })
})

// ── createServer ───────────────────────────────────────────────────────────────

describe('serversStore.createServer', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  it('writes to DB and populates reactive servers map', async () => {
    const { useServersStore } = await import('@/stores/serversStore')
    const { invoke } = await import('@tauri-apps/api/core')
    const store = useServersStore()
    vi.mocked(invoke).mockResolvedValue(undefined)

    const server = await store.createServer('My Test Server')

    // DB commands were called
    expect(invoke).toHaveBeenCalledWith('db_save_server', expect.objectContaining({
      server: expect.objectContaining({ name: 'My Test Server' }),
    }))
    expect(invoke).toHaveBeenCalledWith('db_upsert_member', expect.anything())

    // Reactive state updated
    expect(store.servers[server.id]).toBeDefined()
    expect(store.servers[server.id].name).toBe('My Test Server')
    expect(store.joinedServerIds).toContain(server.id)
  })

  it('sets ownerId from identityStore.userId', async () => {
    const { useServersStore } = await import('@/stores/serversStore')
    const { invoke } = await import('@tauri-apps/api/core')
    const store = useServersStore()
    vi.mocked(invoke).mockResolvedValue(undefined)

    const server = await store.createServer('Alice\'s Server')

    expect(server.ownerId).toBe('user-alice')
  })

  it('adds creator as admin member in reactive members map', async () => {
    const { useServersStore } = await import('@/stores/serversStore')
    const { invoke } = await import('@tauri-apps/api/core')
    const store = useServersStore()
    vi.mocked(invoke).mockResolvedValue(undefined)

    const server = await store.createServer('Guild')

    const self = store.members[server.id]?.['user-alice']
    expect(self).toBeDefined()
    expect(self?.roles).toContain('admin')
  })

  it('returns a Server object with a non-empty id and inviteCode', async () => {
    const { useServersStore } = await import('@/stores/serversStore')
    const { invoke } = await import('@tauri-apps/api/core')
    const store = useServersStore()
    vi.mocked(invoke).mockResolvedValue(undefined)

    const server = await store.createServer('Arena')

    expect(typeof server.id).toBe('string')
    expect(server.id.length).toBeGreaterThan(0)
    expect(typeof server.inviteCode).toBe('string')
    expect((server.inviteCode ?? '').length).toBeGreaterThan(0)
  })
})
