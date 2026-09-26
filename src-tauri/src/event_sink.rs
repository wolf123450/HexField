//! EventSink — where the networking layer (`webrtc_manager`, `lan`) sends its events.
//!
//! In the app the sink is the Tauri `AppHandle`, so events reach the frontend
//! exactly as before. The headless `hexfield-netprobe` binary uses a channel
//! sink instead, which lets it drive the same networking code without a WebView.
//!
//! `tauri::Emitter` is sealed, so this is a small object-safe trait of our own.
//! The generic `emit` helper lives on `dyn EventSink` to keep the trait object-safe.

use std::sync::Arc;

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc::UnboundedSender;

pub trait EventSink: Send + Sync {
    fn emit_value(&self, event: &str, payload: Value) -> Result<(), String>;

    /// The Tauri handle when running inside the app. Media playback needs it;
    /// headless sinks return `None` and remote media is ignored.
    fn app_handle(&self) -> Option<AppHandle> {
        None
    }
}

pub type SharedSink = Arc<dyn EventSink>;

impl dyn EventSink {
    pub fn emit<T: Serialize>(&self, event: &str, payload: T) -> Result<(), String> {
        let value = serde_json::to_value(payload).map_err(|e| e.to_string())?;
        self.emit_value(event, value)
    }
}

impl EventSink for AppHandle {
    fn emit_value(&self, event: &str, payload: Value) -> Result<(), String> {
        Emitter::emit(self, event, payload).map_err(|e| e.to_string())
    }

    fn app_handle(&self) -> Option<AppHandle> {
        Some(self.clone())
    }
}

/// Channel sink for headless use: every event becomes `(name, payload)`.
impl EventSink for UnboundedSender<(String, Value)> {
    fn emit_value(&self, event: &str, payload: Value) -> Result<(), String> {
        self.send((event.to_string(), payload))
            .map_err(|_| format!("event channel closed ({event})"))
    }
}

pub fn from_app(app: &AppHandle) -> SharedSink {
    Arc::new(app.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Payload {
        user_id: String,
    }

    #[test]
    fn channel_sink_serializes_payload() {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let sink: SharedSink = Arc::new(tx);
        sink.emit("webrtc_connected", Payload { user_id: "u1".into() })
            .unwrap();
        let (name, value) = rx.try_recv().unwrap();
        assert_eq!(name, "webrtc_connected");
        assert_eq!(value, serde_json::json!({ "userId": "u1" }));
        assert!(sink.app_handle().is_none());
    }

    #[test]
    fn channel_sink_reports_closed_channel() {
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        drop(rx);
        let sink: SharedSink = Arc::new(tx);
        assert!(sink.emit("x", 1).is_err());
    }
}
