//! Daemon-owned Linux desktop access, independent of viewer lifetimes.

#[cfg(target_os = "linux")]
use deskfleet_linux_desktop::{Backend, backend};

/// Capture and input access in the selected Linux graphical session.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct DesktopAccess {
    pub screen_capture: bool,
    pub control: bool,
}

/// Identify the process's Linux session without connecting or requesting access.
#[must_use]
pub fn linux_backend() -> Option<&'static str> {
    #[cfg(target_os = "linux")]
    {
        backend().as_str()
    }
    #[cfg(not(target_os = "linux"))]
    {
        None
    }
}

/// Discover capture and hardware encoding without requesting OS authorization.
pub async fn supported() -> Result<bool, String> {
    #[cfg(target_os = "linux")]
    {
        let selected = backend();
        if selected == Backend::Unavailable {
            return Ok(false);
        }
        if selected == Backend::Wayland
            && !deskfleet_wayland::supported()
                .await
                .map_err(|error| error.to_string())?
        {
            return Ok(false);
        }
        tokio::task::spawn_blocking(move || {
            let capture = match selected {
                Backend::Wayland => deskfleet_linux_media::capture_available(),
                Backend::X11 => deskfleet_x11::probe().is_ok_and(|access| access.screen_capture),
                Backend::Unavailable => false,
            };
            capture && deskfleet_linux_media::encoding_available()
        })
        .await
        .map_err(|error| error.to_string())
    }
    #[cfg(not(target_os = "linux"))]
    {
        Ok(cfg!(any(target_os = "macos", target_os = "windows")))
    }
}

/// Request a shared Wayland grant or check X11 access without a Portal dialog.
/// Only Wayland persists a restoration token under the daemon directory.
pub async fn request_linux(directory: String) -> Result<DesktopAccess, String> {
    #[cfg(target_os = "linux")]
    {
        match backend() {
            Backend::Wayland => {
                let access = match deskfleet_wayland::request_access(directory.into()).await {
                    Ok(access) => access,
                    Err(
                        deskfleet_wayland::Error::Cancelled
                        | deskfleet_wayland::Error::PermissionDenied,
                    ) => {
                        return Ok(DesktopAccess::default());
                    }
                    Err(error) => return Err(error.to_string()),
                };
                Ok(DesktopAccess {
                    screen_capture: access.screen_capture,
                    control: access.control,
                })
            }
            Backend::X11 | Backend::Unavailable => check_linux().await,
        }
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = directory;
        Ok(DesktopAccess::default())
    }
}

/// Inspect existing access without prompting or starting a media consumer.
pub async fn check_linux() -> Result<DesktopAccess, String> {
    #[cfg(target_os = "linux")]
    {
        match backend() {
            Backend::Wayland => {
                let access = deskfleet_wayland::check_access();
                Ok(DesktopAccess {
                    screen_capture: access.screen_capture,
                    control: access.control,
                })
            }
            Backend::X11 => tokio::task::spawn_blocking(|| {
                let access = deskfleet_x11::probe().map_err(|error| error.to_string())?;
                Ok(DesktopAccess {
                    screen_capture: access.screen_capture,
                    control: access.control,
                })
            })
            .await
            .map_err(|error| error.to_string())?,
            Backend::Unavailable => Err("no Linux graphical session is available".into()),
        }
    }
    #[cfg(not(target_os = "linux"))]
    {
        Ok(DesktopAccess::default())
    }
}

/// Wait for shared authorization changes. X11 has no retained Portal grant.
pub async fn wait_linux(seen: u32) -> Option<u32> {
    #[cfg(target_os = "linux")]
    if backend() == Backend::Wayland {
        return deskfleet_wayland::wait_for_access_change(seen).await;
    }
    let _ = seen;
    None
}

/// Cancel pending authorization and close daemon-owned Portal resources.
/// X11 connections are scoped to their capture/input workers instead.
pub async fn close_linux() -> Result<(), String> {
    #[cfg(target_os = "linux")]
    if backend() == Backend::Wayland {
        return deskfleet_wayland::shutdown()
            .await
            .map_err(|error| error.to_string());
    }
    Ok(())
}
