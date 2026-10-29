//! In-process GStreamer capture and hardware encoding, loaded only on demand.
//!
//! No desktop shared library is linked into the daemon's addon. A headless
//! installation can load the addon and use agents/terminals without GStreamer.
//! Captured system-memory frames are copied before releasing PipeWire buffers;
//! hardware encoding uploads these owned frames. This is not a zero-copy path.

#![cfg(target_os = "linux")]

mod capture;
mod codec;
mod encoder;
mod ffi;
mod pipeline;

pub use capture::{Capture, VideoFrame};
pub use codec::Codec;
pub use encoder::{EncodedFrame, Encoder, EncoderSettings};

/// Failure to load the optional runtime or operate a media pipeline.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("Linux desktop media runtime is unavailable: {0}")]
    Unavailable(String),
    #[error("Linux desktop media failed: {0}")]
    Pipeline(String),
    #[error("Linux desktop media stream ended")]
    Ended,
}

pub type Result<T> = std::result::Result<T, Error>;

/// Probe the PipeWire capture runtime without opening a portal.
#[must_use]
pub fn capture_available() -> bool {
    ffi::api().is_ok_and(|api| {
        ["pipewiresrc", "videoconvert", "appsink"]
            .iter()
            .all(|name| api.has_factory(name))
    })
}

/// Probe shared hardware encoding independently of the desktop capture backend.
#[must_use]
pub fn encoding_available() -> bool {
    ffi::api().is_ok_and(|api| {
        ["videoconvert", "appsink", "appsrc"]
            .iter()
            .all(|name| api.has_factory(name))
            && Codec::ALL
                .into_iter()
                .any(|codec| codec::has_encoder(codec, |name| api.has_factory(name)))
    })
}

/// Whether an installed hardware encoder and parser are candidates for this codec.
/// Actual device/format initialization is verified on the first input frame.
#[must_use]
pub fn has_encoder(codec: Codec) -> bool {
    ffi::api().is_ok_and(|api| codec::has_encoder(codec, |name| api.has_factory(name)))
}
