use deskfleet_capture::Frame;
use std::time::Duration;

use super::fallback::{first_packets, require_h264, with_software_fallback};
use crate::{Codec, EncodedPacket, EncoderConfig, EncoderError, macos, software};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Preference {
    Auto,
    VideoToolbox,
    X264,
}

impl Preference {
    fn parse(value: Option<&str>) -> Result<Self, EncoderError> {
        match value {
            None | Some("auto") => Ok(Self::Auto),
            Some("videotoolbox") => Ok(Self::VideoToolbox),
            Some("x264") => Ok(Self::X264),
            Some(_) => Err(EncoderError::InvalidConfig(
                "DESKFLEET_MACOS_ENCODER must be auto, videotoolbox, or x264".into(),
            )),
        }
    }

    fn current() -> Result<Self, EncoderError> {
        match std::env::var("DESKFLEET_MACOS_ENCODER") {
            Ok(value) => Self::parse(Some(&value)),
            Err(std::env::VarError::NotPresent) => Self::parse(None),
            Err(error) => Err(EncoderError::InvalidConfig(error.to_string())),
        }
    }
}

enum ActiveEncoder {
    VideoToolbox(Box<macos::MacOSEncoder>),
    X264(Box<software::SoftwareEncoder>),
}

pub struct PlatformEncoder {
    config: EncoderConfig,
    preference: Preference,
    active: Option<ActiveEncoder>,
    pending_keyframe: bool,
}

fn select<T>(
    preference: Preference,
    codec: Codec,
    hardware: impl FnOnce() -> Result<T, EncoderError>,
    software: impl FnOnce() -> Result<T, EncoderError>,
) -> Result<T, EncoderError> {
    match preference {
        Preference::Auto => with_software_fallback(codec, hardware, software),
        Preference::VideoToolbox => hardware(),
        Preference::X264 => {
            require_h264(codec)?;
            software()
        }
    }
}

pub(crate) fn supported_codecs() -> Result<Vec<Codec>, EncoderError> {
    Ok(probe_codecs(
        Preference::current()?,
        macos::probe_supported_codecs,
        software::available,
    ))
}

fn probe_codecs(
    preference: Preference,
    hardware: impl FnOnce() -> Vec<Codec>,
    software_available: impl FnOnce() -> bool,
) -> Vec<Codec> {
    let mut codecs = if preference == Preference::X264 {
        Vec::new()
    } else {
        hardware()
    };
    if preference != Preference::VideoToolbox
        && !codecs.contains(&Codec::H264)
        && software_available()
    {
        codecs.push(Codec::H264);
    }
    codecs
}

impl PlatformEncoder {
    pub(crate) fn new(config: &EncoderConfig) -> Result<Self, EncoderError> {
        Ok(Self {
            config: config.clone(),
            preference: Preference::current()?,
            active: None,
            pending_keyframe: false,
        })
    }

    pub(crate) fn encode(&mut self, frame: &Frame) -> Result<Vec<EncodedPacket>, EncoderError> {
        if let Some(active) = &mut self.active {
            return match active {
                ActiveEncoder::VideoToolbox(encoder) => encoder
                    .encode_pixel_buffer(frame.surface().as_pixel_buffer_ref(), frame.timestamp_ns),
                ActiveEncoder::X264(encoder) => encoder.encode(frame),
            };
        }

        let (active, packets) = select(
            self.preference,
            self.config.codec,
            || {
                let mut encoder = Box::new(macos::MacOSEncoder::new(&self.config)?);
                if self.pending_keyframe {
                    encoder.request_keyframe();
                }
                let packets = encoder.encode_pixel_buffer(
                    frame.surface().as_pixel_buffer_ref(),
                    frame.timestamp_ns,
                )?;
                // Verify the real first frame before selecting this hardware
                // session. Subsequent frames retain asynchronous pipelining.
                let packets = first_packets(
                    packets,
                    || Ok(encoder.drain_packets()),
                    Duration::from_secs(1),
                )?;
                Ok((ActiveEncoder::VideoToolbox(encoder), packets))
            },
            || {
                let mut encoder = Box::new(software::SoftwareEncoder::new(&self.config)?);
                if self.pending_keyframe {
                    encoder.request_keyframe();
                }
                let packets = encoder.encode(frame)?;
                Ok((ActiveEncoder::X264(encoder), packets))
            },
        )?;
        self.active = Some(active);
        self.pending_keyframe = false;
        Ok(packets)
    }

    pub(crate) fn flush(&mut self) -> Result<Vec<EncodedPacket>, EncoderError> {
        match &mut self.active {
            Some(ActiveEncoder::VideoToolbox(encoder)) => encoder.flush(),
            Some(ActiveEncoder::X264(encoder)) => encoder.flush(),
            None => Ok(Vec::new()),
        }
    }

    pub(crate) fn poll_output(&mut self) -> Result<Vec<EncodedPacket>, EncoderError> {
        match &mut self.active {
            Some(ActiveEncoder::VideoToolbox(encoder)) => Ok(encoder.drain_packets()),
            Some(ActiveEncoder::X264(encoder)) => encoder.poll_output(),
            None => Ok(Vec::new()),
        }
    }

    pub(crate) fn request_keyframe(&mut self) {
        match &mut self.active {
            Some(ActiveEncoder::VideoToolbox(encoder)) => encoder.request_keyframe(),
            Some(ActiveEncoder::X264(encoder)) => encoder.request_keyframe(),
            None => self.pending_keyframe = true,
        }
    }

    pub(crate) fn set_bitrate(
        &mut self,
        avg_bitrate_bps: u32,
        max_bitrate_bps: u32,
    ) -> Result<(), EncoderError> {
        match &mut self.active {
            Some(ActiveEncoder::VideoToolbox(encoder)) => {
                encoder.set_bitrate(avg_bitrate_bps, max_bitrate_bps)?;
            }
            Some(ActiveEncoder::X264(encoder)) => {
                encoder.set_bitrate(avg_bitrate_bps, max_bitrate_bps)?;
            }
            None => {}
        }
        self.config.bitrate_bps = avg_bitrate_bps;
        self.config.max_bitrate_bps = max_bitrate_bps;
        Ok(())
    }

    pub(crate) fn set_fps(&mut self, fps: f64) -> Result<(), EncoderError> {
        match &mut self.active {
            Some(ActiveEncoder::VideoToolbox(encoder)) => encoder.set_fps(fps)?,
            Some(ActiveEncoder::X264(encoder)) => encoder.set_fps(fps)?,
            None => {}
        }
        self.config.fps = fps;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn automatic_selection_keeps_hardware_first_and_falls_back_only_for_h264() {
        let failed = || Err(EncoderError::Unsupported("VideoToolbox unavailable"));
        let unexpected = || -> Result<&str, EncoderError> { panic!("unexpected software") };
        for codec in Codec::ALL {
            assert_eq!(
                select(Preference::Auto, codec, || Ok("vt"), unexpected).unwrap(),
                "vt"
            );
        }
        assert_eq!(
            select(Preference::Auto, Codec::H264, failed, || Ok("x264")).unwrap(),
            "x264"
        );
        for codec in [Codec::H265, Codec::AV1] {
            assert!(select(Preference::Auto, codec, failed, unexpected).is_err());
        }
    }

    #[test]
    fn explicit_selection_never_uses_the_other_backend() {
        let failed = || Err(EncoderError::Unsupported("unavailable"));
        let unexpected = || -> Result<(), EncoderError> { panic!("unexpected backend") };
        for codec in Codec::ALL {
            assert!(select(Preference::VideoToolbox, codec, failed, unexpected).is_err());
        }
        assert!(select(Preference::X264, Codec::H264, unexpected, failed).is_err());
        for codec in [Codec::H265, Codec::AV1] {
            assert!(select(Preference::X264, codec, unexpected, unexpected).is_err());
        }
        assert_eq!(Preference::parse(Some("x264")).unwrap(), Preference::X264);
        assert!(Preference::parse(Some("software")).is_err());
    }

    #[test]
    fn software_adds_only_h264_to_discovery_and_respects_overrides() {
        assert_eq!(
            probe_codecs(Preference::Auto, Vec::new, || true),
            vec![Codec::H264]
        );
        assert!(probe_codecs(Preference::Auto, Vec::new, || false).is_empty());
        assert_eq!(
            probe_codecs(Preference::Auto, || vec![Codec::H265], || true),
            vec![Codec::H265, Codec::H264],
        );
        assert_eq!(
            probe_codecs(Preference::Auto, || vec![Codec::H264, Codec::H265], || true),
            vec![Codec::H264, Codec::H265],
        );
        assert!(probe_codecs(Preference::VideoToolbox, Vec::new, || true).is_empty());
        let unexpected = || -> Vec<Codec> { panic!("unexpected hardware probe") };
        assert_eq!(
            probe_codecs(Preference::X264, unexpected, || true),
            vec![Codec::H264]
        );
        assert!(probe_codecs(Preference::X264, unexpected, || false).is_empty());
    }
}
