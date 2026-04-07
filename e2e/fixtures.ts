import { createTauriTest } from '@srsholmes/tauri-playwright'

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
  // Browser-mode IPC mocks — simulate a fresh install (no saved state).
  // All DB reads return null / []; writes are no-ops.
  // -------------------------------------------------------------------
  ipcMocks: {
    // Key-value store (identity, settings)
    db_load_key: () => null,
    db_save_key: () => undefined,

    // Servers
    db_load_servers: () => [],
    db_save_server: () => undefined,
    db_delete_server: () => undefined,

    // Members
    db_upsert_member: () => undefined,
    db_load_members: () => [],

    // Channels
    db_load_channels: () => [],
    db_save_channel: () => undefined,
    db_delete_channel: () => undefined,

    // Messages
    db_load_messages: () => [],
    db_save_message: () => undefined,

    // Mutations (edits / deletes / reactions)
    db_load_mutations: () => [],
    db_save_mutation: () => undefined,

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

    // Sync / attachment stubs
    db_load_sync_checkpoint: () => null,
    db_save_sync_checkpoint: () => undefined,
    db_load_attachment_meta: () => null,
    db_save_attachment_meta: () => undefined,
  },

  // Features to enable when auto-starting the Tauri app in `tauri` mode.
  tauriFeatures: ['e2e-testing'],
})
