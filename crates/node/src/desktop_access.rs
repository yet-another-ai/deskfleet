//! Thin bindings for the daemon's Linux desktop access.

use deskfleet_native::desktop_access;
use napi::Result;
use napi_derive::napi;

use crate::rtc::native_error;

#[napi(object)]
pub struct LinuxDesktopAccess {
    pub screen_capture: bool,
    pub control: bool,
}

impl From<desktop_access::DesktopAccess> for LinuxDesktopAccess {
    fn from(access: desktop_access::DesktopAccess) -> Self {
        Self {
            screen_capture: access.screen_capture,
            control: access.control,
        }
    }
}

/// Probe native desktop support without opening an authorization dialog.
#[napi]
pub async fn desktop_supported() -> Result<bool> {
    desktop_access::supported().await.map_err(native_error)
}

/// Identify the selected Linux session without connecting or prompting.
#[napi(ts_return_type = "'wayland' | 'x11' | null")]
pub fn linux_desktop_backend() -> Option<String> {
    desktop_access::linux_backend().map(str::to_owned)
}

/// Request Linux desktop access; only Wayland opens a Portal authorization dialog.
#[napi]
pub async fn request_linux_desktop_access(directory: String) -> Result<LinuxDesktopAccess> {
    desktop_access::request_linux(directory)
        .await
        .map(Into::into)
        .map_err(native_error)
}

/// Check Linux desktop access without prompting or starting capture.
#[napi]
pub async fn check_linux_desktop_access() -> Result<LinuxDesktopAccess> {
    desktop_access::check_linux()
        .await
        .map(Into::into)
        .map_err(native_error)
}

/// Wait for Linux authorization changes; X11 has no retained Portal grant.
#[napi]
pub async fn wait_linux_desktop_access_change(seen: u32) -> Option<u32> {
    desktop_access::wait_linux(seen).await
}

/// Cancel pending Linux authorization and close shared resources on daemon shutdown.
#[napi]
pub async fn close_linux_desktop_access() -> Result<()> {
    desktop_access::close_linux().await.map_err(native_error)
}
