<template>
  <div class="motion-detail">
    <!-- Header -->
    <div class="detail-header">
      <button class="back-btn" @click="emit('close')">← Back</button>
      <div class="detail-title">
        <span class="type-badge">{{ motionTypeLabel }}</span>
        <span :class="['state-badge', `state-${motion.state}`]">{{ stateLabel }}</span>
      </div>
    </div>

    <!-- Meta -->
    <div class="detail-meta">
      <div class="meta-row"><span class="meta-label">ID</span><span class="meta-value mono">{{ motion.id }}</span></div>
      <div class="meta-row"><span class="meta-label">Proposer</span><span class="meta-value">{{ memberName(motion.proposer_user_id) }}</span></div>
      <div class="meta-row"><span class="meta-label">Binding</span><span class="meta-value">{{ motion.is_binding ? 'Yes' : 'No' }}</span></div>
      <div v-if="isElection" class="meta-row">
        <span class="meta-label">Seats</span><span class="meta-value">{{ motion.seat_count }}</span>
      </div>
      <div class="meta-row"><span class="meta-label">Created</span><span class="meta-value">{{ formatDate(motion.created_at) }}</span></div>
      <div v-if="motion.discussion_open_at" class="meta-row">
        <span class="meta-label">Discussion opened</span><span class="meta-value">{{ formatDate(motion.discussion_open_at) }}</span>
      </div>
      <div v-if="motion.vote_open_at" class="meta-row">
        <span class="meta-label">Voting opened</span><span class="meta-value">{{ formatDate(motion.vote_open_at) }}</span>
      </div>
      <div v-if="motion.vote_close_at" class="meta-row">
        <span class="meta-label">Vote closes</span><span class="meta-value">{{ formatDate(motion.vote_close_at) }}</span>
      </div>
      <div v-if="isSeconded" class="meta-row">
        <span class="meta-label">Seconded</span><span class="meta-value">Yes ✓</span>
      </div>
      <!-- Eligibility snapshot -->
      <div v-if="eligibilityList.length" class="meta-row meta-row-eligibility">
        <span class="meta-label">Eligible voters</span>
        <span class="meta-value">{{ eligibilityList.map(memberName).join(', ') }}</span>
      </div>
    </div>

    <!-- ── Candidates section (elections, draft/discussion/voting) ─────────── -->
    <div v-if="isElection" class="section">
      <h4 class="section-title">Candidates</h4>
      <div v-if="activeCandidates.length === 0" class="empty-hint">No candidates yet.</div>
      <div v-else class="candidate-roster">
        <div
          v-for="c in activeCandidates"
          :key="c.candidate_user_id"
          class="candidate-entry"
        >
          <span class="candidate-name">{{ memberName(c.candidate_user_id) }}</span>
          <span class="candidate-source">({{ c.source.replace('_', ' ') }})</span>
          <span v-if="c.status === 'withdrawn'" class="candidate-withdrawn">withdrawn</span>
          <button
            v-else-if="motion.state !== 'voting' && c.candidate_user_id === identityStore.userId"
            class="btn-tiny btn-danger"
            :disabled="busy"
            @click="doWithdraw(c.candidate_user_id)"
          >Withdraw</button>
        </div>
      </div>
      <!-- Nomination controls (draft/discussion only) -->
      <div v-if="motion.state === 'draft' || motion.state === 'discussion'" class="nominate-controls">
        <button
          v-if="!isSelfNominated"
          class="btn-sm btn-secondary"
          :disabled="busy"
          @click="doSelfNominate"
        >+ Nominate Yourself</button>
        <div class="nominate-other">
          <select v-model="nomineeId" class="form-select-sm">
            <option value="">Nominate a member…</option>
            <option
              v-for="(member, uid) in eligibleMembers"
              :key="uid"
              :value="uid"
              :disabled="alreadyNominated(uid)"
            >{{ member.displayName }}</option>
          </select>
          <button
            class="btn-sm btn-secondary"
            :disabled="busy || !nomineeId"
            @click="doNominate"
          >Nominate</button>
        </div>
      </div>
    </div>

    <!-- ── Discussion posts (discussion state) ──────────────────────────────── -->
    <div v-if="motion.state === 'discussion' || (posts.length > 0 && motion.state !== 'draft')" class="section">
      <h4 class="section-title">Discussion</h4>
      <div v-if="posts.length === 0" class="empty-hint">No posts yet. Start the discussion.</div>
      <div v-else class="post-list">
        <div v-for="post in posts" :key="post.id" class="post-entry">
          <span class="post-author">{{ memberName(post.author_user_id) }}</span>
          <span class="post-time">{{ formatDate(post.created_at) }}</span>
          <p class="post-content">{{ post.content }}</p>
        </div>
      </div>
      <div v-if="motion.state === 'discussion'" class="post-composer">
        <textarea
          v-model="newPostContent"
          class="post-textarea"
          placeholder="Write a comment…"
          rows="2"
        />
        <button
          class="btn-sm btn-primary"
          :disabled="busy || !newPostContent.trim()"
          @click="doAddPost"
        >Post</button>
      </div>
    </div>

    <!-- ── Ballot section (voting state) ──────────────────────────────────── -->
    <div v-if="motion.state === 'voting'" class="section ballot-section">
      <h4 class="section-title">Cast Your Ballot</h4>

      <!-- Current vote indicator (re-voting allowed) -->
      <div v-if="myBallot" class="current-vote">
        <span class="current-vote-label">Your current vote:</span>
        <span class="current-vote-value">{{ currentVoteLabel }}</span>
        <span class="change-vote-hint">(you may change until voting closes)</span>
      </div>

      <!-- Simple: approve/reject/abstain -->
      <div v-if="!isElection" class="ballot-options">
        <button
          class="btn-vote btn-approve"
          :class="{ active: myBallot && !myBallot.reject_vote && !myBallot.abstain_vote }"
          :disabled="busy"
          @click="castSimpleBallot('approve')"
        >Approve</button>
        <button
          class="btn-vote btn-reject"
          :class="{ active: myBallot?.reject_vote }"
          :disabled="busy"
          @click="castSimpleBallot('reject')"
        >Reject</button>
        <button
          class="btn-vote btn-abstain"
          :class="{ active: myBallot?.abstain_vote }"
          :disabled="busy"
          @click="castSimpleBallot('abstain')"
        >Abstain</button>
      </div>

      <!-- Election: approval voting -->
      <div v-else>
        <p class="ballot-hint">Select the candidates you approve of:</p>
        <div class="candidate-list">
          <label
            v-for="c in activeCandidates.filter(c => c.status !== 'withdrawn')"
            :key="c.candidate_user_id"
            class="candidate-row"
          >
            <input v-model="approvedCandidates" type="checkbox" :value="c.candidate_user_id" />
            {{ memberName(c.candidate_user_id) }}
          </label>
        </div>
        <button
          class="btn-vote btn-approve"
          :disabled="busy"
          @click="castElectionBallot"
        >{{ myBallot ? 'Update Ballot' : 'Submit Ballot' }}</button>
      </div>

      <!-- Live tally (non-binding only) -->
      <div v-if="!motion.is_binding && liveTally" class="tally-preview">
        <h5 class="tally-title">Current tally ({{ liveTally.total }} votes cast)</h5>
        <div class="tally-bar-row">
          <span>Approve</span><span>{{ liveTally.approve }}</span>
        </div>
        <div class="tally-bar-row">
          <span>Reject</span><span>{{ liveTally.reject }}</span>
        </div>
        <div class="tally-bar-row">
          <span>Abstain</span><span>{{ liveTally.abstain }}</span>
        </div>
      </div>
    </div>

    <!-- ── Result section (closed) ────────────────────────────────────────── -->
    <div v-if="motion.state === 'closed_passed' || motion.state === 'closed_failed'" class="section result-section">
      <div :class="['result-badge', motion.state === 'closed_passed' ? 'passed' : 'failed']">
        {{ motion.state === 'closed_passed' ? '✓ Motion Passed' : '✗ Motion Failed' }}
      </div>
      <div v-if="closedTally" class="closed-tally">
        <div class="tally-bar-row"><span>Approve</span><span>{{ closedTally.approve }}</span></div>
        <div class="tally-bar-row"><span>Reject</span><span>{{ closedTally.reject }}</span></div>
        <div class="tally-bar-row"><span>Abstain</span><span>{{ closedTally.abstain }}</span></div>
        <div class="tally-bar-row"><span>Total voted</span><span>{{ closedTally.total }}</span></div>
        <div class="tally-bar-row"><span>Eligible voters</span><span>{{ closedTally.eligible }}</span></div>
        <div class="tally-bar-row tally-threshold" :class="{ met: closedTally.quorumReached }">
          <span>Quorum (≥40%)</span>
          <span>{{ closedTally.eligible ? pct(closedTally.total, closedTally.eligible) : 'n/a' }}</span>
        </div>
        <div v-if="motion.is_binding" class="tally-bar-row tally-threshold" :class="{ met: closedTally.majorityReached }">
          <span>Majority (&gt;50% non-abstaining)</span>
          <span>{{ closedTally.approve + closedTally.reject ? pct(closedTally.approve, closedTally.approve + closedTally.reject) : 'n/a' }}</span>
        </div>
        <div v-if="motion.is_binding" class="tally-bar-row tally-threshold" :class="{ vetoed: closedTally.rejectVeto }">
          <span>Reject veto (&lt;30%)</span>
          <span>{{ closedTally.total ? pct(closedTally.reject, closedTally.total) : 'n/a' }}</span>
        </div>
      </div>
    </div>

    <!-- ── Action bar ──────────────────────────────────────────────────────── -->
    <div v-if="availableActions.length" class="action-bar">
      <button
        v-for="action in availableActions"
        :key="action.id"
        :class="['action-btn', action.variant]"
        :disabled="busy"
        @click="runAction(action.id)"
      >{{ action.label }}</button>
    </div>

    <div v-if="errorMsg" class="error-msg">{{ errorMsg }}</div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue'
import { useGovernanceStore } from '@/stores/governanceStore'
import { useServersStore } from '@/stores/serversStore'
import { useIdentityStore } from '@/stores/identityStore'
import type { GovernanceMotion, GovernanceMotionType, ServerMember } from '@/types/core'

const props = defineProps<{
  motion:   GovernanceMotion
  serverId: string
}>()
const emit = defineEmits<{ (e: 'close'): void }>()

const governanceStore = useGovernanceStore()
const serversStore    = useServersStore()
const identityStore   = useIdentityStore()

const busy            = ref(false)
const errorMsg        = ref<string | null>(null)
const approvedCandidates = ref<string[]>([])
const newPostContent  = ref('')
const nomineeId       = ref('')

// ── Load sub-collections whenever motion changes ───────────────────────────

async function loadAll(motionId: string) {
  await Promise.all([
    governanceStore.loadCandidates(motionId).catch(() => {}),
    governanceStore.loadBallots(motionId).catch(() => {}),
    governanceStore.loadPosts(motionId).catch(() => {}),
  ])
  // Pre-fill election ballot from existing vote
  if (myBallot.value) {
    approvedCandidates.value = JSON.parse(myBallot.value.approved_candidate_ids_json) as string[]
  }
}

onMounted(() => loadAll(props.motion.id))
watch(() => props.motion.id, id => loadAll(id))

// ── Helpers ────────────────────────────────────────────────────────────────

function memberName(userId: string): string {
  const members = serversStore.members[props.serverId] ?? {}
  return (members[userId] as ServerMember | undefined)?.displayName ?? userId.slice(0, 8) + '…'
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString()
}

function pct(n: number, total: number): string {
  if (total === 0) return '0%'
  return Math.round((n / total) * 100) + '%'
}

// ── Derived ────────────────────────────────────────────────────────────────

const isElection = computed(() =>
  props.motion.motion_type === 'election' || props.motion.motion_type === 'runoff'
)

const motionTypeLabel = computed((): string => ({
  election:        'Election',
  runoff:          'Runoff',
  non_binding_poll:'Poll',
  rule_change:     'Rule Change',
  server_transfer: 'Server Transfer',
} as Record<GovernanceMotionType, string>)[props.motion.motion_type] ?? props.motion.motion_type)

const stateLabel = computed(() =>
  props.motion.state.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
)

const isSeconded = computed(() => {
  const ruleset = JSON.parse(props.motion.ruleset_json ?? '{}') as Record<string, unknown>
  return !!ruleset.seconded
})

const eligibilityList = computed((): string[] => {
  if (!props.motion.eligibility_snapshot_json) return []
  return JSON.parse(props.motion.eligibility_snapshot_json) as string[]
})

const eligibleMembers = computed((): Record<string, ServerMember> => {
  return (serversStore.members[props.serverId] ?? {}) as Record<string, ServerMember>
})

const activeCandidates = computed(() =>
  (governanceStore.candidatesByMotion[props.motion.id] ?? [])
    .filter(c => c.status !== 'withdrawn')
)

const posts = computed(() => governanceStore.postsByMotion[props.motion.id] ?? [])

const myBallot = computed(() => {
  const uid = identityStore.userId
  if (!uid) return null
  return (governanceStore.ballotsByMotion[props.motion.id] ?? []).find(b => b.voter_user_id === uid) ?? null
})

const currentVoteLabel = computed(() => {
  if (!myBallot.value) return ''
  if (myBallot.value.reject_vote) return 'Reject'
  if (myBallot.value.abstain_vote) return 'Abstain'
  return 'Approve'
})

const isSelfNominated = computed(() => {
  const uid = identityStore.userId
  return !!uid && (governanceStore.candidatesByMotion[props.motion.id] ?? [])
    .some(c => c.candidate_user_id === uid && c.status !== 'withdrawn')
})

function alreadyNominated(uid: string): boolean {
  return (governanceStore.candidatesByMotion[props.motion.id] ?? [])
    .some(c => c.candidate_user_id === uid && c.status !== 'withdrawn')
}

const liveTally = computed(() => {
  const ballots = governanceStore.ballotsByMotion[props.motion.id] ?? []
  if (!ballots.length) return null
  return {
    total:   ballots.length,
    approve: ballots.filter(b => !b.reject_vote && !b.abstain_vote).length,
    reject:  ballots.filter(b => b.reject_vote).length,
    abstain: ballots.filter(b => b.abstain_vote).length,
  }
})

const closedTally = computed(() => {
  if (props.motion.state !== 'closed_passed' && props.motion.state !== 'closed_failed') return null
  const ballots  = governanceStore.ballotsByMotion[props.motion.id] ?? []
  const eligible = eligibilityList.value.length
  const total    = ballots.length
  const approve  = ballots.filter(b => !b.reject_vote && !b.abstain_vote).length
  const reject   = ballots.filter(b => b.reject_vote).length
  const abstain  = ballots.filter(b => b.abstain_vote).length
  const quorumReached   = eligible === 0 || total / eligible >= 0.4
  const nonAbstain = approve + reject
  const majorityReached = nonAbstain === 0 || approve / nonAbstain > 0.5
  const rejectVeto      = total > 0 && reject / total >= 0.3
  return { eligible, total, approve, reject, abstain, quorumReached, majorityReached, rejectVeto }
})

interface Action { id: string; label: string; variant: string }

const availableActions = computed((): Action[] => {
  const m = props.motion
  const actions: Action[] = []
  if (m.state === 'draft') {
    actions.push({ id: 'open_discussion', label: 'Open Discussion', variant: 'btn-primary' })
    actions.push({ id: 'cancel',          label: 'Cancel Motion',   variant: 'btn-danger' })
  } else if (m.state === 'discussion') {
    if (m.is_binding && !isSeconded.value) {
      actions.push({ id: 'second', label: 'Second Motion', variant: 'btn-secondary' })
    }
    actions.push({ id: 'open_voting', label: 'Open Voting', variant: 'btn-primary' })
    actions.push({ id: 'cancel',      label: 'Cancel Motion', variant: 'btn-danger' })
  } else if (m.state === 'voting') {
    actions.push({ id: 'close', label: 'Close & Tally', variant: 'btn-primary' })
  }
  return actions
})

// ── Actions ────────────────────────────────────────────────────────────────

async function runAction(id: string) {
  busy.value    = true
  errorMsg.value = null
  try {
    if (id === 'open_discussion')  await governanceStore.openDiscussion(props.motion.id)
    else if (id === 'second')      await governanceStore.secondMotion(props.motion.id)
    else if (id === 'open_voting') await governanceStore.openVoting(props.motion.id)
    else if (id === 'close')       await governanceStore.closeMotion(props.motion.id)
    else if (id === 'cancel')      await governanceStore.cancelMotion(props.motion.id)
  } catch (err) {
    errorMsg.value = err instanceof Error ? err.message : String(err)
  } finally {
    busy.value = false
  }
}

async function castSimpleBallot(choice: 'approve' | 'reject' | 'abstain') {
  busy.value    = true
  errorMsg.value = null
  try {
    const uid = identityStore.userId ?? ''
    await governanceStore.castBallot(props.motion.id, {
      voter_user_id:               uid,
      approved_candidate_ids_json: '[]',
      reject_vote:                 choice === 'reject',
      abstain_vote:                choice === 'abstain',
    })
  } catch (err) {
    errorMsg.value = err instanceof Error ? err.message : String(err)
  } finally {
    busy.value = false
  }
}

async function castElectionBallot() {
  busy.value    = true
  errorMsg.value = null
  try {
    const uid = identityStore.userId ?? ''
    await governanceStore.castBallot(props.motion.id, {
      voter_user_id:               uid,
      approved_candidate_ids_json: JSON.stringify(approvedCandidates.value),
      reject_vote:                 false,
      abstain_vote:                false,
    })
  } catch (err) {
    errorMsg.value = err instanceof Error ? err.message : String(err)
  } finally {
    busy.value = false
  }
}

async function doSelfNominate() {
  busy.value    = true
  errorMsg.value = null
  try {
    await governanceStore.selfNominate(props.motion.id)
  } catch (err) {
    errorMsg.value = err instanceof Error ? err.message : String(err)
  } finally {
    busy.value = false
  }
}

async function doNominate() {
  if (!nomineeId.value) return
  busy.value    = true
  errorMsg.value = null
  try {
    await governanceStore.nominateCandidate(props.motion.id, nomineeId.value)
    nomineeId.value = ''
  } catch (err) {
    errorMsg.value = err instanceof Error ? err.message : String(err)
  } finally {
    busy.value = false
  }
}

async function doWithdraw(candidateUserId: string) {
  busy.value    = true
  errorMsg.value = null
  try {
    await governanceStore.withdrawCandidate(props.motion.id, candidateUserId)
  } catch (err) {
    errorMsg.value = err instanceof Error ? err.message : String(err)
  } finally {
    busy.value = false
  }
}

async function doAddPost() {
  const content = newPostContent.value.trim()
  if (!content) return
  busy.value    = true
  errorMsg.value = null
  try {
    await governanceStore.addPost(props.motion.id, content)
    newPostContent.value = ''
  } catch (err) {
    errorMsg.value = err instanceof Error ? err.message : String(err)
  } finally {
    busy.value = false
  }
}
</script>

<style scoped>
.motion-detail { display: flex; flex-direction: column; gap: var(--spacing-md); overflow-y: auto; }

/* Header */
.detail-header { display: flex; align-items: center; gap: var(--spacing-sm); }
.back-btn { background: none; border: none; color: var(--text-secondary); cursor: pointer; font-size: 13px; padding: 0; transform: none; }
.back-btn:hover { color: var(--text-primary); }
.detail-title { display: flex; gap: var(--spacing-xs); align-items: center; }
.type-badge { font-size: 11px; font-weight: 600; padding: 2px 6px; background: var(--accent-color); color: #fff; border-radius: var(--radius-sm); }
.state-badge { font-size: 11px; padding: 2px 6px; border-radius: var(--radius-sm); background: var(--bg-tertiary); color: var(--text-secondary); text-transform: capitalize; }
.state-badge.state-closed_passed { background: #1a4d2e; color: #6fcf97; }
.state-badge.state-closed_failed { background: #4d1a1a; color: #eb5757; }
.state-badge.state-voting { background: #2e3a4d; color: #56b4f0; }
.state-badge.state-cancelled { background: var(--bg-tertiary); color: var(--text-tertiary); }

/* Meta */
.detail-meta { display: flex; flex-direction: column; gap: 3px; }
.meta-row { display: flex; gap: var(--spacing-sm); font-size: 12px; }
.meta-row-eligibility { flex-wrap: wrap; }
.meta-label { color: var(--text-secondary); min-width: 130px; flex-shrink: 0; }
.meta-value { color: var(--text-primary); }
.mono { font-family: monospace; font-size: 11px; }

/* Sections */
.section { padding: var(--spacing-sm); background: var(--bg-secondary); border-radius: var(--radius-sm); display: flex; flex-direction: column; gap: var(--spacing-sm); }
.section-title { margin: 0; font-size: 13px; font-weight: 600; color: var(--text-primary); }
.empty-hint { font-size: 12px; color: var(--text-secondary); font-style: italic; }

/* Candidates */
.candidate-roster { display: flex; flex-direction: column; gap: 4px; }
.candidate-entry { display: flex; align-items: center; gap: var(--spacing-xs); font-size: 13px; }
.candidate-name { font-weight: 500; }
.candidate-source { font-size: 11px; color: var(--text-secondary); }
.candidate-withdrawn { font-size: 11px; color: var(--text-tertiary); font-style: italic; }
.nominate-controls { display: flex; flex-direction: column; gap: var(--spacing-xs); border-top: 1px solid var(--border-color); padding-top: var(--spacing-xs); }
.nominate-other { display: flex; gap: var(--spacing-xs); align-items: center; }
.form-select-sm { padding: 4px 6px; background: var(--bg-primary); border: 1px solid var(--border-color); border-radius: var(--radius-sm); color: var(--text-primary); font-size: 12px; flex: 1; }

/* Posts */
.post-list { display: flex; flex-direction: column; gap: var(--spacing-sm); }
.post-entry { background: var(--bg-primary); border-radius: var(--radius-sm); padding: var(--spacing-xs) var(--spacing-sm); }
.post-author { font-weight: 600; font-size: 12px; margin-right: var(--spacing-xs); }
.post-time { font-size: 11px; color: var(--text-tertiary); }
.post-content { margin: 4px 0 0; font-size: 13px; white-space: pre-wrap; }
.post-composer { display: flex; gap: var(--spacing-xs); align-items: flex-end; }
.post-textarea { flex: 1; padding: 6px 8px; background: var(--bg-primary); border: 1px solid var(--border-color); border-radius: var(--radius-sm); color: var(--text-primary); font-size: 13px; resize: vertical; font-family: inherit; }

/* Ballot */
.ballot-section {}
.current-vote { font-size: 12px; color: var(--text-secondary); }
.current-vote-label { margin-right: 4px; }
.current-vote-value { font-weight: 600; color: var(--text-primary); margin-right: 4px; }
.change-vote-hint { font-style: italic; }
.ballot-hint { font-size: 12px; color: var(--text-secondary); margin: 0; }
.ballot-options { display: flex; gap: var(--spacing-xs); }
.btn-vote { padding: 6px 14px; font-size: 12px; border: none; border-radius: var(--radius-sm); cursor: pointer; font-weight: 600; transition: opacity 0.1s; }
.btn-vote.active { outline: 2px solid #fff; outline-offset: 2px; }
.btn-vote:disabled { opacity: 0.5; cursor: not-allowed; }
.btn-approve { background: #27ae60; color: #fff; }
.btn-approve:hover:not(:disabled) { background: #219150; }
.btn-reject  { background: #e74c3c; color: #fff; }
.btn-reject:hover:not(:disabled)  { background: #c0392b; }
.btn-abstain { background: var(--bg-tertiary); color: var(--text-secondary); }
.btn-abstain:hover:not(:disabled) { background: var(--bg-quaternary, var(--bg-tertiary)); }
.candidate-list { display: flex; flex-direction: column; gap: 4px; margin-bottom: var(--spacing-xs); }
.candidate-row { display: flex; align-items: center; gap: var(--spacing-xs); font-size: 13px; cursor: pointer; }

/* Tally */
.tally-preview { border-top: 1px solid var(--border-color); padding-top: var(--spacing-sm); }
.tally-title { margin: 0 0 4px; font-size: 12px; color: var(--text-secondary); font-weight: 400; }
.tally-bar-row { display: flex; justify-content: space-between; font-size: 12px; padding: 2px 0; }
.tally-threshold { color: var(--text-secondary); }
.tally-threshold.met { color: #6fcf97; }
.tally-threshold.vetoed { color: #eb5757; }

/* Result */
.result-section {}
.result-badge { padding: var(--spacing-sm) var(--spacing-md); border-radius: var(--radius-sm); font-weight: 700; font-size: 14px; text-align: center; }
.result-badge.passed { background: #1a4d2e; color: #6fcf97; }
.result-badge.failed { background: #4d1a1a; color: #eb5757; }
.closed-tally { margin-top: var(--spacing-sm); display: flex; flex-direction: column; gap: 2px; }

/* Actions */
.action-bar { display: flex; gap: var(--spacing-xs); flex-wrap: wrap; }
.action-btn { padding: 7px 14px; font-size: 12px; border: none; border-radius: var(--radius-sm); cursor: pointer; font-weight: 600; }
.action-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.btn-sm { padding: 4px 10px; font-size: 12px; border-radius: var(--radius-sm); border: none; cursor: pointer; }
.btn-tiny { padding: 2px 7px; font-size: 11px; border-radius: var(--radius-sm); border: none; cursor: pointer; }
.btn-primary   { background: var(--accent-color); color: #fff; }
.btn-primary:hover:not(:disabled) { opacity: 0.85; }
.btn-secondary { background: var(--bg-tertiary); color: var(--text-primary); }
.btn-secondary:hover:not(:disabled) { background: var(--bg-quaternary, var(--bg-tertiary)); }
.btn-danger    { background: #c0392b; color: #fff; }
.btn-danger:hover:not(:disabled) { background: #a93226; }

.error-msg { color: #eb5757; font-size: 12px; padding: var(--spacing-xs) var(--spacing-sm); background: rgba(235,87,87,0.1); border-radius: var(--radius-sm); }
</style>
