//! Platform-native GPU surface handle.

#[cfg(target_os = "macos")]
pub(crate) mod macos;

#[cfg(target_os = "windows")]
pub(crate) mod windows;

#[cfg(target_os = "linux")]
pub(crate) mod linux;

#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
mod stub;

#[cfg(target_os = "macos")]
use macos as platform;

#[cfg(target_os = "windows")]
use self::windows as platform;

#[cfg(target_os = "linux")]
use self::linux as platform;

#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
use stub as platform;

use std::ffi::c_void;
use std::fmt;

use crate::CaptureError;

/// Owned native frame storage: GPU surfaces on macOS/Windows, BGRA on Linux.
pub struct NativeSurface {
    pub(crate) inner: platform::PlatformInner,
}

// SAFETY: The underlying platform handles are reference-counted / thread-safe.
// IOSurface on macOS, COM pointers on Windows. Windows contexts enable
// ID3D11Multithread protection before they are shared.
// Linux retains an owned Vec<u8> after releasing the PipeWire sample.
#[allow(unsafe_code, clippy::non_send_fields_in_send_ty)]
unsafe impl Send for NativeSurface {}
// SAFETY: Surface readback locks IOSurface or uses the protected D3D11 context;
// callers receive shared handles, while the wrapper retains the allocation.
// Linux pixels are immutable when accessed through this wrapper.
#[allow(unsafe_code, clippy::non_send_fields_in_send_ty)]
unsafe impl Sync for NativeSurface {}

impl NativeSurface {
    /// Borrow the Linux frame's tightly packed BGRA pixels without another copy.
    #[cfg(target_os = "linux")]
    #[must_use]
    pub fn bgra_pixels(&self) -> &[u8] {
        &self.inner
    }
    /// Returns a raw pointer to the underlying platform surface.
    #[must_use]
    pub fn as_raw_ptr(&self) -> *const c_void {
        platform::as_raw_ptr(&self.inner)
    }

    /// Copy the surface pixel data into CPU-accessible memory.
    pub fn copy_pixels(&self) -> Result<Vec<u8>, CaptureError> {
        platform::copy_pixels(&self.inner)
    }
}

impl fmt::Debug for NativeSurface {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("NativeSurface")
            .field("ptr", &self.as_raw_ptr())
            .finish()
    }
}

#[cfg(target_os = "macos")]
mod macos_ext;

#[cfg(target_os = "windows")]
mod windows_ext;
