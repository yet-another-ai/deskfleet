//! The Control panel: everything that decides what input reaches the remote
//! desktop, and how.

use nsh_base::button;
use nsh_core::prelude::*;

use super::bar::Mode;
use super::widgets::{Choice, action_button, note, section, segmented, shell, toggle_row};
use super::{Live, Panel, ToolbarAction, ToolbarState, control_extent, emit};
use crate::nsh_ui::{Palette, icon, label};

/// Chords sent as one press. Labels follow the remote platform's notation.
type Shortcut = (&'static str, &'static [&'static str]);

const MAC: &[Shortcut] = &[
    ("⌘ Tab", &["MetaLeft", "Tab"]),
    ("⌘ Space", &["MetaLeft", "Space"]),
    ("⌃ ↑", &["ControlLeft", "ArrowUp"]),
    ("⌘ Q", &["MetaLeft", "KeyQ"]),
];
const WINDOWS: &[Shortcut] = &[
    ("Alt Tab", &["AltLeft", "Tab"]),
    ("Win", &["MetaLeft"]),
    ("Win D", &["MetaLeft", "KeyD"]),
    ("Ctrl Shift Esc", &["ControlLeft", "ShiftLeft", "Escape"]),
    ("Alt F4", &["AltLeft", "F4"]),
];
const LINUX: &[Shortcut] = &[
    ("Alt Tab", &["AltLeft", "Tab"]),
    ("Super", &["MetaLeft"]),
    ("Alt F4", &["AltLeft", "F4"]),
];

pub(super) fn shortcuts(platform: Option<&str>) -> &'static [Shortcut] {
    match platform {
        Some("darwin") => MAC,
        Some("win32") => WINDOWS,
        _ => LINUX,
    }
}

fn chip(title: String, action: ToolbarAction, disabled: bool, p: Palette) -> impl IntoElement {
    button()
        .h(px(control_extent(28.)))
        .px(px(10.))
        .items_center()
        .justify_center()
        .rounded(px(6.))
        .border_1()
        .border_color(rgb(p.border))
        .bg(rgb(p.control))
        .hover(move |s| s.bg(rgb(p.hover)))
        .accessibility_label(title.clone())
        .disabled(disabled)
        .disabled_style(|s| s.opacity(0.4))
        .on_press(move || emit(action))
        .child(text(title).text_size(px(12.)).text_color(rgb(p.text)))
}

fn send_input(state: &ToolbarState, p: Palette) -> impl IntoElement + use<> {
    let ui = &state.ui;
    let locale = ui.locale.as_deref();
    let mut block = view().gap(px(6.));
    if Mode::of(state) == Mode::ViewOnly {
        return block
            .child(
                view()
                    .flex_row()
                    .items_center()
                    .gap(px(8.))
                    .child(icon("eye", p.muted, 16.))
                    .child(note(label(locale, "viewOnlyHint"), p.muted)),
            )
            .child(action_button(
                label(locale, "allowControl"),
                ToolbarAction::SetControl(true),
                p,
                false,
            ));
    }
    block = block.child(toggle_row(
        label(locale, "sendInput"),
        !state.paused,
        !ui.input_ready,
        |_| ToolbarAction::ToggleControl,
        p,
    ));
    let (key, color) = if ui.input_ready {
        ("sendInputHint", p.muted)
    } else {
        ("inputWaiting", p.faint)
    };
    block.child(note(label(locale, key), color))
}

fn zoom_row(scale: f64, locale: Option<&str>, p: Palette) -> impl IntoElement + use<> {
    view()
        .flex_row()
        .items_center()
        .gap(px(8.))
        .min_h(px(control_extent(32.)))
        .child(icon("zoom", p.muted, 14.))
        .child(
            text(label(locale, "zoom"))
                .flex_1()
                .text_size(px(13.))
                .text_color(rgb(p.text)),
        )
        .child(
            text(format!("{scale:.1}×"))
                .text_size(px(13.))
                .tabular_nums()
                .text_color(rgb(p.muted)),
        )
        .child(action_button(
            label(locale, "resetZoom"),
            ToolbarAction::ResetZoom,
            p,
            scale <= 1.01,
        ))
}

fn pointer(state: &ToolbarState, live: Live, p: Palette) -> impl IntoElement + use<> {
    let locale = state.ui.locale.as_deref();
    let disabled = !state.controls_enabled();
    if !state.mobile {
        return section(label(locale, "mouse"), p).child(toggle_row(
            label(locale, "reverseScroll"),
            state.reverse_scroll,
            disabled,
            ToolbarAction::SetReverseScroll,
            p,
        ));
    }
    let mut touch = section(label(locale, "touch"), p)
        .child(segmented(
            vec![
                Choice {
                    title: label(locale, "touchDirect"),
                    icon: "pointer",
                    selected: !state.relative_mouse,
                    action: ToolbarAction::ToggleMouseMode,
                },
                Choice {
                    title: label(locale, "touchTrackpad"),
                    icon: "trackpad",
                    selected: state.relative_mouse,
                    action: ToolbarAction::ToggleMouseMode,
                },
            ],
            disabled,
            p,
        ))
        .child(toggle_row(
            label(locale, "dragMouse"),
            state.dragging,
            disabled,
            |_| ToolbarAction::ToggleDrag,
            p,
        ))
        .child(toggle_row(
            label(locale, "reverseScroll"),
            state.reverse_scroll,
            disabled,
            ToolbarAction::SetReverseScroll,
            p,
        ))
        // Zoom is local presentation, so it works in view-only sessions.
        .child(toggle_row(
            label(locale, "pinchZoom"),
            state.pinch_zoom,
            false,
            ToolbarAction::SetPinchZoom,
            p,
        ));
    if state.pinch_zoom {
        let locale = state.ui.locale.clone();
        touch = touch.child(dynamic(move || {
            zoom_row(live.zoom.get(), locale.as_deref(), p)
        }));
    }
    touch
}

fn keyboard(state: &ToolbarState, p: Palette) -> impl IntoElement + use<> {
    let ui = &state.ui;
    let locale = ui.locale.as_deref();
    let disabled = !state.controls_enabled();
    let mut keys = section(label(locale, "keyboard"), p);
    if state.mobile {
        keys = keys.child(toggle_row(
            label(locale, "systemKeyboard"),
            state.keyboard_open,
            disabled,
            |_| ToolbarAction::ToggleKeyboard,
            p,
        ));
    }
    keys = keys.child(toggle_row(
        label(locale, "hackerKeyboard"),
        state.hacker_open,
        disabled,
        |_| ToolbarAction::ToggleHackerKeyboard,
        p,
    ));
    if state.mobile && ui.platform.as_deref() != Some("darwin") {
        keys = keys.child(toggle_row(
            label(locale, "terminalPaste"),
            state.paste_shift,
            disabled,
            ToolbarAction::SetPasteShift,
            p,
        ));
    }
    let mut chips = view().flex_row().flex_wrap().gap(px(6.)).pt(px(4.));
    for &(title, codes) in shortcuts(ui.platform.as_deref()) {
        chips = chips.child(chip(
            title.into(),
            ToolbarAction::Shortcut(codes),
            disabled,
            p,
        ));
    }
    if ui.secure_attention {
        chips = chips.child(chip(
            label(locale, "sendSecureAttention"),
            ToolbarAction::SecureAttention,
            disabled,
            p,
        ));
    }
    keys.child(
        view()
            .gap(px(2.))
            .pt(px(4.))
            .child(note(label(locale, "shortcuts"), p.muted))
            .child(chips),
    )
}

fn clipboard(state: &ToolbarState, p: Palette) -> impl IntoElement + use<> {
    let locale = state.ui.locale.as_deref();
    let clipboard = section(label(locale, "clipboardSection"), p).child(toggle_row(
        label(locale, "clipboard"),
        state.clipboard_sharing,
        false,
        ToolbarAction::SetClipboardSharing,
        p,
    ));
    clipboard.child(action_button(
        label(locale, "syncClipboard"),
        ToolbarAction::SyncClipboard,
        p,
        !state.controls_enabled(),
    ))
}

pub(super) fn panel(state: &ToolbarState, live: Live, p: Palette) -> impl IntoElement + use<> {
    let locale = state.ui.locale.as_deref();
    let mut body = view().gap(px(14.)).child(send_input(state, p));
    if state.ui.control {
        body = body
            .child(pointer(state, live, p))
            .child(keyboard(state, p))
            .child(clipboard(state, p));
    } else if state.mobile {
        body = body.child(pointer(state, live, p));
    }
    shell(
        state,
        Panel::Control,
        label(locale, "panelControl"),
        label(locale, "hidePanel"),
        None,
        body,
        p,
    )
}
