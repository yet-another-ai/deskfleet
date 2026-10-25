use crate::types::Codec;

#[cfg(target_os = "macos")]
mod macos;

#[cfg(target_os = "windows")]
mod windows;

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
mod stub;

#[cfg(target_os = "macos")]
pub use macos::PlatformEncoder;

#[cfg(target_os = "windows")]
pub use windows::PlatformEncoder;

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub(crate) use stub::PlatformEncoder;

#[cfg(target_os = "macos")]
pub fn platform_supported_codecs() -> Vec<Codec> {
    crate::macos::probe_supported_codecs()
}

#[cfg(target_os = "windows")]
pub fn platform_supported_codecs() -> Vec<Codec> {
    windows::supported_codecs()
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub(crate) fn platform_supported_codecs() -> Vec<Codec> {
    Vec::new()
}
