//! Platform-neutral state and action contract for embedded native controls.

use crate::protocol::{Status, UiState};
use serde::{Deserialize, Serialize};

/// The toolbar's three dropdowns. At most one is open.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Panel {
    /// Input: pointer mode, keyboards, shortcuts, clipboard, and zoom.
    Control,
    /// Session: display, control permission, and connection.
    Config,
    /// Stream health: bitrate, frame rate, loss, and jitter.
    Monitor,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub(crate) struct ToolbarState {
    pub(crate) ui: UiState,
    pub(crate) mobile: bool,
    pub(crate) relative_mouse: bool,
    pub(crate) dragging: bool,
    pub(crate) collapsed: bool,
    pub(crate) keyboard_open: bool,
    pub(crate) hacker_open: bool,
    pub(crate) paste_shift: bool,
    /// One-shot modifiers: Control, Alt, Shift, Meta.
    pub(crate) modifiers: [bool; 4],
    pub(crate) keyboard_position: (f32, f32),
    pub(crate) keyboard_size: (f32, f32),
    pub(crate) paused: bool,
    pub(crate) reverse_scroll: bool,
    pub(crate) clipboard_sharing: bool,
    /// Mobile hosts present a local pinch zoom when enabled.
    pub(crate) pinch_zoom: bool,
    pub(crate) fullscreen: bool,
    pub(crate) dark: bool,
    pub(crate) panel: Option<Panel>,
    pub(crate) position: (f32, f32),
    pub(crate) toolbar_size: (f32, f32),
    pub(crate) viewport: (f32, f32),
    pub(crate) panel_position: (f32, f32),
    pub(crate) panel_height: f32,
}

impl Default for ToolbarState {
    fn default() -> Self {
        Self {
            ui: UiState::default(),
            mobile: false,
            relative_mouse: false,
            dragging: false,
            collapsed: false,
            keyboard_open: false,
            hacker_open: false,
            paste_shift: false,
            modifiers: [false; 4],
            keyboard_position: (12., 320.),
            keyboard_size: (520., 400.),
            paused: false,
            reverse_scroll: false,
            clipboard_sharing: true,
            pinch_zoom: true,
            fullscreen: false,
            dark: false,
            panel: None,
            position: (12., 12.),
            toolbar_size: (480., 42.),
            viewport: (960., 640.),
            panel_position: (12., 62.),
            panel_height: 204.,
        }
    }
}

impl ToolbarState {
    pub(crate) fn dark(&self) -> bool {
        match self.ui.theme.as_deref() {
            Some("dark") => true,
            Some("light") => false,
            _ => self.dark,
        }
    }

    pub(crate) fn controls_enabled(&self) -> bool {
        self.ui.status == Status::Connected
            && self.ui.control
            && self.ui.input_ready
            && !self.paused
    }
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq)]
#[serde(tag = "type", content = "value", rename_all = "camelCase")]
pub(crate) enum ToolbarAction {
    ToggleControl,
    ToggleMouseMode,
    ToggleDrag,
    ToggleCollapsed,
    SyncClipboard,
    Close,
    ToggleKeyboard,
    ToggleHackerKeyboard,
    SetPasteShift(bool),
    ToggleModifier(&'static str),
    Key(&'static str),
    KeyboardMeasured(f32, f32),
    /// One complete chord. Earlier codes are held while the last is pressed.
    Shortcut(&'static [&'static str]),
    ToggleFullscreen,
    /// Opens a panel, or closes it when it is already open.
    TogglePanel(Panel),
    SelectDisplay(u32),
    SetControl(bool),
    SetReverseScroll(bool),
    SetClipboardSharing(bool),
    SetPinchZoom(bool),
    ResetZoom,
    SecureAttention,
    Reconnect,
    Disconnect,
    Measured(f32, f32),
    PanelMeasured(f32),
    FocusHandle,
    BlurHandle,
    SelectOpen(bool),
}
