import { defineStore } from 'pinia'
import { ref } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import { v7 as uuidv7 } from 'uuid'
import type {
  GovernanceMotion,
  GovernanceBallot,
  GovernanceCandidate,
  GovernancePost,
  GovernanceOutcome,
  GovernanceMotionType,
} from '@/types/core'

export interface CreateMotionInput {
  serverId:       string
  motionType:     GovernanceMotionType
  isBinding:      boolean
  seatCount?:     number
  proposerUserId?: string   // defaults to identityStore.userId
  voteCloseAt?:   string   // ISO-8601, optional scheduling
  rulesetJson?:   string
}

export interface RankedCandidate {
  candidateId: string
  approvals:   number
}

export const useGovernanceStore = defineStore('governance', () => {
  // keyed by serverId
  const motionsByServer    = ref<Record<string, GovernanceMotion[]>>({})
  // keyed by motionId
  const candidatesByMotion = ref<Record<string, GovernanceCandidate[]>>({})
  const ballotsByMotion    = ref<Record<string, GovernanceBallot[]>>({})
  const postsByMotion      = ref<Record<string, GovernancePost[]>>({})
  // test-only: seeded election rankings for runoff detection
  const _rankingsForTest   = ref<Record<string, RankedCandidate[]>>({})

  // ── Internal helpers ────────────────────────────────────────────────────────

  function getMotionById(motionId: string): GovernanceMotion | undefined {
    for (const list of Object.values(motionsByServer.value)) {
      const m = list.find(m => m.id === motionId)
      if (m) return m
    }
    return undefined
  }

  function upsertMotion(motion: GovernanceMotion) {
    const list = motionsByServer.value[motion.server_id] ?? []
    const idx  = list.findIndex(m => m.id === motion.id)
    if (idx >= 0) list[idx] = motion
    else          list.push(motion)
    motionsByServer.value[motion.server_id] = list
  }

  // ── Load ────────────────────────────────────────────────────────────────────

  async function loadMotions(serverId: string, stateFilter?: string) {
    const rows = await invoke<GovernanceMotion[]>('db_load_governance_motions', {
      serverId,
      stateFilter: stateFilter ?? null,
    })
    motionsByServer.value[serverId] = rows
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────────

  async function createDraft(input: CreateMotionInput): Promise<string> {
    const { useIdentityStore } = await import('./identityStore')
    const proposerUserId = input.proposerUserId ?? useIdentityStore().userId ?? ''
    const now = new Date().toISOString()
    const motion: GovernanceMotion = {
      id:                        uuidv7(),
      server_id:                 input.serverId,
      motion_type:               input.motionType,
      state:                     'draft',
      is_binding:                input.isBinding,
      seat_count:                input.seatCount ?? 1,
      proposer_user_id:          proposerUserId,
      eligibility_snapshot_json: null,
      discussion_open_at:        null,
      vote_open_at:              null,
      vote_close_at:             input.voteCloseAt ?? null,
      ruleset_json:              input.rulesetJson ?? '{}',
      created_at:                now,
      updated_at:                now,
    }
    await invoke('db_save_governance_motion', { motion })
    upsertMotion(motion)
    return motion.id
  }

  async function openDiscussion(motionId: string): Promise<void> {
    const motion = getMotionById(motionId)
    if (!motion) throw new Error(`Motion ${motionId} not found`)
    if (motion.state !== 'draft') throw new Error('Motion must be in draft state to open discussion')
    const now     = new Date().toISOString()
    const updated = { ...motion, state: 'discussion' as const, discussion_open_at: now, updated_at: now }
    await invoke('db_save_governance_motion', { motion: updated })
    upsertMotion(updated)
  }

  async function secondMotion(motionId: string): Promise<void> {
    const motion = getMotionById(motionId)
    if (!motion) throw new Error(`Motion ${motionId} not found`)
    const ruleset = JSON.parse(motion.ruleset_json ?? '{}') as Record<string, unknown>
    ruleset.seconded = true
    const updated = { ...motion, ruleset_json: JSON.stringify(ruleset), updated_at: new Date().toISOString() }
    await invoke('db_save_governance_motion', { motion: updated })
    upsertMotion(updated)
  }

  async function openVoting(motionId: string): Promise<void> {
    const motion = getMotionById(motionId)
    if (!motion) throw new Error(`Motion ${motionId} not found`)
    if (motion.state !== 'discussion') throw new Error('Motion must be in discussion state to open voting')

    if (motion.is_binding) {
      const ruleset = JSON.parse(motion.ruleset_json ?? '{}') as Record<string, unknown>
      if (!ruleset.seconded) {
        throw new Error('Motion must be seconded before voting can open')
      }
      if (motion.discussion_open_at) {
        const minHours    = (typeof ruleset.minDiscussionHours === 'number' ? ruleset.minDiscussionHours : 24)
        const openedAt    = new Date(motion.discussion_open_at).getTime()
        if (Date.now() - openedAt < minHours * 3_600_000) {
          throw new Error(`Minimum discussion window of ${minHours}h has not elapsed`)
        }
      }
    }

    // Freeze eligibility snapshot at this point
    const { useServersStore } = await import('./serversStore')
    const serversStore = useServersStore()
    const memberMap    = serversStore.members[motion.server_id] ?? {}
    const snapshot     = Object.keys(memberMap)
    const now          = new Date().toISOString()
    const updated: GovernanceMotion = {
      ...motion,
      state:                     'voting',
      vote_open_at:              now,
      eligibility_snapshot_json: JSON.stringify(snapshot),
      updated_at:                now,
    }
    await invoke('db_save_governance_motion', { motion: updated })
    upsertMotion(updated)
  }

  async function castBallot(
    motionId: string,
    ballot: Omit<GovernanceBallot, 'motion_id' | 'revision' | 'updated_at'>,
  ): Promise<void> {
    const motion = getMotionById(motionId)
    if (!motion) throw new Error(`Motion ${motionId} not found`)
    if (motion.state !== 'voting') throw new Error('Motion is not in voting state')

    const existing = (ballotsByMotion.value[motionId] ?? []).find(b => b.voter_user_id === ballot.voter_user_id)
    const revision = (existing?.revision ?? 0) + 1
    const full: GovernanceBallot = { ...ballot, motion_id: motionId, revision, updated_at: new Date().toISOString() }
    await invoke('db_save_governance_ballot', { ballot: full })
    const rest = (ballotsByMotion.value[motionId] ?? []).filter(b => b.voter_user_id !== ballot.voter_user_id)
    ballotsByMotion.value[motionId] = [...rest, full]
  }

  async function closeMotion(motionId: string): Promise<GovernanceOutcome> {
    const motion = getMotionById(motionId)
    if (!motion) throw new Error(`Motion ${motionId} not found`)

    const eligibleCount = motion.eligibility_snapshot_json
      ? (JSON.parse(motion.eligibility_snapshot_json) as string[]).length
      : 0

    const outcome = await invoke<GovernanceOutcome>('db_tally_governance_motion', { motionId, eligibleCount })
    const newState = outcome.passed ? 'closed_passed' : 'closed_failed'
    const updated: GovernanceMotion = { ...motion, state: newState as GovernanceMotion['state'], updated_at: new Date().toISOString() }
    await invoke('db_save_governance_motion', { motion: updated })
    upsertMotion(updated)

    // Detect boundary tie for election motions and generate runoff if needed
    if (motion.motion_type === 'election' && motion.seat_count > 0) {
      const rankings = _rankingsForTest.value[motionId]
        ?? _computeRankingsFromBallots(motionId)
      if (rankings.length > motion.seat_count) {
        const boundaryApprovals = rankings[motion.seat_count - 1].approvals
        if (rankings[motion.seat_count].approvals === boundaryApprovals) {
          // Tie at the boundary: count clear winners (approvals strictly above boundary)
          const clearWinners = rankings.filter(r => r.approvals > boundaryApprovals).length
          const tiedCandidates = rankings.filter(r => r.approvals === boundaryApprovals).map(r => r.candidateId)
          const remainingSeats = motion.seat_count - clearWinners
          await createDraft({
            serverId:       motion.server_id,
            motionType:     'runoff',
            isBinding:      motion.is_binding,
            seatCount:      remainingSeats,
            proposerUserId: motion.proposer_user_id,
            rulesetJson:    JSON.stringify({ parent_motion_id: motionId, tied_candidates: tiedCandidates }),
          })
        }
      }
    }

    return outcome
  }

  async function cancelMotion(motionId: string): Promise<void> {
    const motion = getMotionById(motionId)
    if (!motion) throw new Error(`Motion ${motionId} not found`)
    const updated: GovernanceMotion = { ...motion, state: 'cancelled', updated_at: new Date().toISOString() }
    await invoke('db_save_governance_motion', { motion: updated })
    upsertMotion(updated)
  }

  // ── Incoming network mutations ────────────────────────────────────────────────
  // ── Election ranking helpers ─────────────────────────────────────────────────

  function _computeRankingsFromBallots(motionId: string): RankedCandidate[] {
    const ballots = ballotsByMotion.value[motionId] ?? []
    const counts: Record<string, number> = {}
    for (const ballot of ballots) {
      if (ballot.reject_vote || ballot.abstain_vote) continue
      const approved = JSON.parse(ballot.approved_candidate_ids_json) as string[]
      for (const cid of approved) {
        counts[cid] = (counts[cid] ?? 0) + 1
      }
    }
    return Object.entries(counts)
      .map(([candidateId, approvals]) => ({ candidateId, approvals }))
      .sort((a, b) => b.approvals - a.approvals)
  }

  function listRunoffsForParent(parentMotionId: string): GovernanceMotion[] {
    const result: GovernanceMotion[] = []
    for (const list of Object.values(motionsByServer.value)) {
      for (const m of list) {
        if (m.motion_type === 'runoff' && m.ruleset_json) {
          const ruleset = JSON.parse(m.ruleset_json) as Record<string, unknown>
          if (ruleset.parent_motion_id === parentMotionId) result.push(m)
        }
      }
    }
    return result
  }

  // ── Incoming network mutations ────────────────────────────────────────────────

  async function applyGovernanceMutation(serverId: string, motionId: string, motionType: string, payload: unknown): Promise<void> {
    if (motionType === 'governance_motion_update' && payload) {
      const row = payload as GovernanceMotion
      upsertMotion({ ...row, server_id: serverId })
    }
    // Reload from DB to stay in sync
    await loadMotions(serverId)
  }

  // ── Test helpers ────────────────────────────────────────────────────────────

  function fastForwardDiscussionForTest(motionId: string, hours: number): void {
    const motion = getMotionById(motionId)
    if (!motion?.discussion_open_at) return
    const backDate = new Date(new Date(motion.discussion_open_at).getTime() - hours * 3_600_000).toISOString()
    upsertMotion({ ...motion, discussion_open_at: backDate })
  }

  function seedFinalTallyForTest(motionId: string, rankings: RankedCandidate[]): void {
    _rankingsForTest.value[motionId] = rankings
  }

  function hasMotion(motionId: string): boolean {
    return !!getMotionById(motionId)
  }

  return {
    motionsByServer,
    candidatesByMotion,
    ballotsByMotion,
    postsByMotion,
    getMotionById,
    loadMotions,
    createDraft,
    openDiscussion,
    secondMotion,
    openVoting,
    castBallot,
    closeMotion,
    cancelMotion,
    applyGovernanceMutation,
    // Test helpers
    fastForwardDiscussionForTest,
    hasMotion,
    seedFinalTallyForTest,
    listRunoffsForParent,
  }
})
