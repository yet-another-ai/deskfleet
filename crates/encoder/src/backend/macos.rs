use deskfleet_capture::Frame;

use crate::error::EncoderError;
use crate::macos;
use crate::packet::EncodedPacket;
use crate::types::EncoderConfig;

pub struct PlatformEncoder {
    encoder: macos::MacOSEncoder,
}

impl PlatformEncoder {
    pub(crate) fn new(config: &EncoderConfig) -> Result<Self, EncoderError> {
        let encoder = macos::MacOSEncoder::new(config)?;
        Ok(Self { encoder })
    }

    pub(crate) fn encode(&mut self, frame: &Frame) -> Result<Vec<EncodedPacket>, EncoderError> {
        let surface = frame.surface();
        self.encoder
            .encode_pixel_buffer(surface.as_pixel_buffer_ref(), frame.timestamp_ns)
    }

    pub(crate) fn flush(&mut self) -> Result<Vec<EncodedPacket>, EncoderError> {
        self.encoder.flush()
    }

    pub(crate) fn poll_output(&mut self) -> Result<Vec<EncodedPacket>, EncoderError> {
        Ok(self.encoder.drain_packets())
    }

    pub(crate) fn request_keyframe(&mut self) {
        self.encoder.request_keyframe();
    }

    pub(crate) fn set_bitrate(
        &self,
        avg_bitrate_bps: u32,
        max_bitrate_bps: u32,
    ) -> Result<(), EncoderError> {
        self.encoder.set_bitrate(avg_bitrate_bps, max_bitrate_bps)
    }

    pub(crate) fn set_fps(&mut self, fps: f64) -> Result<(), EncoderError> {
        self.encoder.set_fps(fps)
    }
}
