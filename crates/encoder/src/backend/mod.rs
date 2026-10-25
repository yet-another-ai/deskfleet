use crate::{EncoderError, types::Codec};

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
pub fn platform_supported_codecs(_display_id: u32) -> Result<Vec<Codec>, EncoderError> {
    Ok(crate::macos::probe_supported_codecs())
}

#[cfg(target_os = "windows")]
pub fn platform_supported_codecs(display_id: u32) -> Result<Vec<Codec>, EncoderError> {
    windows::supported_codecs(display_id)
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub(crate) fn platform_supported_codecs(_display_id: u32) -> Result<Vec<Codec>, EncoderError> {
    Ok(Vec::new())
}
