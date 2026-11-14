use deskfleet_capture::Frame;
use std::time::Duration;

use super::fallback::{first_packets, require_h264, with_software_fallback};
use crate::{Codec, EncodedPacket, EncoderConfig, EncoderError, software, windows, windows_mf};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Preference {
    Auto,
    Nvenc,
    MediaFoundation,
    X264,
}

impl Preference {
    fn parse(value: Option<&str>) -> Result<Self, EncoderError> {
        match value {
            None | Some("auto") => Ok(Self::Auto),
            Some("nvenc") => Ok(Self::Nvenc),
            Some("media-foundation") => Ok(Self::MediaFoundation),
            Some("x264") => Ok(Self::X264),
            Some(_) => Err(EncoderError::InvalidConfig(
                "DESKFLEET_WINDOWS_ENCODER must be auto, nvenc, media-foundation, or x264".into(),
            )),
        }
    }

    fn current() -> Result<Self, EncoderError> {
        match std::env::var("DESKFLEET_WINDOWS_ENCODER") {
            Ok(value) => Self::parse(Some(&value)),
            Err(std::env::VarError::NotPresent) => Self::parse(None),
            Err(error) => Err(EncoderError::InvalidConfig(error.to_string())),
        }
    }
}

enum ActiveEncoder {
    Nvenc(Box<windows::WindowsEncoder>),
    MediaFoundation(Box<windows_mf::MfEncoder>),
    X264(Box<software::SoftwareEncoder>),
}

pub struct PlatformEncoder {
    config: EncoderConfig,
    preference: Preference,
    active: Option<ActiveEncoder>,
    pending_keyframe: bool,
}

/// Try backends only during startup, preserving the negotiated codec.
fn select<T>(
    preference: Preference,
    codec: Codec,
    nvenc: impl FnOnce() -> Result<T, EncoderError>,
    mf: impl FnOnce() -> Result<T, EncoderError>,
    x264: impl FnOnce() -> Result<T, EncoderError>,
) -> Result<T, EncoderError> {
    match preference {
        Preference::Nvenc => return nvenc(),
        Preference::MediaFoundation => return mf(),
        Preference::X264 => {
            require_h264(codec)?;
            return x264();
        }
        Preference::Auto => {}
    }
    with_software_fallback(
        codec,
        || {
            nvenc().or_else(|error| {
                tracing::info!(
                    %error,
                    %codec,
                    "NVENC startup failed; trying Media Foundation hardware encoder"
                );
                mf().map_err(|mf_error| {
                    EncoderError::Platform(format!(
                        "no {codec} hardware encoder could start (NVENC: {error}; Media Foundation: {mf_error})"
                    ))
                })
            })
        },
        x264,
    )
}

pub(crate) fn supported_codecs(display_id: u32) -> Result<Vec<Codec>, EncoderError> {
    let preference = Preference::current()?;
    let (device, _context) = deskfleet_capture::create_d3d11_device_for_display(display_id)
        .map_err(|error| EncoderError::Platform(format!("open display adapter: {error}")))?;
    Ok(probe_device_codecs(
        preference,
        &device,
        windows::WindowsEncoder::probe_supported_codecs,
        windows_mf::supported_codecs,
        software::available,
    ))
}

/// Both backends must inspect the same display device, including fallback probes.
fn probe_device_codecs<D>(
    preference: Preference,
    device: &D,
    nvenc: impl FnOnce(&D) -> Vec<Codec>,
    mf: impl FnOnce(&D) -> Vec<Codec>,
    software_available: impl FnOnce() -> bool,
) -> Vec<Codec> {
    let mut codecs = if matches!(preference, Preference::Auto | Preference::Nvenc) {
        nvenc(device)
    } else {
        Vec::new()
    };
    if matches!(preference, Preference::Auto | Preference::MediaFoundation) {
        for codec in mf(device) {
            if !codecs.contains(&codec) {
                codecs.push(codec);
            }
        }
    }
    if matches!(preference, Preference::Auto | Preference::X264)
        && !codecs.contains(&Codec::H264)
        && software_available()
    {
        codecs.push(Codec::H264);
    }
    codecs
}

impl PlatformEncoder {
    pub(crate) fn new(config: &EncoderConfig) -> Result<Self, EncoderError> {
        let preference = Preference::current()?;
        Ok(Self {
            config: config.clone(),
            preference,
            active: None,
            pending_keyframe: false,
        })
    }

    pub(crate) fn encode(&mut self, frame: &Frame) -> Result<Vec<EncodedPacket>, EncoderError> {
        if let Some(active) = &mut self.active {
            return match active {
                ActiveEncoder::Nvenc(encoder) => encoder.encode(frame),
                ActiveEncoder::MediaFoundation(encoder) => encoder.encode(frame),
                ActiveEncoder::X264(encoder) => encoder.encode(frame),
            };
        }
        // NVENC opens its session on encode(), so testing new() alone misses
        // failures on the actual capture device.
        let (active, packets) = select(
            self.preference,
            self.config.codec,
            || {
                let mut encoder = Box::new(windows::WindowsEncoder::new(&self.config)?);
                if self.pending_keyframe {
                    encoder.request_keyframe();
                }
                let packets = encoder.encode(frame)?;
                Ok((ActiveEncoder::Nvenc(encoder), packets))
            },
            || {
                let mut encoder = Box::new(windows_mf::MfEncoder::new(&self.config, frame)?);
                if self.pending_keyframe {
                    encoder.request_keyframe();
                }
                let packets = encoder.encode(frame)?;
                let packets =
                    first_packets(packets, || encoder.poll_output(), Duration::from_secs(1))?;
                Ok((ActiveEncoder::MediaFoundation(encoder), packets))
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

    pub(crate) fn poll_output(&mut self) -> Result<Vec<EncodedPacket>, EncoderError> {
        match &mut self.active {
            Some(ActiveEncoder::MediaFoundation(encoder)) => encoder.poll_output(),
            Some(ActiveEncoder::X264(encoder)) => encoder.poll_output(),
            _ => Ok(Vec::new()),
        }
    }

    pub(crate) fn flush(&mut self) -> Result<Vec<EncodedPacket>, EncoderError> {
        match &mut self.active {
            Some(ActiveEncoder::Nvenc(encoder)) => encoder.flush(),
            Some(ActiveEncoder::MediaFoundation(encoder)) => encoder.flush(),
            Some(ActiveEncoder::X264(encoder)) => encoder.flush(),
            None => Ok(Vec::new()),
        }
    }

    pub(crate) fn request_keyframe(&mut self) {
        match &mut self.active {
            Some(ActiveEncoder::Nvenc(encoder)) => encoder.request_keyframe(),
            Some(ActiveEncoder::MediaFoundation(encoder)) => encoder.request_keyframe(),
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
            Some(ActiveEncoder::Nvenc(encoder)) => {
                encoder.set_bitrate(avg_bitrate_bps, max_bitrate_bps)?;
            }
            Some(ActiveEncoder::MediaFoundation(encoder)) => {
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
            Some(ActiveEncoder::X264(encoder)) => encoder.set_fps(fps)?,
            Some(_) => {
                return Err(EncoderError::Unsupported(
                    "live Windows frame-rate reconfiguration",
                ));
            }
            None => {}
        }
        self.config.fps = fps;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    #[test]
    fn codec_probes_never_combine_different_display_adapters() {
        #[derive(Clone, Copy)]
        enum Adapter {
            Nvidia,
            Integrated,
            WithoutHardwareEncoder,
        }
        let nvenc = |adapter: &Adapter| match adapter {
            Adapter::Nvidia => vec![Codec::H264, Codec::H265, Codec::AV1],
            Adapter::Integrated | Adapter::WithoutHardwareEncoder => Vec::new(),
        };
        let mf = |adapter: &Adapter| match adapter {
            Adapter::Integrated => vec![Codec::H264, Codec::H265],
            Adapter::Nvidia | Adapter::WithoutHardwareEncoder => Vec::new(),
        };

        // Changing displays must not retain the discrete GPU's capabilities or
        // borrow codec support from the other display's integrated GPU.
        for (adapter, expected) in [
            (Adapter::Nvidia, vec![Codec::H264, Codec::H265, Codec::AV1]),
            (Adapter::Integrated, vec![Codec::H264, Codec::H265]),
            (Adapter::WithoutHardwareEncoder, Vec::new()),
            (Adapter::Nvidia, vec![Codec::H264, Codec::H265, Codec::AV1]),
        ] {
            assert_eq!(
                probe_device_codecs(Preference::Auto, &adapter, nvenc, mf, || false),
                expected,
            );
        }
        assert!(
            probe_device_codecs(Preference::Nvenc, &Adapter::Integrated, nvenc, mf, || true)
                .is_empty()
        );
        assert_eq!(
            probe_device_codecs(
                Preference::MediaFoundation,
                &Adapter::Integrated,
                nvenc,
                mf,
                || true
            ),
            vec![Codec::H264, Codec::H265],
        );
        assert!(
            probe_device_codecs(
                Preference::MediaFoundation,
                &Adapter::Nvidia,
                nvenc,
                mf,
                || true
            )
            .is_empty()
        );
        assert_eq!(
            probe_device_codecs(
                Preference::Auto,
                &Adapter::WithoutHardwareEncoder,
                nvenc,
                mf,
                || true
            ),
            vec![Codec::H264],
        );
        assert_eq!(
            probe_device_codecs(Preference::Auto, &Adapter::Nvidia, nvenc, mf, || true),
            vec![Codec::H264, Codec::H265, Codec::AV1],
        );
        let unexpected = |_: &Adapter| -> Vec<Codec> { panic!("unexpected hardware probe") };
        assert_eq!(
            probe_device_codecs(
                Preference::X264,
                &Adapter::Nvidia,
                unexpected,
                unexpected,
                || true
            ),
            vec![Codec::H264],
        );
        assert!(
            probe_device_codecs(
                Preference::X264,
                &Adapter::Nvidia,
                unexpected,
                unexpected,
                || false
            )
            .is_empty()
        );
    }

    #[test]
    fn nvenc_first_with_same_codec_fallback() {
        let mf_called = Cell::new(false);
        let mf = || {
            mf_called.set(true);
            Ok("mf")
        };
        let unexpected = || -> Result<&str, EncoderError> { panic!("unexpected software encoder") };
        assert_eq!(
            select(
                Preference::Auto,
                Codec::H264,
                || Ok("nvenc"),
                mf,
                unexpected
            )
            .unwrap(),
            "nvenc"
        );
        assert!(!mf_called.get());
        let failed = || Err(EncoderError::Unsupported("NVENC device"));
        for codec in Codec::ALL {
            mf_called.set(false);
            assert_eq!(
                select(Preference::Auto, codec, failed, mf, unexpected).unwrap(),
                "mf"
            );
            assert!(mf_called.get());
        }
        assert_eq!(
            select(Preference::Auto, Codec::H264, failed, failed, || Ok("x264")).unwrap(),
            "x264"
        );
        for codec in [Codec::H265, Codec::AV1] {
            assert!(select(Preference::Auto, codec, failed, failed, unexpected).is_err());
        }
    }

    #[test]
    fn explicit_selection_never_uses_the_other_backend() {
        let failed = || Err(EncoderError::Unsupported("unavailable"));
        let unexpected = || -> Result<(), EncoderError> { panic!("unexpected backend") };
        for codec in Codec::ALL {
            assert!(select(Preference::Nvenc, codec, failed, unexpected, unexpected).is_err());
            assert!(
                select(
                    Preference::MediaFoundation,
                    codec,
                    unexpected,
                    failed,
                    unexpected
                )
                .is_err()
            );
        }
        assert!(
            select(
                Preference::X264,
                Codec::H264,
                unexpected,
                unexpected,
                failed
            )
            .is_err()
        );
        for codec in [Codec::H265, Codec::AV1] {
            assert!(select(Preference::X264, codec, unexpected, unexpected, unexpected).is_err());
        }
        assert_eq!(Preference::parse(Some("x264")).unwrap(), Preference::X264);
        assert!(Preference::parse(Some("software")).is_err());
    }

    #[test]
    fn preserves_hardware_and_software_failures() {
        let error = select::<()>(
            Preference::Auto,
            Codec::H264,
            || Err(EncoderError::Platform("NVENC failed".into())),
            || Err(EncoderError::Platform("MF failed".into())),
            || Err(EncoderError::Platform("x264 failed".into())),
        )
        .unwrap_err()
        .to_string();
        assert!(error.contains("NVENC failed"));
        assert!(error.contains("MF failed"));
        assert!(error.contains("x264 failed"));
    }
}
