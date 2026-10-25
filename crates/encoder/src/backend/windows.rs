use deskfleet_capture::Frame;

use crate::{Codec, EncodedPacket, EncoderConfig, EncoderError, windows, windows_mf};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Preference {
    Auto,
    Nvenc,
    MediaFoundation,
}

impl Preference {
    fn parse(value: Option<&str>) -> Result<Self, EncoderError> {
        match value {
            None | Some("auto") => Ok(Self::Auto),
            Some("nvenc") => Ok(Self::Nvenc),
            Some("media-foundation") => Ok(Self::MediaFoundation),
            Some(_) => Err(EncoderError::InvalidConfig(
                "DESKFLEET_WINDOWS_ENCODER must be auto, nvenc, or media-foundation".into(),
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
}

pub struct PlatformEncoder {
    config: EncoderConfig,
    preference: Preference,
    active: Option<ActiveEncoder>,
    pending_keyframe: bool,
}

/// Try the next hardware backend only during startup, preserving the negotiated codec.
fn select<T>(
    preference: Preference,
    codec: Codec,
    nvenc: impl FnOnce() -> Result<T, EncoderError>,
    mf: impl FnOnce() -> Result<T, EncoderError>,
) -> Result<T, EncoderError> {
    if preference == Preference::MediaFoundation {
        if codec != Codec::H264 {
            return Err(EncoderError::Unsupported(
                "Media Foundation supports H.264 only",
            ));
        }
        return mf();
    }
    match nvenc() {
        Ok(value) => Ok(value),
        Err(error) if preference == Preference::Auto && codec == Codec::H264 => {
            tracing::info!(%error, "NVENC startup failed; trying Media Foundation hardware H.264");
            mf().map_err(|mf_error| {
                EncoderError::Platform(format!(
                    "no H.264 hardware encoder could start (NVENC: {error}; Media Foundation: {mf_error})"
                ))
            })
        }
        Err(error) => Err(error),
    }
}

pub(crate) fn supported_codecs(display_id: u32) -> Result<Vec<Codec>, EncoderError> {
    let preference = Preference::current()?;
    let (device, _context) = deskfleet_capture::create_d3d11_device_for_display(display_id)
        .map_err(|error| EncoderError::Platform(format!("open display adapter: {error}")))?;
    Ok(probe_device_codecs(
        preference,
        &device,
        windows::WindowsEncoder::probe_supported_codecs,
        windows_mf::is_supported,
    ))
}

/// Both backends must inspect the same display device, including fallback probes.
fn probe_device_codecs<D>(
    preference: Preference,
    device: &D,
    nvenc: impl FnOnce(&D) -> Vec<Codec>,
    mf: impl FnOnce(&D) -> bool,
) -> Vec<Codec> {
    let mut codecs = if preference == Preference::MediaFoundation {
        Vec::new()
    } else {
        nvenc(device)
    };
    if preference != Preference::Nvenc && !codecs.contains(&Codec::H264) && mf(device) {
        codecs.push(Codec::H264);
    }
    codecs
}

impl PlatformEncoder {
    pub(crate) fn new(config: &EncoderConfig) -> Result<Self, EncoderError> {
        let preference = Preference::current()?;
        if preference == Preference::MediaFoundation && config.codec != Codec::H264 {
            return Err(EncoderError::Unsupported(
                "Media Foundation supports H.264 only",
            ));
        }
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
                Ok((ActiveEncoder::MediaFoundation(encoder), packets))
            },
        )?;
        self.active = Some(active);
        self.pending_keyframe = false;
        Ok(packets)
    }

    pub(crate) fn poll_output(&mut self) -> Result<Vec<EncodedPacket>, EncoderError> {
        match &mut self.active {
            Some(ActiveEncoder::MediaFoundation(encoder)) => encoder.poll_output(),
            _ => Ok(Vec::new()),
        }
    }

    pub(crate) fn flush(&mut self) -> Result<Vec<EncodedPacket>, EncoderError> {
        match &mut self.active {
            Some(ActiveEncoder::Nvenc(encoder)) => encoder.flush(),
            Some(ActiveEncoder::MediaFoundation(encoder)) => encoder.flush(),
            None => Ok(Vec::new()),
        }
    }

    pub(crate) fn request_keyframe(&mut self) {
        match &mut self.active {
            Some(ActiveEncoder::Nvenc(encoder)) => encoder.request_keyframe(),
            Some(ActiveEncoder::MediaFoundation(encoder)) => encoder.request_keyframe(),
            None => self.pending_keyframe = true,
        }
    }

    pub(crate) fn set_bitrate(
        &self,
        avg_bitrate_bps: u32,
        max_bitrate_bps: u32,
    ) -> Result<(), EncoderError> {
        match &self.active {
            Some(ActiveEncoder::Nvenc(encoder)) => {
                encoder.set_bitrate(avg_bitrate_bps, max_bitrate_bps)
            }
            Some(ActiveEncoder::MediaFoundation(encoder)) => {
                encoder.set_bitrate(avg_bitrate_bps, max_bitrate_bps)
            }
            None => Err(EncoderError::Unsupported(
                "bitrate changes before encoding starts",
            )),
        }
    }

    pub(crate) fn set_fps(&mut self, fps: f64) -> Result<(), EncoderError> {
        if self.active.is_some() {
            return Err(EncoderError::Unsupported(
                "live Windows frame-rate reconfiguration",
            ));
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
        let mf = |adapter: &Adapter| matches!(adapter, Adapter::Integrated);

        // Changing displays must not retain the discrete GPU's capabilities or
        // borrow H.264 support from the other display's integrated GPU.
        for (adapter, expected) in [
            (Adapter::Nvidia, vec![Codec::H264, Codec::H265, Codec::AV1]),
            (Adapter::Integrated, vec![Codec::H264]),
            (Adapter::WithoutHardwareEncoder, Vec::new()),
            (Adapter::Nvidia, vec![Codec::H264, Codec::H265, Codec::AV1]),
        ] {
            assert_eq!(
                probe_device_codecs(Preference::Auto, &adapter, nvenc, mf),
                expected,
            );
        }
        assert!(probe_device_codecs(Preference::Nvenc, &Adapter::Integrated, nvenc, mf).is_empty());
        assert!(
            probe_device_codecs(Preference::MediaFoundation, &Adapter::Nvidia, nvenc, mf)
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
        assert_eq!(
            select(Preference::Auto, Codec::H264, || Ok("nvenc"), mf).unwrap(),
            "nvenc"
        );
        assert!(!mf_called.get());
        let failed = || Err(EncoderError::Unsupported("NVENC device"));
        assert_eq!(
            select(Preference::Auto, Codec::H264, failed, mf).unwrap(),
            "mf"
        );
        for codec in [Codec::AV1, Codec::H265] {
            mf_called.set(false);
            assert!(select(Preference::Auto, codec, failed, mf).is_err());
            assert!(!mf_called.get(), "must not change the negotiated codec");
        }
    }

    #[test]
    fn explicit_selection_never_uses_the_other_backend() {
        let failed = || Err(EncoderError::Unsupported("unavailable"));
        let unexpected = || -> Result<(), EncoderError> { panic!("unexpected backend") };
        assert!(select(Preference::Nvenc, Codec::H264, failed, unexpected).is_err());
        assert!(select(Preference::MediaFoundation, Codec::H264, unexpected, failed).is_err());
        assert!(
            select(
                Preference::MediaFoundation,
                Codec::AV1,
                unexpected,
                unexpected
            )
            .is_err()
        );
        assert!(Preference::parse(Some("software")).is_err());
    }

    #[test]
    fn preserves_both_hardware_failures() {
        let error = select::<()>(
            Preference::Auto,
            Codec::H264,
            || Err(EncoderError::Platform("NVENC failed".into())),
            || Err(EncoderError::Platform("MF failed".into())),
        )
        .unwrap_err()
        .to_string();
        assert!(error.contains("NVENC failed"));
        assert!(error.contains("MF failed"));
    }
}
