//! In-process GStreamer capture and hardware encoding, loaded only on demand.
//!
//! No desktop shared library is linked into the daemon's addon. A headless
//! installation can load the addon and use agents/terminals without GStreamer.
//! Captured system-memory frames are copied before releasing PipeWire buffers;
//! hardware encoding uploads these owned frames. This is not a zero-copy path.

#![cfg(target_os = "linux")]

mod capture;
mod encoder;
mod ffi;
mod pipeline;

pub use capture::{Capture, VideoFrame};
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

/// Probe runtime libraries and capture/encoder factories without opening a portal.
#[must_use]
pub fn is_available() -> bool {
    ffi::api().is_ok_and(|api| {
        [
            "pipewiresrc",
            "videoconvert",
            "appsink",
            "appsrc",
            "h264parse",
        ]
        .iter()
        .all(|name| api.has_factory(name))
            && encoder::has_encoder(api)
    })
}

/// Whether an installed hardware H.264 encoder is a candidate for streaming.
/// Actual device/format initialization is verified on the first input frame.
#[must_use]
pub fn has_h264_encoder() -> bool {
    ffi::api().is_ok_and(encoder::has_encoder)
}
