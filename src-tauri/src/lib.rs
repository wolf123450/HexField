#[cfg(not(mobile))]
use std::collections::HashMap;
#[cfg(not(mobile))]
use std::sync::atomic::AtomicU16;
use std::sync::{Arc, Mutex};
use tauri::Manager;
use tauri::image::Image;

mod db;
mod commands;
mod capture;
#[cfg(not(mobile))]
mod lan;
#[cfg(not(mobile))]
mod upnp;
mod media_manager;
mod webrtc_manager;

use commands::archive_commands::*;
use commands::attachment_commands::*;
use commands::db_commands::*;
use commands::keychain_commands::*;
use commands::media_commands::*;
use commands::signal_commands::*;
use commands::sync_commands::*;
use commands::webrtc_commands::*;

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
    /// Rust-native WebRTC peer connections (data channels; Phase 1).
    pub webrtc_manager: Arc<webrtc_manager::WebRTCManager>,
    /// Rust-native audio capture, playback, and media tracks.
    pub media_manager: Arc<media_manager::MediaManager>,
    /// External port from UPnP mapping (0 = no mapping). Desktop only.
    #[cfg(not(mobile))]
    pub upnp_external_port: Arc<AtomicU16>,
    /// Public IP discovered via STUN or UPnP gateway. Desktop only.
    #[cfg(not(mobile))]
    pub public_ip: Arc<Mutex<Option<String>>>,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Both webrtc/dtls (ring) and reqwest/hyper-rustls (aws-lc-rs) pull in rustls with
    // different crypto-provider features.  Install ring as the process-level provider
    // before anything starts so rustls doesn't panic with "ambiguous CryptoProvider".
    let _ = rustls::crypto::ring::default_provider().install_default();

    // `mut` is required when building on Linux (tauri-pilot plugin), unused on other platforms.
    #[allow(unused_mut)]
    let mut builder = tauri::Builder::default()
        .plugin(
            tauri_plugin_log::Builder::new()
                .targets([
                    tauri_plugin_log::Target::new(
                        tauri_plugin_log::TargetKind::LogDir { file_name: Some("hexfield".into()) }
                    ),
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Webview),
                ])
                .level(std::env::var("HEXFIELD_LOG")
                    .ok()
                    .and_then(|v| v.parse::<log::LevelFilter>().ok())
                    .unwrap_or(log::LevelFilter::Info))
                .build(),
        )
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_notification::init());

    // tauri-plugin-deep-link: handles hexfield:// URL scheme for invite joins.
    // Skipped when HEXFIELD_MULTI_INSTANCE=1 so multiple named dev instances can
    // run simultaneously — the plugin creates a named pipe for single-instance
    // enforcement that causes any second instance to immediately exit.
    if std::env::var("HEXFIELD_MULTI_INSTANCE").as_deref() != Ok("1") {
        builder = builder.plugin(tauri_plugin_deep_link::init());
    }

    // tauri-pilot: interactive testing CLI for AI agents (Linux + debug builds only).
    // Not compiled on macOS/Windows (uses Unix sockets; cross-platform support planned upstream).
    #[cfg(all(debug_assertions, target_os = "linux"))]
    {
        builder = builder.plugin(tauri_plugin_pilot::init());
    }

    // tauri-plugin-playwright: E2E test bridge. Enable with `--features e2e-testing`.
    #[cfg(feature = "e2e-testing")]
    {
        builder = builder.plugin(tauri_plugin_playwright::init());
    }

    builder
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
                webrtc_manager: Arc::new(webrtc_manager::WebRTCManager::new()),
                media_manager: Arc::new(media_manager::MediaManager::new()),
                #[cfg(not(mobile))]
                upnp_external_port: Arc::new(AtomicU16::new(0)),
                #[cfg(not(mobile))]
                public_ip: Arc::new(Mutex::new(None)),
            });

            // Create the main window programmatically so we can set a per-instance
            // WebView2 data directory when HEXFIELD_DATA_DIR is set.  Without this,
            // a second instance on Windows fails with ERROR_INVALID_STATE because
            // WebView2 locks the user data folder exclusively.
            let mut win_builder = tauri::WebviewWindowBuilder::new(
                app,
                "main",
                tauri::WebviewUrl::App(std::path::PathBuf::from("index.html")),
            )
            .title("HexField")
            .inner_size(1280.0, 800.0)
            .min_inner_size(900.0, 600.0)
            .decorations(false);

            if let Ok(data_dir) = std::env::var("HEXFIELD_DATA_DIR") {
                if !data_dir.is_empty() {
                    win_builder = win_builder.data_directory(std::path::PathBuf::from(data_dir));
                }
            }

            let window = win_builder.build().expect("Failed to create main window");
            const ICON: Image<'_> = tauri::include_image!("./icons/icon.ico");
            let _ = window.set_icon(ICON);

            // Start polling for audio device changes (hot-plug detection)
            let state: tauri::State<AppState> = app.state();
            state.media_manager.start_device_watcher(app.handle().clone());

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
            get_emoji_image_path,
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
            save_image,
            get_image_info,
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
            migrate_data_urls_to_files,
            migrate_attachment_inline_data,
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
            // UPnP/NAT-PMP port forwarding (desktop only)
            #[cfg(not(mobile))]
            upnp_forward_port,
            #[cfg(not(mobile))]
            upnp_remove_mapping,
            #[cfg(not(mobile))]
            get_public_endpoint,
            #[cfg(not(mobile))]
            set_public_ip,
            // Sync (negentropy set reconciliation)
            sync_initiate,
            sync_respond,
            sync_process_response,
            sync_get_messages,
            sync_get_mutations,
            sync_save_messages,
            sync_save_mutations,
            sync_list_channels,
            // Media (Rust-native audio)
            media_enumerate_devices,
            media_start_mic,
            media_stop_mic,
            media_set_muted,
            media_set_deafened,
            media_set_peer_volume,
            media_set_loopback,
            media_set_input_device,
            media_set_output_device,
            // Media (screen share)
            media_enumerate_screens,
            media_screen_share_supported,
            media_start_screen_share,
            media_stop_screen_share,
            webrtc_set_peer_quality,
            // WebRTC (Rust-native data channels)
            webrtc_init,
            webrtc_create_offer,
            webrtc_handle_offer,
            webrtc_handle_answer,
            webrtc_add_ice,
            webrtc_send,
            webrtc_ensure_tracks,
            webrtc_close_peer,
            webrtc_destroy_all,
            webrtc_get_connected_peers,
        ])
        .run(tauri::generate_context!())
        .expect("error while running HexField");
}
