//! Daemon-owned desktop access. Authorization and media have separate lifetimes.

/// Granted capabilities of the current Wayland portal session.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct DesktopAccess {
    pub screen_capture: bool,
    pub control: bool,
}

/// Discover a usable desktop backend without requesting OS authorization.
pub async fn supported() -> Result<bool, String> {
    #[cfg(target_os = "linux")]
    {
        if !deskfleet_wayland::supported()
            .await
            .map_err(|error| error.to_string())?
        {
            return Ok(false);
        }
        tokio::task::spawn_blocking(deskfleet_linux_media::is_available)
            .await
            .map_err(|error| error.to_string())
    }
    #[cfg(not(target_os = "linux"))]
    {
        Ok(cfg!(any(target_os = "macos", target_os = "windows")))
    }
}

/// Request combined screen and input access once, retaining the portal session.
/// The token is stored locally under the daemon's private directory.
pub async fn request_wayland(directory: String) -> Result<DesktopAccess, String> {
    #[cfg(target_os = "linux")]
    {
        let access = match deskfleet_wayland::request_access(directory.into()).await {
            Ok(access) => access,
            Err(
                deskfleet_wayland::Error::Cancelled | deskfleet_wayland::Error::PermissionDenied,
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
    #[cfg(not(target_os = "linux"))]
    {
        let _ = directory;
        Ok(DesktopAccess::default())
    }
}

/// Inspect existing access without prompting or starting a media consumer.
pub fn check_wayland() -> DesktopAccess {
    #[cfg(target_os = "linux")]
    {
        let access = deskfleet_wayland::check_access();
        DesktopAccess {
            screen_capture: access.screen_capture,
            control: access.control,
        }
    }
    #[cfg(not(target_os = "linux"))]
    {
        DesktopAccess::default()
    }
}

/// Wait until the shared Wayland grant changes. `None` means the runtime stopped.
pub async fn wait_wayland(seen: u32) -> Option<u32> {
    #[cfg(target_os = "linux")]
    {
        deskfleet_wayland::wait_for_access_change(seen).await
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = seen;
        std::future::pending().await
    }
}

/// Cancel pending authorization and release the daemon's live portal resources.
pub async fn close_wayland() -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        deskfleet_wayland::shutdown()
            .await
            .map_err(|error| error.to_string())
    }
    #[cfg(not(target_os = "linux"))]
    {
        Ok(())
    }
}
