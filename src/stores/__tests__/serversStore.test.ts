import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { Server, ServerMember } from '@/types/core'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))

// Mutations are signed at creation (spec 08 §5) — stub the signer.
vi.mock('@/services/cryptoService', () => ({
  cryptoService: {
    signJson: vi.fn((p: Record<string, unknown>) => ({ ...p, __sig: 'test-sig', __pub: 'test-pub' })),
  },
}))

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

// channelsStore is dynamically imported inside leaveServer
vi.mock('@/stores/channelsStore', () => ({
  useChannelsStore: () => ({ channels: {} }),
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

// ── governance feature flag ────────────────────────────────────────────────────

describe('Server.governanceMotionPipelineEnabled', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  it('defaults to undefined (falsy) when not set on a new server', async () => {
    const { useServersStore } = await import('@/stores/serversStore')
    const { invoke } = await import('@tauri-apps/api/core')
    const store = useServersStore()
    vi.mocked(invoke).mockResolvedValue(undefined)

    const server = await store.createServer('Test')

    expect(store.servers[server.id].governanceMotionPipelineEnabled).toBeFalsy()
  })

  it('preserves governanceMotionPipelineEnabled=true when loaded from raw_json', async () => {
    const { useServersStore } = await import('@/stores/serversStore')
    const { invoke } = await import('@tauri-apps/api/core')
    const store = useServersStore()

    const srv: Server = { ...makeServer('s-gov'), governanceMotionPipelineEnabled: true }
    vi.mocked(invoke).mockResolvedValue([{ raw_json: JSON.stringify(srv) }])

    await store.loadServers()

    expect(store.servers['s-gov']?.governanceMotionPipelineEnabled).toBe(true)
  })
})

// ── leaveServer (non-governance fallback) ──────────────────────────────────────

describe('serversStore.leaveServer', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  it('removes server from reactive state and joinedServerIds', async () => {
    const { useServersStore } = await import('@/stores/serversStore')
    const { invoke } = await import('@tauri-apps/api/core')
    const store = useServersStore()

    store.servers['s-1'] = makeServer('s-1')
    store.joinedServerIds.push('s-1')
    vi.mocked(invoke).mockResolvedValue(undefined)

    await store.leaveServer('s-1')

    expect(store.servers['s-1']).toBeUndefined()
    expect(store.joinedServerIds).not.toContain('s-1')
  })

  it('clears activeServerId when leaving the active server', async () => {
    const { useServersStore } = await import('@/stores/serversStore')
    const { invoke } = await import('@tauri-apps/api/core')
    const store = useServersStore()

    store.servers['s-1'] = makeServer('s-1')
    store.joinedServerIds.push('s-1')
    store.activeServerId = 's-1'
    vi.mocked(invoke).mockResolvedValue(undefined)

    await store.leaveServer('s-1')

    expect(store.activeServerId).toBeNull()
  })

  it('calls db_delete_server with the correct serverId', async () => {
    const { useServersStore } = await import('@/stores/serversStore')
    const { invoke } = await import('@tauri-apps/api/core')
    const store = useServersStore()

    store.servers['s-1'] = makeServer('s-1')
    store.joinedServerIds.push('s-1')
    vi.mocked(invoke).mockResolvedValue(undefined)

    await store.leaveServer('s-1')

    expect(invoke).toHaveBeenCalledWith('db_delete_server', { serverId: 's-1' })
  })

  it('is a no-op for an unknown serverId', async () => {
    const { useServersStore } = await import('@/stores/serversStore')
    const { invoke } = await import('@tauri-apps/api/core')
    const store = useServersStore()
    vi.mocked(invoke).mockResolvedValue(undefined)

    await store.leaveServer('ghost-server')

    expect(invoke).not.toHaveBeenCalled()
  })
})
