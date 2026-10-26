//! Thin bindings for the daemon's shared Wayland authorization.

use deskfleet_native::desktop_access;
use napi::Result;
use napi_derive::napi;

use crate::rtc::native_error;

#[napi(object)]
pub struct WaylandDesktopAccess {
    pub screen_capture: bool,
    pub control: bool,
}

impl From<desktop_access::DesktopAccess> for WaylandDesktopAccess {
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

/// Authorize screen and input together, persisting restoration under the daemon directory.
#[napi]
pub async fn request_wayland_desktop_access(directory: String) -> Result<WaylandDesktopAccess> {
    desktop_access::request_wayland(directory)
        .await
        .map(Into::into)
        .map_err(native_error)
}

/// Read the current Wayland authorization without prompting.
#[napi]
pub async fn check_wayland_desktop_access() -> WaylandDesktopAccess {
    desktop_access::check_wayland().into()
}

/// Wait until the shared Wayland grant changes. `None` means the runtime stopped.
#[napi]
pub async fn wait_wayland_desktop_access_change(seen: u32) -> Option<u32> {
    desktop_access::wait_wayland(seen).await
}

/// Cancel pending authorization and close shared Wayland resources on daemon shutdown.
#[napi]
pub async fn close_wayland_desktop_access() -> Result<()> {
    desktop_access::close_wayland().await.map_err(native_error)
}
