#[cfg(not(mobile))]
use std::collections::HashMap;
#[cfg(not(mobile))]
use std::sync::atomic::AtomicU16;
use std::sync::{Arc, Mutex};
use tauri::Manager;

mod db;
mod commands;
#[cfg(not(mobile))]
mod lan;

use commands::archive_commands::*;
use commands::attachment_commands::*;
use commands::db_commands::*;
use commands::keychain_commands::*;
use commands::signal_commands::*;
use commands::sync_commands::*;

pub struct AppState {
    pub db: Mutex<rusqlite::Connection>,
    /// Sender to the rendezvous-server WS actor.
    pub signal_tx: Arc<Mutex<Option<tokio::sync::mpsc::Sender<serde_json::Value>>>>,
    /// Direct LAN WS senders: `userId → UnboundedSender`. Desktop only.
    #[cfg(not(mobile))]
    pub lan_peers: Arc<lan::LanPeers>,
    /// Port our local LAN signal server is listening on (0 = not started). Desktop only.
    #[cfg(not(mobile))]
    pub lan_signal_port: Arc<AtomicU16>,
    /// Local userId, set when `lan_start` is called. Desktop only.
    #[cfg(not(mobile))]
    pub local_user_id: Arc<Mutex<String>>,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(
            tauri_plugin_log::Builder::new()
                .targets([
                    tauri_plugin_log::Target::new(
                        tauri_plugin_log::TargetKind::LogDir { file_name: Some("hexfield".into()) }
                    ),
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Webview),
                ])
                .level(log::LevelFilter::Info)
                .build(),
        )
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_deep_link::init())
        .setup(|app| {
            let app_dir = app.path().app_data_dir().expect("Failed to get app data dir");
            let conn = db::open(app_dir);
            app.manage(AppState {
                db: Mutex::new(conn),
                signal_tx: Arc::new(Mutex::new(None)),
                #[cfg(not(mobile))]
                lan_peers: Arc::new(tokio::sync::Mutex::new(HashMap::new())),
                #[cfg(not(mobile))]
                lan_signal_port: Arc::new(AtomicU16::new(0)),
                #[cfg(not(mobile))]
                local_user_id: Arc::new(Mutex::new(String::new())),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // Messages
            db_load_messages,
            db_save_message,
            // Mutations
            db_save_mutation,
            db_load_mutations,
            // Servers & channels
            db_load_servers,
            db_save_server,
            db_load_channels,
            db_save_channel,
            // Keys
            db_save_key,
            db_load_key,
            // Members
            db_load_members,
            db_upsert_member,
            // Emoji
            db_load_emoji,
            db_save_emoji,
            get_emoji_image,
            store_emoji_image,
            // Devices
            db_load_devices,
            db_save_device,
            db_revoke_device,
            // Channel management
            db_delete_channel,
            // Invite codes
            db_save_invite_code,
            db_load_invite_codes,
            db_increment_invite_use_count,
            db_delete_invite_code,
            // Moderation audit log
            db_save_mod_log_entry,
            db_load_mod_log,
            // Bans
            db_save_ban,
            db_load_bans,
            db_delete_ban,
            db_is_banned,
            // Channel ACLs
            db_load_channel_acls,
            db_upsert_channel_acl,
            // Join requests (Phase H)
            db_save_join_request,
            db_load_join_requests,
            db_update_join_request_status,
            // Attachments (Phase 5b)
            get_attachment_path,
            has_attachment,
            get_chunk_count,
            save_attachment,
            save_attachment_chunk,
            read_attachment_chunk,
            get_received_chunks,
            blake3_hash,
            delete_attachment,
            prune_attachments,
            get_attachment_storage_bytes,
            enforce_storage_limit,
            // OS Keychain
            keychain_save,
            keychain_load,
            keychain_delete,
            // Archive
            db_export_archive,
            db_import_archive,
            db_save_rebaseline,
            // System
            get_app_data_path,
            get_screen_sources,
            open_devtools,
            // Maintenance
            db_prune_expired_bans,
            db_prune_mod_log,
            db_search_messages,
            db_load_messages_around,
            db_load_messages_after,
            // Signaling
            signal_connect,
            signal_disconnect,
            signal_send,
            // LAN discovery & direct signaling (desktop only)
            #[cfg(not(mobile))]
            lan_start,
            #[cfg(not(mobile))]
            lan_connect_peer,
            #[cfg(not(mobile))]
            lan_get_local_addrs,
            #[cfg(not(mobile))]
            lan_get_connected_peers,
            // Sync (negentropy set reconciliation)
            sync_initiate,
            sync_respond,
            sync_process_response,
            sync_get_messages,
            sync_get_mutations,
            sync_save_messages,
            sync_save_mutations,
            sync_list_channels,
        ])
        .run(tauri::generate_context!())
        .expect("error while running HexField");
}
