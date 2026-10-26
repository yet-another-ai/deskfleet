/// Encoded formats accepted by the existing desktop transport.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Codec {
    H264,
    H265,
    Av1,
}

impl Codec {
    pub const ALL: [Self; 3] = [Self::H264, Self::H265, Self::Av1];

    // Explicit hardware factories only. Never use encodebin or software fallback.
    // VA registers the normal or low-power factory according to driver support.
    pub(crate) fn factories(self) -> &'static [&'static str] {
        match self {
            Self::H264 => &["nvh264enc", "nvautogpuh264enc", "vah264enc", "vah264lpenc"],
            Self::H265 => &["nvh265enc", "nvautogpuh265enc", "vah265enc", "vah265lpenc"],
            Self::Av1 => &["nvav1enc", "nvautogpuav1enc", "vaav1enc", "vaav1lpenc"],
        }
    }

    pub(crate) fn parser(self) -> &'static str {
        match self {
            Self::H264 => "h264parse",
            Self::H265 => "h265parse",
            Self::Av1 => "av1parse",
        }
    }

    pub(crate) fn media_type(self) -> &'static str {
        match self {
            Self::H264 => "video/x-h264",
            Self::H265 => "video/x-h265",
            Self::Av1 => "video/x-av1",
        }
    }

    pub(crate) fn output_caps(self) -> &'static str {
        match self {
            Self::H264 => "video/x-h264,stream-format=byte-stream,alignment=au",
            Self::H265 => "video/x-h265,stream-format=byte-stream,alignment=au",
            Self::Av1 => "video/x-av1,stream-format=obu-stream,alignment=tu",
        }
    }

    pub(crate) fn accepts_profile(self, profile: &str) -> bool {
        match self {
            Self::H264 => matches!(profile, "constrained-baseline" | "main" | "high"),
            Self::H265 | Self::Av1 => profile == "main",
        }
    }
}

pub(crate) fn has_encoder(codec: Codec, has_factory: impl Fn(&str) -> bool) -> bool {
    ["appsrc", "appsink", "videoconvert", codec.parser()]
        .into_iter()
        .all(&has_factory)
        && codec.factories().iter().any(|name| has_factory(name))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codec_requires_its_parser_and_hardware_factory() {
        let installed = [
            "appsrc",
            "appsink",
            "videoconvert",
            "av1parse",
            "vaav1lpenc",
        ];
        let available = |name: &str| installed.contains(&name);
        assert!(has_encoder(Codec::Av1, available));
        assert!(!has_encoder(Codec::H264, available));
        assert!(!has_encoder(Codec::H265, available));
        assert!(!has_encoder(Codec::Av1, |name| name != "av1parse" && available(name)));
        assert!(!has_encoder(Codec::Av1, |name| name != "vaav1lpenc" && available(name)));
    }

    #[test]
    fn software_encoders_do_not_make_a_codec_available() {
        let installed = [
            "appsrc",
            "appsink",
            "videoconvert",
            "h264parse",
            "h265parse",
            "av1parse",
            "x264enc",
            "x265enc",
            "av1enc",
            "rav1enc",
            "svtav1enc",
        ];
        for codec in Codec::ALL {
            assert!(!has_encoder(codec, |name| installed.contains(&name)));
        }
    }
}
