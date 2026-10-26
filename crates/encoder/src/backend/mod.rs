use crate::{EncoderError, types::Codec};

#[cfg(target_os = "macos")]
mod macos;

#[cfg(target_os = "windows")]
mod windows;

#[cfg(target_os = "linux")]
mod linux;

#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
mod stub;

#[cfg(target_os = "macos")]
pub use macos::PlatformEncoder;

#[cfg(target_os = "windows")]
pub use windows::PlatformEncoder;

#[cfg(target_os = "linux")]
pub(crate) use linux::PlatformEncoder;

#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
pub(crate) use stub::PlatformEncoder;

#[cfg(target_os = "linux")]
pub(crate) fn platform_supported_codecs(display_id: u32) -> Result<Vec<Codec>, EncoderError> {
    let source_exists = deskfleet_capture::displays()
        .map_err(|error| EncoderError::Platform(error.to_string()))?
        .iter()
        .any(|display| display.id == display_id);
    Ok(if source_exists {
        linux::supported_codecs()
    } else {
        Vec::new()
    })
}

#[cfg(target_os = "macos")]
pub fn platform_supported_codecs(_display_id: u32) -> Result<Vec<Codec>, EncoderError> {
    Ok(crate::macos::probe_supported_codecs())
}

#[cfg(target_os = "windows")]
pub fn platform_supported_codecs(display_id: u32) -> Result<Vec<Codec>, EncoderError> {
    windows::supported_codecs(display_id)
}

#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
pub(crate) fn platform_supported_codecs(_display_id: u32) -> Result<Vec<Codec>, EncoderError> {
    Ok(Vec::new())
}
