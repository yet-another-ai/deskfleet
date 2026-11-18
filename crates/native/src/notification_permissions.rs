//! Notification permission queries and prompts for the calling desktop process.

use std::io;

#[cfg(target_os = "macos")]
mod macos;

/// Authorization state of system notifications for the calling process.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NotificationPermission {
    /// The user has not been asked for notification permission yet.
    Default,
    /// Notifications are allowed.
    Granted,
    /// Notifications are blocked in system settings.
    Denied,
    /// System notifications are unavailable in this process context.
    Unsupported,
}

#[derive(Debug, thiserror::Error)]
pub enum NotificationPermissionError {
    #[error("notification permission worker failed: {0}")]
    Worker(#[from] tokio::task::JoinError),
    #[error("cannot open Notifications settings: {0}")]
    OpenSettings(#[source] io::Error),
}

/// Check this process's system notification authorization without prompting.
///
/// Returns `None` on platforms without an upfront notification permission prompt.
///
/// # Errors
/// Returns an error if the blocking worker fails to complete.
pub async fn check_notification_access()
-> Result<Option<NotificationPermission>, NotificationPermissionError> {
    #[cfg(target_os = "macos")]
    {
        Ok(Some(tokio::task::spawn_blocking(macos::check).await?))
    }
    #[cfg(not(target_os = "macos"))]
    {
        Ok(None)
    }
}

/// Request system notification authorization for this process, opening macOS
/// Notifications settings when authorization is already denied or cannot prompt.
///
/// Returns `None` on platforms without an upfront notification permission prompt.
///
/// # Errors
/// Returns an error if the blocking worker or System Settings fails.
pub async fn request_notification_access()
-> Result<Option<NotificationPermission>, NotificationPermissionError> {
    #[cfg(target_os = "macos")]
    {
        Ok(Some(
            tokio::task::spawn_blocking(|| {
                let previous = macos::check();
                let current = if previous == NotificationPermission::Denied {
                    previous
                } else {
                    macos::request()
                };
                if current != NotificationPermission::Granted {
                    crate::permission_settings::open_url(
                        "x-apple.systempreferences:com.apple.Notifications-Settings.extension",
                    )
                    .map_err(NotificationPermissionError::OpenSettings)?;
                }
                Ok::<_, NotificationPermissionError>(current)
            })
            .await??,
        ))
    }
    #[cfg(not(target_os = "macos"))]
    {
        Ok(None)
    }
}
