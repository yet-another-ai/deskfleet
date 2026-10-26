use deskfleet_capture::Frame;
use deskfleet_linux_media::{Codec as MediaCodec, EncodedFrame, EncoderSettings};

use crate::{Codec, EncodedPacket, EncoderConfig, EncoderError, H264Profile, H265Profile};

pub(crate) fn supported_codecs() -> Vec<Codec> {
    Codec::ALL
        .into_iter()
        .filter(|codec| deskfleet_linux_media::has_encoder(media_codec(*codec)))
        .collect()
}

fn media_codec(codec: Codec) -> MediaCodec {
    match codec {
        Codec::H264 => MediaCodec::H264,
        Codec::H265 => MediaCodec::H265,
        Codec::AV1 => MediaCodec::Av1,
    }
}

pub(crate) struct PlatformEncoder {
    settings: EncoderSettings,
    active: Option<deskfleet_linux_media::Encoder>,
    keyframe: bool,
}

impl PlatformEncoder {
    pub(crate) fn new(config: &EncoderConfig) -> Result<Self, EncoderError> {
        if config.codec == Codec::H265 && config.h265_profile != H265Profile::Main {
            return Err(EncoderError::Unsupported(
                "Linux H.265 encoding requires the 8-bit Main profile",
            ));
        }
        Ok(Self {
            settings: EncoderSettings {
                codec: media_codec(config.codec),
                width: config.width,
                height: config.height,
                fps: config.fps,
                bitrate_bps: config.bitrate_bps,
                max_bitrate_bps: config.max_bitrate_bps,
                profile: match config.codec {
                    Codec::H264 => match config.h264_profile {
                        H264Profile::ConstrainedBaseline => "constrained-baseline",
                        H264Profile::Main => "main",
                        H264Profile::High => "high",
                    },
                    Codec::H265 | Codec::AV1 => "main",
                },
            },
            active: None,
            keyframe: false,
        })
    }

    pub(crate) fn encode(&mut self, frame: &Frame) -> Result<Vec<EncodedPacket>, EncoderError> {
        let pixels = frame.surface().bgra_pixels();
        let packets = if let Some(active) = self.active.as_mut() {
            if std::mem::take(&mut self.keyframe) {
                active.request_keyframe();
            }
            active
                .encode(pixels, frame.timestamp_ns)
                .map_err(map_error)?
        } else {
            let (active, packets) =
                deskfleet_linux_media::Encoder::start(&self.settings, pixels, frame.timestamp_ns)
                    .map_err(map_error)?;
            self.active = Some(active);
            self.keyframe = false; // The initial hardware output is already a keyframe.
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

    pub(crate) fn set_bitrate(&self, average: u32, maximum: u32) -> Result<(), EncoderError> {
        self.active
            .as_ref()
            .ok_or(EncoderError::Unsupported(
                "encoder has not received its first frame",
            ))?
            .set_bitrate(average, maximum)
            .map_err(map_error)
    }

    pub(crate) fn set_fps(&mut self, fps: f64) -> Result<(), EncoderError> {
        if self.active.is_some() {
            return Err(EncoderError::Unsupported(
                "live Linux frame-rate reconfiguration",
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

fn map_error(error: deskfleet_linux_media::Error) -> EncoderError {
    EncoderError::Platform(error.to_string())
}
