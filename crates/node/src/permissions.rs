//! Thin system permission adapters for the calling daemon or desktop client.

use deskfleet_native::{filesystem_permissions, input, local_network, media};
use napi::Result;
use napi_derive::napi;

use crate::rtc::native_error;

#[napi(string_enum = "kebab-case")]
pub enum LocalNetworkAccessRequest {
    Attempted,
    Unavailable,
    NotRequired,
}

/// Try to trigger macOS local-network consent; never reports a permission grant.
#[napi]
pub async fn request_local_network_access() -> Result<LocalNetworkAccessRequest> {
    Ok(
        match local_network::request_local_network_access()
            .await
            .map_err(native_error)?
        {
            local_network::LocalNetworkAccessRequest::Attempted => {
                LocalNetworkAccessRequest::Attempted
            }
            local_network::LocalNetworkAccessRequest::Unavailable => {
                LocalNetworkAccessRequest::Unavailable
            }
            local_network::LocalNetworkAccessRequest::NotRequired => {
                LocalNetworkAccessRequest::NotRequired
            }
        },
    )
}

/// Open macOS Local Network settings for the calling app; a no-op elsewhere.
#[napi]
pub async fn open_local_network_settings() -> Result<()> {
    local_network::open_local_network_settings()
        .await
        .map_err(native_error)
}

/// Check this process's Full Disk Access without opening macOS settings.
/// Resolves with null on platforms without an upfront permission request.
#[napi]
pub async fn check_full_disk_access() -> Result<Option<bool>> {
    filesystem_permissions::check_full_disk_access()
        .await
        .map_err(native_error)
}

/// Check screen/system-audio access without prompting or starting capture.
/// Resolves with null on platforms without an upfront permission request.
#[napi]
pub async fn check_screen_capture_access() -> Result<Option<bool>> {
    media::check_screen_capture_access()
        .await
        .map_err(native_error)
}

/// Check Accessibility access without prompting or initializing input.
/// Resolves with null on platforms without an upfront permission request.
#[napi]
pub async fn check_accessibility_access() -> Result<Option<bool>> {
    input::check_accessibility_access()
        .await
        .map_err(native_error)
}

/// Check this process's Full Disk Access and open macOS settings when denied.
/// Resolves with false while user authorization is required, or null elsewhere.
#[napi]
pub async fn request_full_disk_access() -> Result<Option<bool>> {
    filesystem_permissions::request_full_disk_access()
        .await
        .map_err(native_error)
}

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
