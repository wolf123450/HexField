# Governance Motion Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement a feature-flagged governance motion pipeline (off by default) with fallback leave/heir flows, network settings split, and negentropy-based propagation using existing mutation sync pathways.

**Architecture:** Keep governance events as server-level signed mutations (`channel_id = '__server__'`) so replication stays on existing negentropy pathways. Add a governance projection layer (SQLite + Pinia store) for efficient UI queries while treating the mutation log as source-of-truth. Gate all governance behavior behind per-server flag `governanceMotionPipelineEnabled`; fallback route stays simple and active when disabled.

**Tech Stack:** Vue 3.5 + Pinia + TypeScript strict, Tauri v2, Rust + rusqlite + rusqlite_migration, Vitest, cargo test.

---

### Task 1: Add Governance Schema + Rust Row Types

**Files:**
- Create: `src-tauri/migrations/013_governance_motion_pipeline.sql`
- Modify: `src-tauri/src/db/migrations.rs`
- Modify: `src-tauri/src/db/types.rs`
- Test: `src-tauri/src/commands/db_commands.rs` (new `#[cfg(test)]` migration smoke test)

- [ ] **Step 1: Write failing migration smoke test**

```rust
#[test]
fn governance_tables_exist_after_migration() {
    let mut conn = rusqlite::Connection::open_in_memory().unwrap();
    crate::db::migrations::run(&mut conn);

    let names: Vec<String> = {
        let mut stmt = conn.prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'governance_%' ORDER BY name"
        ).unwrap();
        stmt.query_map([], |r| r.get::<_, String>(0)).unwrap()
            .collect::<Result<Vec<_>, _>>().unwrap()
    };

    assert!(names.contains(&"governance_motions".to_string()));
    assert!(names.contains(&"governance_candidates".to_string()));
    assert!(names.contains(&"governance_ballots".to_string()));
    assert!(names.contains(&"governance_posts".to_string()));
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src-tauri; cargo test governance_tables_exist_after_migration -- --nocapture`
Expected: FAIL with missing table assertions.

- [ ] **Step 3: Add migration SQL**

```sql
CREATE TABLE IF NOT EXISTS governance_motions (
  id TEXT PRIMARY KEY,
  server_id TEXT NOT NULL,
  type TEXT NOT NULL,
  state TEXT NOT NULL,
  is_binding INTEGER NOT NULL,
  seat_count INTEGER NOT NULL DEFAULT 1,
  proposer_user_id TEXT NOT NULL,
  eligibility_snapshot_json TEXT,
  discussion_open_at TEXT,
  vote_open_at TEXT,
  vote_close_at TEXT,
  ruleset_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_governance_motions_server_state
  ON governance_motions(server_id, state, updated_at DESC);

CREATE TABLE IF NOT EXISTS governance_candidates (
  motion_id TEXT NOT NULL,
  candidate_user_id TEXT NOT NULL,
  source TEXT NOT NULL,
  nominated_by_user_id TEXT,
  seconded_by_user_id TEXT,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (motion_id, candidate_user_id)
);

CREATE TABLE IF NOT EXISTS governance_ballots (
  motion_id TEXT NOT NULL,
  voter_user_id TEXT NOT NULL,
  approved_candidate_ids_json TEXT NOT NULL,
  reject_vote INTEGER NOT NULL,
  abstain_vote INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (motion_id, voter_user_id)
);

CREATE TABLE IF NOT EXISTS governance_posts (
  id TEXT PRIMARY KEY,
  motion_id TEXT NOT NULL,
  parent_post_id TEXT,
  author_user_id TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL,
  edited_at TEXT,
  deleted_at TEXT
);
```

- [ ] **Step 4: Register migration + row structs**

```rust
const M013: &str = include_str!("../../migrations/013_governance_motion_pipeline.sql");
const M012: &str = include_str!("../../migrations/012_drop_data_url_cols.sql");
let migrations = Migrations::new(vec![
  M::up(M001), M::up(M002), M::up(M003), M::up(M004),
  M::up(M005), M::up(M006), M::up(M007), M::up(M008),
  M::up(M009), M::up(M010), M::up(M011), M::up(M012), M::up(M013)
]);
```

```rust
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct GovernanceMotionRow {
    pub id: String,
    pub server_id: String,
    pub motion_type: String,
    pub state: String,
    pub is_binding: bool,
    pub seat_count: i64,
    pub proposer_user_id: String,
    pub eligibility_snapshot_json: Option<String>,
    pub discussion_open_at: Option<String>,
    pub vote_open_at: Option<String>,
    pub vote_close_at: Option<String>,
    pub ruleset_json: String,
    pub created_at: String,
    pub updated_at: String,
}
```

- [ ] **Step 5: Re-run migration test**

Run: `cd src-tauri; cargo test governance_tables_exist_after_migration -- --nocapture`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/migrations/013_governance_motion_pipeline.sql src-tauri/src/db/migrations.rs src-tauri/src/db/types.rs src-tauri/src/commands/db_commands.rs
git commit -m "feat(db): add governance motion pipeline schema"
```

### Task 2: Implement Governance DB Commands + Deterministic Tally Helpers

**Files:**
- Modify: `src-tauri/src/commands/db_commands.rs`
- Modify: `src-tauri/src/lib.rs`
- Test: `src-tauri/src/commands/db_commands.rs` (`#[cfg(test)]`)

- [ ] **Step 1: Write failing Rust tests for tally rules**

```rust
#[test]
fn tally_passes_with_quorum_majority_and_no_reject_veto() {
    let result = compute_governance_outcome(50, 16, 8, 6);
    assert!(result.passed);
}

#[test]
fn tally_fails_when_reject_veto_hits_30_percent_participants() {
    let result = compute_governance_outcome(50, 18, 15, 2);
    assert!(!result.passed);
    assert_eq!(result.fail_reason.as_deref(), Some("reject_veto"));
}
```

- [ ] **Step 2: Run failing tests**

Run: `cd src-tauri; cargo test tally_ -- --nocapture`
Expected: FAIL unresolved function `compute_governance_outcome`.

- [ ] **Step 3: Add helper + DB commands**

```rust
fn compute_governance_outcome(
    eligible: i64,
    approve_votes: i64,
    reject_votes: i64,
    abstain_votes: i64,
) -> GovernanceOutcome {
    let participants = approve_votes + reject_votes + abstain_votes;
    let quorum_ok = (participants as f64) / (eligible.max(1) as f64) >= 0.40;
    let non_abstain = (approve_votes + reject_votes).max(1);
    let majority_ok = (approve_votes as f64) / (non_abstain as f64) > 0.50;
    let reject_veto = (reject_votes as f64) / (participants.max(1) as f64) >= 0.30;
  let passed = quorum_ok && majority_ok && !reject_veto;
  let fail_reason = if !quorum_ok {
    Some("quorum")
  } else if reject_veto {
    Some("reject_veto")
  } else if !majority_ok {
    Some("majority")
  } else {
    None
  };
  GovernanceOutcome { passed, fail_reason: fail_reason.map(str::to_string) }
}
```

```rust
#[tauri::command]
pub fn db_save_governance_motion(state: State<AppState>, motion: GovernanceMotionRow) -> Result<(), String> {
  let conn = state.db.lock().map_err(|e| e.to_string())?;
  conn.execute("INSERT OR REPLACE INTO governance_motions (id, server_id, type, state, is_binding, seat_count, proposer_user_id, eligibility_snapshot_json, discussion_open_at, vote_open_at, vote_close_at, ruleset_json, created_at, updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)",
    rusqlite::params![motion.id, motion.server_id, motion.motion_type, motion.state, motion.is_binding as i64, motion.seat_count, motion.proposer_user_id, motion.eligibility_snapshot_json, motion.discussion_open_at, motion.vote_open_at, motion.vote_close_at, motion.ruleset_json, motion.created_at, motion.updated_at]
  ).map_err(|e| e.to_string())?;
  Ok(())
}

#[tauri::command]
pub fn db_load_governance_motions(state: State<AppState>, server_id: String, state_filter: Option<String>) -> Result<Vec<GovernanceMotionRow>, String> {
  let conn = state.db.lock().map_err(|e| e.to_string())?;
  let sql = if state_filter.is_some() {
    "SELECT id, server_id, type, state, is_binding, seat_count, proposer_user_id, eligibility_snapshot_json, discussion_open_at, vote_open_at, vote_close_at, ruleset_json, created_at, updated_at FROM governance_motions WHERE server_id = ?1 AND state = ?2 ORDER BY updated_at DESC"
  } else {
    "SELECT id, server_id, type, state, is_binding, seat_count, proposer_user_id, eligibility_snapshot_json, discussion_open_at, vote_open_at, vote_close_at, ruleset_json, created_at, updated_at FROM governance_motions WHERE server_id = ?1 ORDER BY updated_at DESC"
  };
  let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
  let rows = if let Some(s) = state_filter {
    stmt.query_map(rusqlite::params![server_id, s], row_to_governance_motion)
  } else {
    stmt.query_map(rusqlite::params![server_id], row_to_governance_motion)
  }.map_err(|e| e.to_string())?
    .collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?;
  Ok(rows)
}

#[tauri::command]
pub fn db_save_governance_ballot(state: State<AppState>, ballot: GovernanceBallotRow) -> Result<(), String> {
  let conn = state.db.lock().map_err(|e| e.to_string())?;
  conn.execute("INSERT OR REPLACE INTO governance_ballots (motion_id, voter_user_id, approved_candidate_ids_json, reject_vote, abstain_vote, revision, updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7)",
    rusqlite::params![ballot.motion_id, ballot.voter_user_id, ballot.approved_candidate_ids_json, ballot.reject_vote as i64, ballot.abstain_vote as i64, ballot.revision, ballot.updated_at]
  ).map_err(|e| e.to_string())?;
  Ok(())
}
```

- [ ] **Step 4: Register new commands**

```rust
.invoke_handler(tauri::generate_handler![
  db_load_messages,
  db_save_message,
  db_save_mutation,
  db_load_mutations,
  db_save_governance_motion,
  db_load_governance_motions,
  db_save_governance_candidate,
  db_load_governance_candidates,
  db_save_governance_ballot,
  db_load_governance_ballots,
  db_save_governance_post,
  db_load_governance_posts,
])
```

- [ ] **Step 5: Run command/tally tests**

Run: `cd src-tauri; cargo test governance_ -- --nocapture`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/commands/db_commands.rs src-tauri/src/lib.rs
git commit -m "feat(rust): add governance db commands and tally rules"
```

### Task 3: Add TypeScript Governance Domain Types + Feature Flag Settings

**Files:**
- Modify: `src/types/core.ts`
- Modify: `src/stores/settingsStore.ts`
- Modify: `src/stores/serversStore.ts`
- Test: `src/stores/__tests__/serversStore.test.ts`

- [ ] **Step 1: Write failing store test for governance flag default off**

```ts
it('defaults governance feature flag to disabled on new server settings', async () => {
  const store = useServersStore()
  const server = await store.createServer('My Server')
  expect(server.governanceMotionPipelineEnabled).toBe(false)
})
```

- [ ] **Step 2: Run test to verify failure**

Run: `npm run test -- src/stores/__tests__/serversStore.test.ts -t governance`
Expected: FAIL (missing property / undefined).

- [ ] **Step 3: Add domain types + server flag field**

```ts
export interface Server {
  id: string
  name: string
  ownerId: string
  memberCount: number
  createdAt: string
  governanceMotionPipelineEnabled?: boolean
}

export interface GovernanceMotion {
  id: string
  serverId: string
  type: 'binding_role' | 'binding_policy' | 'non_binding_poll'
  state: 'draft' | 'discussion' | 'voting' | 'closed' | 'archived'
  isBinding: boolean
  seatCount: number
  proposerUserId: string
  eligibilitySnapshot?: string[]
  discussionOpenAt?: string
  voteOpenAt?: string
  voteCloseAt?: string
  ruleset: GovernanceRuleset
  createdAt: string
  updatedAt: string
}
```

- [ ] **Step 4: Add server settings defaults + persistence path**

```ts
if (server.governanceMotionPipelineEnabled === undefined) {
  server.governanceMotionPipelineEnabled = false
}
```

- [ ] **Step 5: Re-run store tests**

Run: `npm run test -- src/stores/__tests__/serversStore.test.ts -t governance`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/types/core.ts src/stores/settingsStore.ts src/stores/serversStore.ts src/stores/__tests__/serversStore.test.ts
git commit -m "feat(frontend): add governance domain types and server feature flag"
```

### Task 4: Implement Non-Governance Fallback Leave/Heir Flows

**Files:**
- Modify: `src/stores/serversStore.ts`
- Modify: `src/stores/uiStore.ts`
- Create: `src/components/modals/LeaveServerModal.vue`
- Test: `src/stores/__tests__/serversStore.test.ts`

- [ ] **Step 1: Write failing tests for fallback route behavior**

```ts
it('owner can abdicate without leaving when governance flag is off', async () => {
  const store = useServersStore()
  const server = await store.createServer('Caretaker Test')
  server.governanceMotionPipelineEnabled = false
  await store.abdicateOwnership(server.id, { heirUserId: null })
  const me = store.members[server.id][store.members[server.id][Object.keys(store.members[server.id])[0]].userId]
  expect(me.roles.includes('owner')).toBe(false)
  expect(store.servers[server.id].ownerId).toBe('')
})

it('last member leave triggers local server cleanup', async () => {
  const store = useServersStore()
  const server = await store.createServer('Cleanup Test')
  server.governanceMotionPipelineEnabled = false
  await store.leaveServer(server.id)
  expect(store.servers[server.id]).toBeUndefined()
  expect(store.joinedServerIds.includes(server.id)).toBe(false)
})
```

- [ ] **Step 2: Run tests and capture expected failures**

Run: `npm run test -- src/stores/__tests__/serversStore.test.ts -t leave`
Expected: FAIL for missing actions.

- [ ] **Step 3: Implement store actions + modal wiring**

```ts
async function leaveServer(serverId: string, opts?: { heirUserId?: string; abdicateOnly?: boolean }) {
  const server = servers.value[serverId]
  if (!server) return

  if (!server.governanceMotionPipelineEnabled) {
    await applyFallbackHeirOrCaretaker(serverId, opts?.heirUserId)
    await persistLeave(serverId)
    return
  }
  const { useGovernanceStore } = await import('./governanceStore')
  await useGovernanceStore().startOwnerLeaveMotion(serverId, opts)
}
```

- [ ] **Step 4: Re-run leave/heir tests**

Run: `npm run test -- src/stores/__tests__/serversStore.test.ts -t "leave|abdicate|heir"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/stores/serversStore.ts src/stores/uiStore.ts src/components/modals/LeaveServerModal.vue src/stores/__tests__/serversStore.test.ts
git commit -m "feat(servers): add fallback leave and heir flows when governance disabled"
```

### Task 5: Build Governance Store + Motion Lifecycle Engine

**Files:**
- Create: `src/stores/governanceStore.ts`
- Modify: `src/stores/networkStore.ts`
- Modify: `src/stores/messagesStore.ts`
- Test: `src/stores/__tests__/governanceStore.test.ts`

- [ ] **Step 1: Write failing governance lifecycle tests**

```ts
it('binding motion cannot open voting until seconded and min discussion window elapsed', async () => {
  const store = useGovernanceStore()
  const motionId = await store.createDraft({ serverId: 's1', type: 'binding_role', isBinding: true, seatCount: 1, title: 'Replace owner' })
  await store.openDiscussion(motionId)
  await expect(store.openVoting(motionId)).rejects.toThrow(/seconded/i)
  const motion = store.getMotionById(motionId)
  expect(motion?.state).toBe('discussion')
})

it('freeze eligibility snapshot at vote open', async () => {
  const store = useGovernanceStore()
  const motionId = await store.createDraft({ serverId: 's1', type: 'binding_role', isBinding: true, seatCount: 1, title: 'Replace owner' })
  await store.openDiscussion(motionId)
  await store.secondMotion(motionId)
  await store.fastForwardDiscussionForTest(motionId, 24)
  await store.openVoting(motionId)
  const snapshot = [...(store.getMotionById(motionId)?.eligibilitySnapshot ?? [])]
  store.__testSetRecentlyOnline(['u1'])
  expect(store.getMotionById(motionId)?.eligibilitySnapshot).toEqual(snapshot)
})
```

- [ ] **Step 2: Run governance tests to confirm failure**

Run: `npm run test -- src/stores/__tests__/governanceStore.test.ts`
Expected: FAIL (store file missing).

- [ ] **Step 3: Implement store state + commands**

```ts
export const useGovernanceStore = defineStore('governance', () => {
  const motions = ref<Record<string, GovernanceMotion[]>>({})
  const candidates = ref<Record<string, GovernanceCandidate[]>>({})
  const ballots = ref<Record<string, GovernanceBallot[]>>({})
  const posts = ref<Record<string, GovernancePost[]>>({})

  async function createDraft(input: CreateMotionInput) {
    const motion = await invoke<GovernanceMotion>('db_save_governance_motion', { motion: mapDraftToRow(input) })
    upsertMotion(motion)
    return motion.id
  }
  async function openDiscussion(motionId: string) { return transitionState(motionId, 'discussion') }
  async function secondMotion(motionId: string) { return setSecondedBy(motionId) }
  async function openVoting(motionId: string) { return validateAndOpenVoting(motionId) }
  async function castBallot(motionId: string, ballot: BallotInput) { return saveBallotRevision(motionId, ballot) }
  async function closeMotion(motionId: string) { return closeAndResolve(motionId) }

  return { motions, candidates, ballots, posts, createDraft, openDiscussion, secondMotion, openVoting, castBallot, closeMotion }
})
```

- [ ] **Step 4: Hook network mutation handler for governance events**

```ts
if (msg.type === 'mutation' && msg.mutation.channelId === '__server__') {
  await governanceStore.applyGovernanceMutation(msg.mutation)
}
```

- [ ] **Step 5: Re-run governance store tests**

Run: `npm run test -- src/stores/__tests__/governanceStore.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/stores/governanceStore.ts src/stores/networkStore.ts src/stores/messagesStore.ts src/stores/__tests__/governanceStore.test.ts
git commit -m "feat(governance): add motion lifecycle store and deterministic gating"
```

### Task 6: Add Governance UI + Settings IA Split (Network Tab)

**Files:**
- Modify: `src/components/Settings.vue`
- Create: `src/components/settings/SettingsNetworkTab.vue`
- Modify: `src/components/settings/SettingsVoiceTab.vue`
- Modify: `src/components/settings/SettingsHelpTab.vue`
- Create: `src/components/governance/GovernancePanel.vue`
- Create: `src/components/governance/MotionComposer.vue`
- Create: `src/components/governance/MotionDiscussion.vue`
- Create: `src/components/governance/MotionBallot.vue`
- Create: `src/components/governance/MotionArchive.vue`
- Test: `src/components/__tests__/SettingsNetworkTab.test.ts`

- [ ] **Step 1: Write failing component tests for tab split**

```ts
it('renders Network tab and excludes network controls from Voice tab', async () => {
  const wrapper = mount(Settings, { global: { plugins: [createTestingPinia({ createSpy: vi.fn })] } })
  expect(wrapper.text()).toContain('Network')
  await wrapper.findAll('button').find(b => b.text() === 'Voice & Video')?.trigger('click')
  expect(wrapper.text()).not.toContain('Rendezvous Server URL')
})
```

- [ ] **Step 2: Run failing UI tests**

Run: `npm run test -- src/components/__tests__/SettingsNetworkTab.test.ts`
Expected: FAIL missing component/tab.

- [ ] **Step 3: Implement tab split + governance feature gating in UI**

```vue
<SettingsNetworkTab v-else-if="activeTab === 'network'" />
```

```vue
<section v-if="server.governanceMotionPipelineEnabled">
  <GovernancePanel :server-id="server.id" />
</section>
<section v-else>
  <p>Governance motions are disabled for this server.</p>
</section>
```

- [ ] **Step 4: Add Help docs content for governance rules**

```vue
<h3>Governance Motions</h3>
<p>Binding motions require seconding, discussion minimums, and a 24h+ vote window.</p>
```

- [ ] **Step 5: Re-run component tests**

Run: `npm run test -- src/components/__tests__/SettingsNetworkTab.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/components/Settings.vue src/components/settings/SettingsNetworkTab.vue src/components/settings/SettingsVoiceTab.vue src/components/settings/SettingsHelpTab.vue src/components/governance src/components/__tests__/SettingsNetworkTab.test.ts
git commit -m "feat(ui): split network settings and add governance surfaces"
```

### Task 7: Integrate Governance Replication With Existing Negentropy Pathway

**Files:**
- Modify: `src/services/syncService.ts`
- Modify: `src/stores/governanceStore.ts`
- Modify: `src-tauri/src/commands/sync_commands.rs`
- Test: `src/services/__tests__/syncService.test.ts`

- [ ] **Step 1: Write failing sync test for governance mutations**

```ts
it('hydrates governance state from __server__ mutation sync_push', async () => {
  const { handleSyncMessage } = await import('@/services/syncService')
  const peerId = 'peer-a'
  await handleSyncMessage(peerId, {
    type: 'sync_push',
    sessionId: 's',
    table: 'mutations',
    channelId: '__server__',
    mutations: [{ id: 'm1', type: 'governance_motion_create', target_id: 'motion-1', channel_id: '__server__', author_id: 'u1', new_content: '{"serverId":"s1"}', emoji_id: null, logical_ts: '1-000001', created_at: new Date().toISOString(), verified: true }],
  })
  const gov = useGovernanceStore()
  expect(gov.hasMotion('motion-1')).toBe(true)
})
```

- [ ] **Step 2: Run failing sync test**

Run: `npm run test -- src/services/__tests__/syncService.test.ts -t governance`
Expected: FAIL with missing governance routing.

- [ ] **Step 3: Route governance mutation types in sync handler**

```ts
if (wire.channelId === '__server__') {
  for (const row of wire.mutations) {
    const mutation = _rowToMutation(row)
    if (mutation.type.startsWith('governance_')) {
      await governanceStore.applyGovernanceMutation(mutation)
    }
  }
}
```

- [ ] **Step 4: Verify no new protocol introduced**

```rust
// Keep existing pathway unchanged:
// - sync_list_channels returns channel IDs only
// - sync_get_mutations reads from `mutations`
// - governance_* entries are persisted in `mutations` with channel_id='__server__'
// No new sync table or wire message type is introduced.
```

- [ ] **Step 5: Re-run sync tests**

Run: `npm run test -- src/services/__tests__/syncService.test.ts -t governance`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/services/syncService.ts src/stores/governanceStore.ts src-tauri/src/commands/sync_commands.rs src/services/__tests__/syncService.test.ts
git commit -m "feat(sync): propagate governance via existing negentropy mutation flow"
```

### Task 8: Enforce Runoff + Multi-Seat Election Semantics

**Files:**
- Modify: `src/stores/governanceStore.ts`
- Modify: `src-tauri/src/commands/db_commands.rs`
- Test: `src/stores/__tests__/governanceStore.test.ts`
- Test: `src-tauri/src/commands/db_commands.rs` tests

- [ ] **Step 1: Add failing tests for seatCount and runoff creation**

```ts
it('elects top N approvals for seatCount and generates runoff on boundary tie', async () => {
  const store = useGovernanceStore()
  const motionId = await store.createDraft({ serverId: 's1', type: 'binding_role', isBinding: true, seatCount: 3, title: 'Elect admins' })
  await store.seedFinalTallyForTest(motionId, [
    { candidateId: 'a', approvals: 15 },
    { candidateId: 'b', approvals: 14 },
    { candidateId: 'c', approvals: 13 },
    { candidateId: 'd', approvals: 13 },
  ])
  await store.closeMotion(motionId)
  expect(store.listRunoffsForParent(motionId)).toHaveLength(1)
})
```

```rust
#[test]
fn creates_runoff_when_boundary_tie_detected() {
    let tied = vec![
        RankedCandidate { candidate_id: "c".into(), approvals: 13 },
        RankedCandidate { candidate_id: "d".into(), approvals: 13 },
    ];
    let runoff = build_runoff_from_boundary_tie("motion-1", 1, &tied).unwrap();
    assert_eq!(runoff.parent_motion_id, "motion-1");
    assert_eq!(runoff.seat_count, 1);
    assert_eq!(runoff.candidate_ids, vec!["c", "d"]);
}
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npm run test -- src/stores/__tests__/governanceStore.test.ts -t runoff`
Expected: FAIL.

Run: `cd src-tauri; cargo test runoff -- --nocapture`
Expected: FAIL.

- [ ] **Step 3: Implement deterministic runoff generation**

```ts
if (isBoundaryTie(rankings, motion.seatCount)) {
  await createRunoffMotion({
    parentMotionId: motion.id,
    candidates: tiedCandidates,
    seatCount: remainingSeats,
    defaultVoteHours: 12,
  })
}
```

- [ ] **Step 4: Re-run runoff tests**

Run: `npm run test -- src/stores/__tests__/governanceStore.test.ts -t runoff`
Expected: PASS.

Run: `cd src-tauri; cargo test runoff -- --nocapture`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/stores/governanceStore.ts src/stores/__tests__/governanceStore.test.ts src-tauri/src/commands/db_commands.rs
git commit -m "feat(governance): add seat-count elections and deterministic runoff"
```

### Task 9: End-to-End Verification + Docs Updates

**Files:**
- Modify: `docs/TODO.md`
- Modify: `docs/specs/11-permissions.md`
- Modify: `docs/specs/04-ui-architecture.md`
- Modify: `docs/specs/07-message-sync.md`
- Test: existing suites

- [ ] **Step 1: Add failing doc consistency checks (manual checklist)**

```text
Checklist:
- Governance flag default-off documented
- Non-governance leave/heir fallback documented
- Negentropy propagation requirement documented
- Network tab split documented
```

- [ ] **Step 2: Update docs and TODO checkboxes**

```markdown
- [x] Governance motion pipeline (feature-flagged, default off)
- [x] Settings split: Voice vs Network
- [x] Governance data synced via existing negentropy pathway
```

- [ ] **Step 3: Run full verification commands**

Run: `npm run build`
Expected: PASS (vue-tsc + vite).

Run: `npm run test`
Expected: PASS.

Run: `cd src-tauri; cargo check`
Expected: PASS.

Run: `cd src-tauri; cargo test`
Expected: PASS.

- [ ] **Step 4: Commit docs + final verification artifacts**

```bash
git add docs/TODO.md docs/specs/11-permissions.md docs/specs/04-ui-architecture.md docs/specs/07-message-sync.md
git commit -m "docs: finalize governance, settings split, and sync behavior specs"
```

- [ ] **Step 5: Final branch summary commit (if needed)**

```bash
git log --oneline --decorate -n 15
```

Expected: clean sequence of feature + test + docs commits for review/PR.
