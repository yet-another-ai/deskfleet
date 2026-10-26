use crate::CaptureError;
use crate::types::Display;

#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
mod stub;

#[cfg(target_os = "linux")]
pub(crate) use crate::linux::LinuxStream as PlatformStream;

#[cfg(target_os = "macos")]
pub use crate::macos::MacOSStream as PlatformStream;

#[cfg(target_os = "windows")]
pub(crate) use crate::windows::WindowsStream as PlatformStream;

#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
pub(crate) use stub::StubStream as PlatformStream;

#[cfg(target_os = "linux")]
pub(crate) fn platform_displays() -> Result<Vec<Display>, CaptureError> {
    crate::linux::displays()
}

#[cfg(target_os = "macos")]
pub fn platform_displays() -> Result<Vec<Display>, CaptureError> {
    crate::macos::displays()
}

#[cfg(target_os = "windows")]
pub(crate) fn platform_displays() -> Result<Vec<Display>, CaptureError> {
    crate::windows::displays()
}

#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
pub(crate) fn platform_displays() -> Result<Vec<Display>, CaptureError> {
    Err(CaptureError::Unsupported(
        "no capture backend for this platform",
    ))
}
