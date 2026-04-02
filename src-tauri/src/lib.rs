use std::sync::{Arc, Mutex};
use tauri::Manager;

mod db;
mod commands;

use commands::db_commands::*;
use commands::signal_commands::*;
use commands::sync_commands::*;

pub struct AppState {
    pub db: Mutex<rusqlite::Connection>,
    pub signal_tx: Arc<Mutex<Option<tokio::sync::mpsc::Sender<serde_json::Value>>>>,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(
            tauri_plugin_log::Builder::new()
                .targets([
                    tauri_plugin_log::Target::new(
                        tauri_plugin_log::TargetKind::LogDir { file_name: Some("gamechat".into()) }
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
            // System
            get_app_data_path,
            // Signaling
            signal_connect,
            signal_disconnect,
            signal_send,
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
        .expect("error while running GameChat");
}
