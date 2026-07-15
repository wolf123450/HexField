import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))

vi.mock('@/stores/identityStore', () => ({
  useIdentityStore: () => ({ userId: 'user-alice' }),
}))

vi.mock('@/stores/networkStore', () => ({
  useNetworkStore: () => ({ broadcast: vi.fn() }),
}))

// ── Helpers ────────────────────────────────────────────────────────────────────

async function makeInvokeMock(options: { tallyOutcome?: { passed: boolean; fail_reason: string | null } } = {}) {
  const { invoke } = await import('@tauri-apps/api/core')
  vi.mocked(invoke).mockImplementation((cmd: string) => {
    if (cmd === 'db_save_governance_motion') return Promise.resolve(undefined)
    if (cmd === 'db_save_governance_ballot')  return Promise.resolve(undefined)
    if (cmd === 'db_tally_governance_motion') return Promise.resolve(options.tallyOutcome ?? { passed: true, fail_reason: null })
    if (cmd === 'db_load_governance_motions') return Promise.resolve([])
    return Promise.resolve(undefined)
  })
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('governanceStore lifecycle', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  it('createDraft creates motion in draft state', async () => {
    const { useGovernanceStore } = await import('@/stores/governanceStore')
    await makeInvokeMock()
    const store = useGovernanceStore()

    const motionId = await store.createDraft({
      serverId:   's1',
      motionType: 'election',
      isBinding:  false,
    })

    const motion = store.getMotionById(motionId)
    expect(motion).toBeDefined()
    expect(motion?.state).toBe('draft')
    expect(motion?.server_id).toBe('s1')
    expect(motion?.is_binding).toBe(false)
  })

  it('openDiscussion transitions draft → discussion', async () => {
    const { useGovernanceStore } = await import('@/stores/governanceStore')
    await makeInvokeMock()
    const store = useGovernanceStore()

    const motionId = await store.createDraft({ serverId: 's1', motionType: 'non_binding_poll', isBinding: false })
    await store.openDiscussion(motionId)

    expect(store.getMotionById(motionId)?.state).toBe('discussion')
    expect(store.getMotionById(motionId)?.discussion_open_at).toBeTruthy()
  })

  it('non-binding motion can open voting without seconding or discussion window', async () => {
    const { useGovernanceStore } = await import('@/stores/governanceStore')
    const { useServersStore }    = await import('@/stores/serversStore')
    await makeInvokeMock()
    const store    = useGovernanceStore()
    const srvStore = useServersStore()
    srvStore.servers['s1'] = { id: 's1', name: 'Test', ownerId: 'alice', memberCount: 1, createdAt: '', customEmoji: [] }

    const motionId = await store.createDraft({ serverId: 's1', motionType: 'non_binding_poll', isBinding: false })
    await store.openDiscussion(motionId)
    await store.openVoting(motionId)

    expect(store.getMotionById(motionId)?.state).toBe('voting')
  })

  it('binding motion cannot open voting until seconded', async () => {
    const { useGovernanceStore } = await import('@/stores/governanceStore')
    const { useServersStore }    = await import('@/stores/serversStore')
    await makeInvokeMock()
    const store    = useGovernanceStore()
    const srvStore = useServersStore()
    srvStore.servers['s1'] = { id: 's1', name: 'Test', ownerId: 'alice', memberCount: 1, createdAt: '', customEmoji: [] }

    const motionId = await store.createDraft({ serverId: 's1', motionType: 'election', isBinding: true, seatCount: 1 })
    await store.openDiscussion(motionId)

    await expect(store.openVoting(motionId)).rejects.toThrow(/seconded/i)
    expect(store.getMotionById(motionId)?.state).toBe('discussion')
  })

  it('binding motion cannot open voting until min discussion window elapsed', async () => {
    const { useGovernanceStore } = await import('@/stores/governanceStore')
    const { useServersStore }    = await import('@/stores/serversStore')
    await makeInvokeMock()
    const store    = useGovernanceStore()
    const srvStore = useServersStore()
    srvStore.servers['s1'] = { id: 's1', name: 'Test', ownerId: 'alice', memberCount: 1, createdAt: '', customEmoji: [] }

    const motionId = await store.createDraft({ serverId: 's1', motionType: 'election', isBinding: true })
    await store.openDiscussion(motionId)
    await store.secondMotion(motionId)
    // Discussion just opened — 24h window not elapsed

    await expect(store.openVoting(motionId)).rejects.toThrow(/discussion window/i)
  })

  it('eligibility snapshot is frozen at vote open time', async () => {
    const { useGovernanceStore } = await import('@/stores/governanceStore')
    const { useServersStore }    = await import('@/stores/serversStore')
    await makeInvokeMock()
    const store    = useGovernanceStore()
    const srvStore = useServersStore()

    // Seed server with 2 members
    srvStore.servers['s1'] = { id: 's1', name: 'Test', ownerId: 'alice', memberCount: 2, createdAt: '', customEmoji: [] }
    srvStore.members['s1'] = {
      'user-alice': { userId: 'user-alice', serverId: 's1', displayName: 'Alice', roles: ['admin'], joinedAt: '', publicSignKey: '', publicDHKey: '', onlineStatus: 'online' },
      'user-bob':   { userId: 'user-bob',   serverId: 's1', displayName: 'Bob',   roles: ['member'], joinedAt: '', publicSignKey: '', publicDHKey: '', onlineStatus: 'online' },
    }

    const motionId = await store.createDraft({ serverId: 's1', motionType: 'election', isBinding: true })
    await store.openDiscussion(motionId)
    await store.secondMotion(motionId)
    store.fastForwardDiscussionForTest(motionId, 25)  // simulate 25h of discussion
    await store.openVoting(motionId)

    // Snapshot should contain alice and bob
    const snapshotBefore = JSON.parse(store.getMotionById(motionId)!.eligibility_snapshot_json!) as string[]
    expect(snapshotBefore).toContain('user-alice')
    expect(snapshotBefore).toContain('user-bob')

    // Add carol to the server AFTER voting opens
    srvStore.members['s1']['user-carol'] = {
      userId: 'user-carol', serverId: 's1', displayName: 'Carol', roles: ['member'],
      joinedAt: '', publicSignKey: '', publicDHKey: '', onlineStatus: 'online',
    }

    // Motion snapshot must NOT include carol — it was frozen at vote open
    const snapshotAfter = JSON.parse(store.getMotionById(motionId)!.eligibility_snapshot_json!) as string[]
    expect(snapshotAfter).not.toContain('user-carol')
    expect(snapshotAfter).toEqual(snapshotBefore)
  })

  it('closeMotion uses DB tally and transitions to closed_passed', async () => {
    const { useGovernanceStore } = await import('@/stores/governanceStore')
    const { useServersStore }    = await import('@/stores/serversStore')
    await makeInvokeMock({ tallyOutcome: { passed: true, fail_reason: null } })
    const store    = useGovernanceStore()
    const srvStore = useServersStore()
    srvStore.servers['s1'] = { id: 's1', name: 'Test', ownerId: 'alice', memberCount: 1, createdAt: '', customEmoji: [] }
    srvStore.members['s1'] = {}

    const motionId = await store.createDraft({ serverId: 's1', motionType: 'non_binding_poll', isBinding: false })
    await store.openDiscussion(motionId)
    await store.openVoting(motionId)
    const outcome = await store.closeMotion(motionId)

    expect(outcome.passed).toBe(true)
    expect(store.getMotionById(motionId)?.state).toBe('closed_passed')
  })

  it('closeMotion transitions to closed_failed when tally fails', async () => {
    const { useGovernanceStore } = await import('@/stores/governanceStore')
    const { useServersStore }    = await import('@/stores/serversStore')
    await makeInvokeMock({ tallyOutcome: { passed: false, fail_reason: 'quorum' } })
    const store    = useGovernanceStore()
    const srvStore = useServersStore()
    srvStore.servers['s1'] = { id: 's1', name: 'Test', ownerId: 'alice', memberCount: 1, createdAt: '', customEmoji: [] }
    srvStore.members['s1'] = {}

    const motionId = await store.createDraft({ serverId: 's1', motionType: 'non_binding_poll', isBinding: false })
    await store.openDiscussion(motionId)
    await store.openVoting(motionId)
    const outcome = await store.closeMotion(motionId)

    expect(outcome.passed).toBe(false)
    expect(outcome.fail_reason).toBe('quorum')
    expect(store.getMotionById(motionId)?.state).toBe('closed_failed')
  })

  it('elects top N approvals for seatCount and generates runoff on boundary tie', async () => {
    const { useGovernanceStore } = await import('@/stores/governanceStore')
    const { useServersStore }    = await import('@/stores/serversStore')
    await makeInvokeMock({ tallyOutcome: { passed: true, fail_reason: null } })
    const store    = useGovernanceStore()
    const srvStore = useServersStore()
    srvStore.servers['s1'] = { id: 's1', name: 'Test', ownerId: 'alice', memberCount: 1, createdAt: '', customEmoji: [] }
    srvStore.members['s1'] = {}

    const motionId = await store.createDraft({ serverId: 's1', motionType: 'election', isBinding: false, seatCount: 3 })
    await store.openDiscussion(motionId)
    await store.openVoting(motionId)

    store.seedFinalTallyForTest(motionId, [
      { candidateId: 'a', approvals: 15 },
      { candidateId: 'b', approvals: 14 },
      { candidateId: 'c', approvals: 13 },
      { candidateId: 'd', approvals: 13 },
    ])

    await store.closeMotion(motionId)

    const runoffs = store.listRunoffsForParent(motionId)
    expect(runoffs).toHaveLength(1)
    expect(runoffs[0].motion_type).toBe('runoff')
    expect(runoffs[0].seat_count).toBe(1)
    const ruleset = JSON.parse(runoffs[0].ruleset_json!) as { parent_motion_id: string; tied_candidates: string[] }
    expect(ruleset.parent_motion_id).toBe(motionId)
    expect(ruleset.tied_candidates).toEqual(expect.arrayContaining(['c', 'd']))
  })
})
