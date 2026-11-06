//! NVENC error types.

use std::fmt;

/// Errors that can occur when using the NVENC encoder.
#[derive(Debug)]
pub enum NvEncError {
    /// NVENC is not available on this system (no NVIDIA driver / GPU).
    NotAvailable,
    /// The installed driver is too old for the SDK version we target.
    UnsupportedDriverVersion { driver: u32, required: u32 },
    /// Failed to open an NVENC encode session.
    SessionOpenFailed(deskfleet_nvenc_sys::NVENCSTATUS),
    /// Failed to initialise the encoder.
    InitFailed(deskfleet_nvenc_sys::NVENCSTATUS),
    /// Failed to create an input buffer.
    InputBufferFailed(deskfleet_nvenc_sys::NVENCSTATUS),
    /// Failed to create a bitstream (output) buffer.
    BitstreamBufferFailed(deskfleet_nvenc_sys::NVENCSTATUS),
    /// An encode operation failed.
    EncodeFailed(deskfleet_nvenc_sys::NVENCSTATUS),
    /// This device/codec cannot change its bitrate on a live session.
    DynamicBitrateUnsupported,
    /// Reconfiguring an existing session failed.
    ReconfigureFailed(deskfleet_nvenc_sys::NVENCSTATUS),
    /// Locking a buffer failed.
    LockFailed(deskfleet_nvenc_sys::NVENCSTATUS),
    /// A generic NVENC error.
    Api(deskfleet_nvenc_sys::NVENCSTATUS),
}

impl fmt::Display for NvEncError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NotAvailable => write!(f, "NVENC is not available on this system"),
            Self::UnsupportedDriverVersion { driver, required } => {
                write!(
                    f,
                    "NVENC driver version {driver} is too old (need >= {required})"
                )
            }
            Self::SessionOpenFailed(s) => write!(f, "failed to open NVENC session: {s:?}"),
            Self::InitFailed(s) => write!(f, "failed to initialise encoder: {s:?}"),
            Self::InputBufferFailed(s) => write!(f, "failed to create input buffer: {s:?}"),
            Self::BitstreamBufferFailed(s) => {
                write!(f, "failed to create bitstream buffer: {s:?}")
            }
            Self::EncodeFailed(s) => write!(f, "encode failed: {s:?}"),
            Self::DynamicBitrateUnsupported => {
                write!(f, "live NVENC bitrate changes are unsupported")
            }
            Self::ReconfigureFailed(s) => write!(f, "encoder reconfiguration failed: {s:?}"),
            Self::LockFailed(s) => write!(f, "buffer lock failed: {s:?}"),
            Self::Api(s) => write!(f, "NVENC API error: {s:?}"),
        }
    }
}

impl std::error::Error for NvEncError {}
