use deskfleet_capture::Frame;

use crate::error::EncoderError;
use crate::packet::EncodedPacket;
use crate::types::EncoderConfig;

pub(crate) struct PlatformEncoder;

impl PlatformEncoder {
    pub(crate) fn new(_config: &EncoderConfig) -> Result<Self, EncoderError> {
        Err(EncoderError::Unsupported(
            "no encoder backend for this platform",
        ))
    }

    pub(crate) fn encode(&mut self, _frame: &Frame) -> Result<Vec<EncodedPacket>, EncoderError> {
        Err(EncoderError::Unsupported(
            "no encoder backend for this platform",
        ))
    }

    pub(crate) fn flush(&mut self) -> Result<Vec<EncodedPacket>, EncoderError> {
        Err(EncoderError::Unsupported(
            "no encoder backend for this platform",
        ))
    }

    pub(crate) fn poll_output(&mut self) -> Result<Vec<EncodedPacket>, EncoderError> {
        Ok(Vec::new())
    }

    pub(crate) fn request_keyframe(&mut self) {
        // No-op on unsupported platforms.
    }

    pub(crate) fn set_bitrate(
        &self,
        _avg_bitrate_bps: u32,
        _max_bitrate_bps: u32,
    ) -> Result<(), EncoderError> {
        Err(EncoderError::Unsupported(
            "no encoder backend for this platform",
        ))
    }

    pub(crate) fn set_fps(&mut self, _fps: f64) -> Result<(), EncoderError> {
        Err(EncoderError::Unsupported(
            "no encoder backend for this platform",
        ))
    }
}
