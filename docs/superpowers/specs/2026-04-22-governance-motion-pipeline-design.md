# Governance Motion Pipeline (Feature-Flagged) Design

## Goal
Stabilize existing HexField features while adding a robust, reusable governance motion pipeline that is disabled by default at server level, plus a non-governance fallback path that keeps current behavior simple and safe.

## Scope

### In Scope
- Server-level governance motion system (draft -> discussion -> vote -> resolution -> archive).
- Binding role governance for owner/admin continuity.
- Non-binding proposals and polls.
- New Settings > Network tab split from Voice.
- Governance docs surfaced in Settings > Help.
- Reusable architecture for future forum-style channels (threaded posts/comments).
- Server-level feature flag for governance, default disabled.
- Fallback non-governance flow: leave server behavior for all roles plus direct heir designation paths.

### Out of Scope
- Full forum channel feature implementation.
- Major new social platform features beyond governance and stabilization.
- Protocol-breaking changes for older peers without fallback semantics.

## Feature Flag Strategy

### Flag
- Name: `governanceMotionPipelineEnabled`
- Scope: per-server
- Default: `false`
- Storage: server settings persisted in SQLite and synced via server-level mutation.

### Behavior by Flag State
- `false`:
  - Governance UI is hidden.
  - No motion lifecycle actions are available.
  - Server actions route through simplified leave/heir workflows.
- `true`:
  - Governance UI enabled.
  - Motion lifecycle and role-governance workflows available.
  - Binding side effects executed only when validation rules pass.

### Rollout
- New servers default with governance flag off.
- Existing servers keep behavior unchanged until explicitly enabled by admin/owner.
- Flag can be exposed under server settings as an advanced server feature toggle.

## Non-Governance Fallback Route (Flag Off)

### Universal Leave
- Any member can leave server.
- If leaving member is the last member, local server data is removed from that device database.

### Owner Leave / Owner Abdication
- Owner can leave server.
- Owner can also voluntarily abdicate while staying in server.
- Owner is prompted to designate an heir (owner successor), but may skip.
- If skipped, server enters owner-vacancy caretaker state:
  - Admin powers remain.
  - Owner-only actions locked.

### Admin Leave
- Admin can leave server.
- Admin can optionally designate an admin heir (a suggested replacement candidate).
- In non-governance mode, heir designation is direct role assignment only when allowed by existing role permissions; otherwise stored as pending recommendation for owner/admin review.

### Delete Terminology
- No explicit "Delete Server" action in UI.
- "Leave Server" is the only destructive action wording.
- Last-member leave performs local cleanup implicitly.

## Governance Motion System (Flag On)

## 1) Lifecycle
- Draft
- Discussion
- Voting
- Closed
- Archived

All transitions are signed, server-level mutations.

## 2) Motion Types
- Binding role actions:
  - Elect/replace owner
  - Elect/remove/depose admin(s)
  - Ratify owner succession outcomes
- Non-binding:
  - Policy proposals
  - Opinion polls
  - Advisory moderation guidance

## 3) Eligibility and Time Rules
- Recently-online eligibility window: 7 days.
- Inactivity gates:
  - Owner replacement challenge: 21 days.
  - Admin challenge: 10 days.
- Initiation tiers:
  - Owner replacement motions initiated by admins.
  - Admin actions initiated by members.
  - If owner and admins inactive: members initiate admin replacement, then admins initiate owner replacement.

## 4) Discussion and Voting Gates
- Binding motions:
  - Minimum discussion: 12h
  - Default discussion: 24h
  - Vote cannot open until motion is seconded.
  - Vote window minimum: 24h
  - Vote window maximum: 7 days
- Non-binding/polls:
  - Can skip second.
  - Discussion/vote windows may be shorter.

## 5) Voting Semantics
- Ballot choices:
  - Approve (one or many candidates)
  - Reject (explicit opposition)
  - Abstain (neutral participation)
- Vote changes allowed until close.
- Final ballot per voter at close is counted.

### Passage Rules (Binding)
- Quorum: at least 40% of eligible voters cast any ballot.
- Majority: approvals > 50% of non-abstaining ballots.
- Reject veto: rejects >= 30% of participants => motion fails.

## 6) Candidate Slate, Nominations, and Seats
- Motion includes `seatCount`.
- Admin elections default to one seat at a time; bulk seat elections are optional.
- Candidate sources:
  - proposer-listed candidates
  - member nominations (require second)
- Candidate may withdraw before vote opens.
- Slate is finalized at vote-open and frozen.

### Multi-seat Result
- Top `seatCount` candidates by approvals win.
- Boundary ties trigger automatic runoff/secondary motion.
- Runoff uses same validation model with shorter default window (12h).

## 7) Ownership Continuity
- Owner may abdicate without leaving.
- Owner may leave with optional heir designation.
- If no heir is selected, caretaker mode activates.

### Caretaker Mode
- Admins keep admin powers.
- Owner-only actions locked.
- Admins can immediately open owner election motion (inactivity gate waived in caretaker mode).
- Mode exits after valid owner election.

## Settings IA Split

## Voice & Video Tab
- Input/output devices
- Noise suppression, echo cancellation
- Loopback
- Video quality and bitrate
- Screen-share quality

## Network Tab (New)
- Rendezvous server controls
- STUN/TURN controls
- Relay behavior/fallback visibility
- NAT diagnostics and current connection mode
- Connectivity status insights

No transport settings remain under Voice.

## Help Documentation Additions
- Governance lifecycle guide
- Binding vs non-binding explanation
- Eligibility and threshold rules
- Owner/admin replacement pathways
- Caretaker mode semantics
- Common vote-failure reasons (quorum, veto, eligibility)

## Data Model (Reusable for Future Forum)

### Motion
- `id`, `serverId`, `type`, `state`, `isBinding`, `seatCount`
- `proposerUserId`, `eligibilitySnapshot`
- `discussionOpenAt`, `voteOpenAt`, `voteCloseAt`
- `ruleset`, `createdAt`, `updatedAt`

### CandidateEntry
- `motionId`, `candidateUserId`, `source`
- `nominatedByUserId`, `secondedByUserId`
- `status` (`pending`, `accepted`, `withdrawn`, `finalized`)

### Ballot
- `motionId`, `voterUserId`
- `approvedCandidateIds[]`, `reject`, `abstain`
- `revision`, `updatedAt`

### DiscussionPost (Forum-compatible primitive)
- `id`, `motionId`, `parentPostId`, `authorUserId`
- `content`, `createdAt`, `editedAt`, `deletedAt`

This post/thread primitive is intentionally reusable for forum channels later.

## Validation and Security Model
- Every event is signed and validated per client.
- Eligibility snapshot frozen at vote-open.
- Time and tier rules validated locally before applying binding effects.
- Invalid binding outcomes are retained as history but not executed.
- Idempotent merge behavior on sync.
- Deterministic runoff creation to avoid divergent peer state.

## Risks and Mitigations
- Modified client can ignore local rules:
  - Mitigation: honest peers reject invalid signed outcomes.
- Vote spam / governance churn:
  - Mitigation: cooldown for equivalent failed binding motions (recommended 24h).
- Candidate slate flooding:
  - Mitigation: nomination requires second; configurable candidate cap.
- Caretaker stagnation:
  - Mitigation: member -> admin -> owner recovery chain via inactivity gates.

## Acceptance Criteria
1. Governance flag off produces simple leave/heir behavior and hides governance UI.
2. Governance flag on enables full motion pipeline.
3. Binding motions enforce seconding, discussion minimum, and vote minimum.
4. Snapshot, quorum, majority, and reject-veto are deterministic across peers.
5. Candidate nominations/withdrawals behave as defined and freeze correctly at vote-open.
6. Boundary ties generate runoff motions automatically.
7. Owner abdication without leaving works.
8. Owner vacancy enters caretaker mode; owner election exits it.
9. Voice/Network tab split is complete and unambiguous.
10. Help tab includes governance docs and threshold explanations.
11. Data model supports later forum-thread reuse without redesign.

## Implementation Notes (Design-Level)
- Prefer additive schema changes and migration safety for old DBs.
- Keep wire compatibility by ignoring unknown governance fields on older clients.
- Maintain server-level mutation log as source of truth.
- Build reusable threaded discussion components in a governance namespace first, then generalize for future forum channels.
