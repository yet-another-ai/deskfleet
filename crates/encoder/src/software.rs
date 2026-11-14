//! Optional x264 fallback, sharing the Linux pipeline's low-latency settings.

use deskfleet_capture::Frame;
use deskfleet_gstreamer_media::{Codec as MediaCodec, EncodedFrame, EncoderSettings};

use crate::{Codec, EncodedPacket, EncoderConfig, EncoderError, H264Profile};

pub(crate) fn available() -> bool {
    deskfleet_gstreamer_media::x264_available()
}

pub(crate) struct SoftwareEncoder {
    settings: EncoderSettings,
    active: Option<deskfleet_gstreamer_media::Encoder>,
    keyframe: bool,
}

impl SoftwareEncoder {
    pub(crate) fn new(config: &EncoderConfig) -> Result<Self, EncoderError> {
        if config.codec != Codec::H264 {
            return Err(EncoderError::Unsupported("x264 only supports H.264"));
        }
        Ok(Self {
            settings: EncoderSettings {
                codec: MediaCodec::H264,
                width: config.width,
                height: config.height,
                fps: config.fps,
                bitrate_bps: config.bitrate_bps,
                max_bitrate_bps: config.max_bitrate_bps,
                profile: match config.h264_profile {
                    H264Profile::ConstrainedBaseline => "constrained-baseline",
                    H264Profile::Main => "main",
                    H264Profile::High => "high",
                },
            },
            active: None,
            keyframe: false,
        })
    }

    pub(crate) fn encode(&mut self, frame: &Frame) -> Result<Vec<EncodedPacket>, EncoderError> {
        let pixels = frame
            .copy_pixels()
            .map_err(|error| EncoderError::Platform(format!("x264 surface readback: {error}")))?;
        // D3D11 readback already packs its rows. IOSurface readback retains the
        // capture allocation's row padding, which must not become image pixels.
        #[cfg(target_os = "macos")]
        let pixels = deskfleet_gstreamer_media::packed_bgra(
            &pixels,
            frame.width,
            frame.height,
            0,
            i32::try_from(frame.stride)
                .map_err(|_| EncoderError::InvalidConfig("x264 row is too large".into()))?,
        )
        .map_err(map_error)?;
        self.encode_pixels(&pixels, frame.timestamp_ns)
    }

    fn encode_pixels(
        &mut self,
        pixels: &[u8],
        timestamp_ns: u64,
    ) -> Result<Vec<EncodedPacket>, EncoderError> {
        let packets = if let Some(active) = self.active.as_mut() {
            if std::mem::take(&mut self.keyframe) {
                active.request_keyframe();
            }
            active.encode(pixels, timestamp_ns).map_err(map_error)?
        } else {
            let (active, packets) = deskfleet_gstreamer_media::Encoder::start_x264(
                &self.settings,
                pixels,
                timestamp_ns,
            )
            .map_err(map_error)?;
            self.active = Some(active);
            // The first packet is already an independently decodable keyframe.
            self.keyframe = false;
            packets
        };
        Ok(convert(packets))
    }

    pub(crate) fn poll_output(&mut self) -> Result<Vec<EncodedPacket>, EncoderError> {
        self.active.as_mut().map_or_else(
            || Ok(Vec::new()),
            |active| active.poll_output().map(convert).map_err(map_error),
        )
    }

    pub(crate) fn flush(&mut self) -> Result<Vec<EncodedPacket>, EncoderError> {
        self.active.as_mut().map_or_else(
            || Ok(Vec::new()),
            |active| active.flush().map(convert).map_err(map_error),
        )
    }

    pub(crate) fn request_keyframe(&mut self) {
        self.keyframe = true;
    }

    pub(crate) fn set_bitrate(&mut self, average: u32, maximum: u32) -> Result<(), EncoderError> {
        if let Some(active) = &self.active {
            active.set_bitrate(average, maximum).map_err(map_error)?;
        }
        self.settings.bitrate_bps = average;
        self.settings.max_bitrate_bps = maximum;
        Ok(())
    }

    pub(crate) fn set_fps(&mut self, fps: f64) -> Result<(), EncoderError> {
        if self.active.is_some() {
            return Err(EncoderError::Unsupported(
                "live x264 frame-rate reconfiguration",
            ));
        }
        self.settings.fps = fps;
        Ok(())
    }
}

fn convert(packets: Vec<EncodedFrame>) -> Vec<EncodedPacket> {
    packets
        .into_iter()
        .map(|packet| EncodedPacket {
            data: packet.data,
            timestamp_ns: packet.timestamp_ns,
            duration_ns: packet.duration_ns,
            is_keyframe: packet.is_keyframe,
        })
        .collect()
}

fn map_error(error: deskfleet_gstreamer_media::Error) -> EncoderError {
    EncoderError::Platform(error.to_string())
}

#[cfg(test)]
mod tests;
