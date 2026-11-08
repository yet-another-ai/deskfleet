//! The native surface uses the desktop UI's translations and color tokens.

use std::collections::HashMap;
use std::sync::OnceLock;

use nsh_core::element::ImageSrc;
use nsh_core::prelude::*;

use crate::protocol::{Codec, Status, UiState};

#[derive(Clone, Copy)]
pub(crate) struct Palette {
    pub(crate) surface: u32,
    pub(crate) control: u32,
    pub(crate) hover: u32,
    pub(crate) border: u32,
    pub(crate) text: u32,
    pub(crate) muted: u32,
    pub(crate) faint: u32,
    pub(crate) success: u32,
    pub(crate) danger: u32,
    pub(crate) accent: u32,
}

impl Palette {
    pub(crate) fn new(dark: bool) -> Self {
        // packages/components/src/theme-tokens.css owns these design tokens.
        if dark {
            Self {
                surface: 0x1f222a,
                control: 0x23262f,
                hover: 0x2a2e38,
                border: 0x2c303a,
                text: 0xe7e9ef,
                muted: 0xa3a9b7,
                faint: 0x7c8393,
                success: 0x4cc38a,
                danger: 0xf47c71,
                accent: 0x8e9bff,
            }
        } else {
            Self {
                surface: 0xffffff,
                control: 0xffffff,
                hover: 0xf3f4f8,
                border: 0xe3e6ed,
                text: 0x1b1f2b,
                muted: 0x596173,
                faint: 0x838a9a,
                success: 0x167a4a,
                danger: 0xc4372f,
                accent: 0x4a5bd4,
            }
        }
    }
}

pub(crate) fn label(locale: Option<&str>, key: &str) -> String {
    static EN: OnceLock<HashMap<String, String>> = OnceLock::new();
    static ZH: OnceLock<HashMap<String, String>> = OnceLock::new();
    static JA: OnceLock<HashMap<String, String>> = OnceLock::new();
    let (slot, source) = match locale {
        Some(locale) if locale.starts_with("zh") => (
            &ZH,
            include_str!("../../../packages/components/locales/zh-cmn-Hans-CN.json"),
        ),
        Some(locale) if locale.starts_with("ja") => (
            &JA,
            include_str!("../../../packages/components/locales/ja-JP.json"),
        ),
        _ => (
            &EN,
            include_str!("../../../packages/components/locales/en-US.json"),
        ),
    };
    slot.get_or_init(|| {
        let mut locales: serde_json::Value =
            serde_json::from_str(source).expect("repository locale is valid JSON");
        serde_json::from_value(locales["desktop"].take()).expect("desktop translations are strings")
    })
    .get(key)
    .expect("desktop translation exists")
    .clone()
}

pub(crate) fn codec_label(codec: Option<Codec>) -> &'static str {
    match codec {
        Some(Codec::H264) => "H.264",
        Some(Codec::H265) => "HEVC",
        Some(Codec::Av1) => "AV1",
        None => "",
    }
}

pub(crate) fn status(ui: &UiState) -> String {
    let key = match ui.status {
        Status::Connecting => "connecting",
        Status::Starting => "starting",
        Status::Connected => "connected",
        Status::Disconnected => "ready",
        Status::Error => "connectionFailed",
    };
    label(ui.locale.as_deref(), key).replace("{codec}", codec_label(ui.codec))
}

/// The same Lucide paths used by DesktopView.vue; see ../LICENSE-lucide.
pub(crate) fn icon(name: &str, color: u32, extent: f32) -> impl IntoElement + use<> {
    let paths = match name {
        "grip" => {
            r#"<circle cx="9" cy="5" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="9" cy="19" r="1"/><circle cx="15" cy="5" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="15" cy="19" r="1"/>"#
        }
        "maximize" => {
            r#"<path d="M8 3H5a2 2 0 0 0-2 2v3m13-5h3a2 2 0 0 1 2 2v3M3 16v3a2 2 0 0 0 2 2h3m13-5v3a2 2 0 0 1-2 2h-3"/>"#
        }
        "minimize" => {
            r#"<path d="M8 3v3a2 2 0 0 1-2 2H3m13-5v3a2 2 0 0 0 2 2h3M3 16h3a2 2 0 0 1 2 2v3m13-5h-3a2 2 0 0 0-2 2v3"/>"#
        }
        "settings" => {
            r#"<path d="M21 4h-7m-4 0H3m18 8h-9m-4 0H3m18 8h-5m-4 0H3M14 2v4M8 10v4m8 4v4"/>"#
        }
        "unplug" => {
            r#"<path d="m19 5 3-3M2 22l3-3m1-17 2 2m12 12 2 2M9 7l8 8m-3-3 2-2M7 9l-2 2a4 4 0 0 0 0 6l2 2a4 4 0 0 0 6 0l2-2m-4-7 2-2"/>"#
        }
        "chevron" => r#"<path d="m6 9 6 6 6-6"/>"#,
        "check" => r#"<path d="m9 12 2 2 4-4"/>"#,
        _ => {
            r#"<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M12 17v4m-4 0h8m-5-14 5 3-5 3z"/>"#
        }
    };
    let markup = format!(
        r##"<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#{color:06x}" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">{paths}</svg>"##
    );
    svg(ImageSrc::svg_markup(&markup))
        .w(px(extent))
        .h(px(extent))
        .flex_shrink_0()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_controls_use_the_shared_desktop_translations() {
        for locale in ["en-US", "zh-cmn-Hans-CN", "ja-JP"] {
            for key in [
                "pauseControl",
                "resumeControl",
                "settings",
                "displayOption",
                "control",
                "disconnect",
                "connect",
                "moveControls",
            ] {
                assert!(!label(Some(locale), key).is_empty());
            }
        }
        let ui = UiState {
            codec: Some(Codec::H265),
            status: Status::Connected,
            ..UiState::default()
        };
        assert_eq!(status(&ui), "Connected · HEVC");
    }
}
