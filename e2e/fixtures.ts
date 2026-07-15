import { createTauriTest } from '@srsholmes/tauri-playwright'

const E2E_SERVER = {
  id: 'e2e-server-1',
  name: 'Governance E2E',
  ownerId: 'user-e2e',
  memberCount: 1,
  createdAt: '2026-04-23T00:00:00.000Z',
  customEmoji: [],
} as const

const E2E_CHANNEL_ROW = {
  id: 'e2e-chan-general',
  server_id: E2E_SERVER.id,
  name: 'general',
  type: 'text',
  position: 0,
  topic: null,
  created_at: '2026-04-23T00:00:00.000Z',
} as const

let governanceMotions: any[] = []
let governanceCandidates: any[] = []
let governanceBallots: any[] = []
let governancePosts: any[] = []

/**
 * Shared test fixture for HexField E2E tests.
 *
 * Modes:
 *   browser — headless Chromium + mocked Tauri IPC. No Rust needed. Fast.
 *   tauri   — socket bridge to real Tauri WebView. Requires app running:
 *               cargo tauri dev --features e2e-testing
 *   cdp     — CDP to WebView2 (Windows only). Requires:
 *               $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9222"
 *               cargo tauri dev --features e2e-testing
 */
export const { test, expect } = createTauriTest({
  devUrl: 'http://localhost:1420',

  // -------------------------------------------------------------------
  // Variables injected into the browser IIFE as `var` declarations so
  // that mock handlers (serialized via .toString()) can reference them.
  // -------------------------------------------------------------------
  ipcContext: {
    governanceMotions:    [] as any[],
    governanceCandidates: [] as any[],
    governanceBallots:    [] as any[],
    governancePosts:      [] as any[],
  },

  // -------------------------------------------------------------------
  // Browser-mode IPC mocks — simulate a fresh install (no saved state).
  // All DB reads return null / []; writes are no-ops.
  // -------------------------------------------------------------------
  ipcMocks: {
    // Key-value store (identity, settings)
    db_load_key: () => null,
    db_save_key: () => undefined,

    // Servers
    db_load_servers: () => [{
      id: E2E_SERVER.id,
      name: E2E_SERVER.name,
      description: null,
      icon_url: null,
      owner_id: E2E_SERVER.ownerId,
      invite_code: null,
      created_at: E2E_SERVER.createdAt,
      raw_json: JSON.stringify(E2E_SERVER),
    }],
    db_save_server: () => undefined,
    db_delete_server: () => undefined,

    // Members
    db_upsert_member: () => undefined,
    db_load_members: () => [],

    // Channels
    db_load_channels: (args: any) => args?.serverId === E2E_SERVER.id ? [E2E_CHANNEL_ROW] : [],
    db_save_channel: () => undefined,
    db_delete_channel: () => undefined,

    // Messages
    db_load_messages: () => [],
    db_save_message: () => undefined,

    // Mutations (edits / deletes / reactions)
    db_load_mutations: () => [],
    db_save_mutation: () => undefined,

    // Governance motions
    db_load_governance_motions: (args: any) =>
      governanceMotions.filter((m: any) => m.server_id === args?.serverId),
    db_save_governance_motion: (args: any) => {
      const motion = args?.motion
      const idx = governanceMotions.findIndex((m: any) => m.id === motion.id)
      if (idx >= 0) governanceMotions[idx] = motion
      else governanceMotions.push(motion)
      return undefined
    },
    db_tally_governance_motion: () => ({ passed: true, fail_reason: null }),

    db_load_governance_candidates: (args: any) =>
      governanceCandidates.filter((c: any) => c.motion_id === args?.motionId),
    db_save_governance_candidate: (args: any) => {
      const candidate = args?.candidate
      const idx = governanceCandidates.findIndex(
        (c: any) => c.motion_id === candidate.motion_id && c.candidate_user_id === candidate.candidate_user_id
      )
      if (idx >= 0) governanceCandidates[idx] = candidate
      else governanceCandidates.push(candidate)
      return undefined
    },

    db_load_governance_ballots: (args: any) =>
      governanceBallots.filter((b: any) => b.motion_id === args?.motionId),
    db_save_governance_ballot: (args: any) => {
      const ballot = args?.ballot
      const idx = governanceBallots.findIndex(
        (b: any) => b.motion_id === ballot.motion_id && b.voter_user_id === ballot.voter_user_id
      )
      if (idx >= 0) governanceBallots[idx] = ballot
      else governanceBallots.push(ballot)
      return undefined
    },

    db_load_governance_posts: (args: any) =>
      governancePosts.filter((p: any) => p.motion_id === args?.motionId),
    db_save_governance_post: (args: any) => {
      const post = args?.post
      const idx = governancePosts.findIndex((p: any) => p.id === post.id)
      if (idx >= 0) governancePosts[idx] = post
      else governancePosts.push(post)
      return undefined
    },

    // Moderation
    db_load_bans: () => [],
    db_save_ban: () => undefined,
    db_get_join_requests: () => [],
    db_load_mod_log: () => [],
    db_save_mod_log_entry: () => undefined,

    // Invite codes
    db_create_invite_code: () => 'MOCK-INVITE',
    db_load_invite_codes: () => [],
    db_use_invite_code: () => null,

    // Keychain (OS secret store)
    keychain_load: () => null,
    keychain_save: () => undefined,

    // LAN discovery + WebRTC (non-fatal when they fail)
    lan_start: () => undefined,
    lan_stop: () => undefined,
    lan_get_connected_peers: () => [],

    // UPnP port forwarding (non-fatal when unavailable)
    upnp_forward_port: () => { throw new Error('UPnP unavailable in test') },
    upnp_remove_mapping: () => undefined,
    get_public_endpoint: () => null,
    set_public_ip: () => undefined,

    // Sync / attachment stubs
    db_load_sync_checkpoint: () => null,
    db_save_sync_checkpoint: () => undefined,
    db_load_attachment_meta: () => null,
    db_save_attachment_meta: () => undefined,
  },

  // Features to enable when auto-starting the Tauri app in `tauri` mode.
  tauriFeatures: ['e2e-testing'],
})
