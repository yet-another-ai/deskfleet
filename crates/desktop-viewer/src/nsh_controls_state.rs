//! Platform-neutral state and action contract for embedded native controls.

use crate::protocol::UiState;
use deskfleet_viewer_controls::InputAvailability;
pub(crate) use deskfleet_viewer_controls::{Panel, ToolbarAction};
use serde::Deserialize;

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
        self.input_availability().available() && !self.paused
    }

    pub(crate) fn input_availability(&self) -> InputAvailability {
        InputAvailability {
            status: self.ui.status,
            control: self.ui.control,
            input_ready: self.ui.input_ready,
            secure_attention: self.ui.secure_attention,
        }
    }
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
impl From<&ToolbarState> for deskfleet_viewer_controls::ControlState {
    fn from(state: &ToolbarState) -> Self {
        Self {
            ui: state.input_availability(),
            mobile: state.mobile,
            paused: state.paused,
            relative_mouse: state.relative_mouse,
            dragging: state.dragging,
            hacker_open: state.hacker_open,
            keyboard_open: state.keyboard_open,
            modifiers: state.modifiers,
            fullscreen: state.fullscreen,
        }
    }
}
