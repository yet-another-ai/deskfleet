//! Thin system permission adapters for the calling daemon or desktop client.

use deskfleet_native::{
    filesystem_permissions,
    input::{self, AccessibilityAccess as InputAccessibilityAccess},
    local_network, media, notification_permissions,
};
use napi::Result;
use napi_derive::napi;

use crate::rtc::native_error;

#[napi(string_enum = "kebab-case")]
pub enum NotificationPermission {
    Default,
    Granted,
    Denied,
    Unsupported,
}

fn map_notification_permission(
    permission: notification_permissions::NotificationPermission,
) -> NotificationPermission {
    match permission {
        notification_permissions::NotificationPermission::Default => {
            NotificationPermission::Default
        }
        notification_permissions::NotificationPermission::Granted => {
            NotificationPermission::Granted
        }
        notification_permissions::NotificationPermission::Denied => NotificationPermission::Denied,
        notification_permissions::NotificationPermission::Unsupported => {
            NotificationPermission::Unsupported
        }
    }
}

/// Check system notification authorization without prompting; null elsewhere.
#[napi]
pub async fn check_notification_access() -> Result<Option<NotificationPermission>> {
    Ok(notification_permissions::check_notification_access()
        .await
        .map_err(native_error)?
        .map(map_notification_permission))
}

/// Request system notification authorization in the calling process; null elsewhere.
#[napi]
pub async fn request_notification_access() -> Result<Option<NotificationPermission>> {
    Ok(notification_permissions::request_notification_access()
        .await
        .map_err(native_error)?
        .map(map_notification_permission))
}

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

#[napi(string_enum = "kebab-case")]
pub enum AccessibilityAccess {
    Granted,
    Denied,
    /// Accessibility is granted, but this process needs a restart to post events.
    RestartRequired,
}

fn map_accessibility_access(access: InputAccessibilityAccess) -> AccessibilityAccess {
    match access {
        InputAccessibilityAccess::Granted => AccessibilityAccess::Granted,
        InputAccessibilityAccess::Denied => AccessibilityAccess::Denied,
        InputAccessibilityAccess::RestartRequired => AccessibilityAccess::RestartRequired,
    }
}

/// Check Accessibility access without prompting or initializing input.
/// Resolves with null on platforms without an upfront permission request.
#[napi]
pub async fn check_accessibility_access() -> Result<Option<AccessibilityAccess>> {
    Ok(input::check_accessibility_access()
        .await
        .map_err(native_error)?
        .map(map_accessibility_access))
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
pub async fn request_accessibility_access() -> Result<Option<AccessibilityAccess>> {
    Ok(input::request_accessibility_access()
        .await
        .map_err(native_error)?
        .map(map_accessibility_access))
}
