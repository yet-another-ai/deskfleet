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
    /// Degraded stream quality; always shown beside a text label.
    pub(crate) warning: u32,
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
                warning: 0xe8c547,
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
                warning: 0x9a7a00,
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

pub(crate) fn display_label(
    locale: Option<&str>,
    display: &crate::protocol::Display,
    index: usize,
) -> String {
    let number = display
        .display_number
        .map_or_else(|| (index + 1).to_string(), |number| number.to_string());
    let mut title = label(locale, "displayName").replace("{number}", &number);
    if let Some(name) = &display.name {
        title.push_str(" · ");
        title.push_str(name);
    }
    label(locale, "displayOption")
        .replace("{width}", &display.width.to_string())
        .replace("{height}", &display.height.to_string())
        .replace("{display}", &title)
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
        "pause" => r#"<path d="M8 5v14m8-14v14"/>"#,
        "play" => r#"<path d="m8 5 11 7-11 7z"/>"#,
        "pointer" => r#"<path d="m4 3 7 18 3-7 7-3z"/>"#,
        "trackpad" => {
            r#"<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M3 15h18m-9 0v5"/>"#
        }
        "keyboard" => {
            r#"<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M6 9h.01M10 9h.01M14 9h.01M18 9h.01M6 13h.01M10 13h.01M14 13h.01M18 13h.01M7 16h10"/>"#
        }
        "terminal" => {
            r#"<rect x="2" y="3" width="20" height="18" rx="2"/><path d="m6 8 4 4-4 4m7 0h5"/>"#
        }
        "close" => r#"<path d="m6 6 12 12M6 18 18 6"/>"#,
        "collapse" => r#"<path d="M5 12h14"/>"#,
        "expand" => r#"<path d="M5 12h14m-7-7v14"/>"#,
        "chevron" => r#"<path d="m6 9 6 6 6-6"/>"#,
        "check" => r#"<path d="m9 12 2 2 4-4"/>"#,
        "activity" => {
            r#"<path d="M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2"/>"#
        }
        "mouse" => r#"<rect x="5" y="2" width="14" height="20" rx="7"/><path d="M12 6v4"/>"#,
        "zoom" => r#"<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3M11 8v6M8 11h6"/>"#,
        "clipboard" => {
            r#"<rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>"#
        }
        "command" => {
            r#"<path d="M15 6v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3"/>"#
        }
        "eye" => {
            r#"<path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/>"#
        }
        "refresh" => {
            r#"<path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/>"#
        }
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

    const CONTROL_ICONS: [&str; 24] = [
        "grip",
        "maximize",
        "minimize",
        "settings",
        "unplug",
        "chevron",
        "check",
        "monitor",
        "pause",
        "play",
        "pointer",
        "trackpad",
        "keyboard",
        "terminal",
        "close",
        "collapse",
        "expand",
        "activity",
        "mouse",
        "zoom",
        "clipboard",
        "command",
        "eye",
        "refresh",
    ];

    #[component]
    fn ControlIcons() -> impl IntoElement {
        let mut row = view().flex_row();
        for name in CONTROL_ICONS {
            row = row.child(icon(name, Palette::new(true).muted, 16.));
        }
        row
    }

    #[test]
    fn native_control_icons_emit_drawings_on_first_mount() {
        use nsh_core::{ApproxTextEngine, Core, MountItem, canvas::CanvasOp, element::Root};

        let mut core = Core::new(ApproxTextEngine, size(px(320.), px(48.)));
        core.mount_root(&Root::of::<ControlIcons>());
        let mount = core.commit().expect("icon row mounted");
        let drawn = mount.items.iter().filter(|item| {
            matches!(item, MountItem::Canvas { drawing, .. }
                if drawing.ops.iter().any(|op| matches!(op, CanvasOp::Stroke(_))))
        });
        assert_eq!(drawn.count(), CONTROL_ICONS.len());
    }

    #[test]
    fn native_controls_use_the_shared_desktop_translations() {
        for locale in ["en-US", "zh-cmn-Hans-CN", "ja-JP"] {
            for key in [
                "settings",
                "display",
                "displayOption",
                "displayName",
                "control",
                "reverseScroll",
                "clipboard",
                "disconnect",
                "connect",
                "moveControls",
                "hackerKeyboard",
                "keyboardModifiersHint",
                "systemKeyboard",
                "hideKeyboard",
                "terminalPaste",
                "dragMouse",
                "syncClipboard",
                "close",
                "collapseControls",
                "expandControls",
                "fullscreen",
                "exitFullscreen",
                "sendSecureAttention",
                "panelControl",
                "panelConfig",
                "panelMonitor",
                "viewOnly",
                "controlPaused",
                "sendInput",
                "sendInputHint",
                "viewOnlyHint",
                "allowControl",
                "inputWaiting",
                "touch",
                "touchDirect",
                "touchTrackpad",
                "pinchZoom",
                "zoom",
                "resetZoom",
                "mouse",
                "keyboard",
                "shortcuts",
                "clipboardSection",
                "session",
                "reconnect",
                "qualityWaiting",
                "qualityGood",
                "qualityFair",
                "qualityPoor",
                "bitrate",
                "frameRate",
                "packetLoss",
                "jitter",
                "resolution",
                "codec",
                "skippedFrames",
                "keyframeRequests",
                "packetsLost",
                "monitorHint",
                "hidePanel",
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

    #[test]
    fn display_labels_keep_session_handles_out_of_user_facing_numbers() {
        let windows: crate::protocol::Display = serde_json::from_str(
            r#"{"id":65537,"displayNumber":2,"name":"Dell U2723QE (DP-1)","width":3840,"height":2160}"#,
        )
        .unwrap();
        assert_eq!(
            display_label(Some("en-US"), &windows, 0),
            "Display 2 · Dell U2723QE (DP-1) · 3840 × 2160"
        );
        let wayland: crate::protocol::Display =
            serde_json::from_str(r#"{"id":4,"width":1920,"height":1080}"#).unwrap();
        assert_eq!(
            display_label(Some("zh-cmn-Hans-CN"), &wayland, 1),
            "显示器 2 · 1920 × 1080"
        );
        assert_eq!(windows.id, 65537);
        assert_eq!(wayland.id, 4);
    }
}
