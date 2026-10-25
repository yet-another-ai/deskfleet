//! Desktop permissions requested together when the daemon starts.

use deskfleet_native::{input, media};
use napi::Result;
use napi_derive::napi;

use crate::rtc::native_error;

/// Request this process's screen/system-audio access without starting capture.
/// Resolves with null on platforms without an upfront permission request.
#[napi]
pub async fn request_screen_capture_access() -> Result<Option<bool>> {
    media::request_screen_capture_access()
        .await
        .map_err(native_error)
}

/// Request this process's Accessibility access without initializing input.
/// Resolves with null on platforms without an upfront permission request.
#[napi]
pub async fn request_accessibility_access() -> Result<Option<bool>> {
    input::request_accessibility_access()
        .await
        .map_err(native_error)
}
