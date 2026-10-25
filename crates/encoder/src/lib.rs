//! Ported from dsh0416/desk-fleet, commit e4b963274b4afae8a7b8065d9efe5c6770bf9339.
//!
//! Hardware video encoding abstraction for Desk Fleet.

mod backend;
#[cfg(any(target_os = "macos", target_os = "windows", test))]
mod bitstream;
mod error;
#[cfg(target_os = "macos")]
mod macos;
mod opus_enc;
mod packet;
mod types;
#[cfg(target_os = "windows")]
mod windows;
#[cfg(target_os = "windows")]
mod windows_mf;

pub use error::EncoderError;
pub use opus_enc::{OpusEncoder, OpusEncoderConfig, OpusPacket};
pub use packet::EncodedPacket;
pub use types::{AV1Profile, Codec, EncoderConfig, H264Profile, H265Profile};

use deskfleet_capture::Frame;

/// Return the hardware video codecs available for the selected display.
///
/// Windows probes both hardware backends on the adapter that owns this display.
/// Results are queried afresh so changing displays or GPUs cannot reuse another
/// adapter's capabilities. This does not start screen capture.
pub fn supported_codecs(display_id: u32) -> Result<Vec<Codec>, EncoderError> {
    backend::platform_supported_codecs(display_id)
}

/// A hardware-accelerated video encoder (H.264, H.265, or AV1).
pub struct Encoder {
    inner: backend::PlatformEncoder,
    width: u32,
    height: u32,
}

impl Encoder {
    /// Create a new encoder with the given configuration.
    pub fn new(config: &EncoderConfig) -> Result<Self, EncoderError> {
        config.validate()?;
        let inner = backend::PlatformEncoder::new(config)?;
        Ok(Self {
            inner,
            width: config.width,
            height: config.height,
        })
    }

    /// Encode a captured frame.
    ///
    /// Returns any encoded packets produced so far. Because hardware encoders
    /// may work asynchronously, packets from earlier frames may be returned.
    pub fn encode(&mut self, frame: &Frame) -> Result<Vec<EncodedPacket>, EncoderError> {
        if frame.width != self.width || frame.height != self.height {
            return Err(EncoderError::InvalidConfig(
                "frame dimensions differ from encoder configuration".into(),
            ));
        }
        self.inner.encode(frame)
    }

    /// Collect asynchronous output even when the desktop has not produced a new frame.
    pub fn poll_output(&mut self) -> Result<Vec<EncodedPacket>, EncoderError> {
        self.inner.poll_output()
    }

    /// Flush any pending frames from the encoder.
    pub fn flush(&mut self) -> Result<Vec<EncodedPacket>, EncoderError> {
        self.inner.flush()
    }

    /// Request that the next encoded frame be a keyframe.
    ///
    /// Typically called in response to a WebRTC PLI or FIR signal.
    pub fn request_keyframe(&mut self) {
        self.inner.request_keyframe();
    }

    /// Change the target and/or maximum bitrate on the live encoder session.
    pub fn set_bitrate(
        &self,
        avg_bitrate_bps: u32,
        max_bitrate_bps: u32,
    ) -> Result<(), EncoderError> {
        types::validate_bitrate(avg_bitrate_bps, max_bitrate_bps)?;
        self.inner.set_bitrate(avg_bitrate_bps, max_bitrate_bps)
    }

    /// Change the target frame rate on the live encoder session.
    pub fn set_fps(&mut self, fps: f64) -> Result<(), EncoderError> {
        types::validate_fps(fps)?;
        self.inner.set_fps(fps)
    }
}

#[cfg(test)]
mod tests;
