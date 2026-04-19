//! Stub screen capturer for platforms where screen sharing is not yet implemented.

use super::{CaptureConfig, ScreenCapturer, ScreenSourceList};

pub struct StubCapturer;

impl ScreenCapturer for StubCapturer {
    fn is_supported(&self) -> bool {
        false
    }

    fn enumerate(&self) -> Result<ScreenSourceList, String> {
        Err("Screen sharing is not yet supported on this platform".to_string())
    }

    fn start(&self, _config: CaptureConfig) -> Result<(), String> {
        Err("Screen sharing is not yet supported on this platform".to_string())
    }
}
