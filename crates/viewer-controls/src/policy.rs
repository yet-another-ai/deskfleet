use serde::{Deserialize, Serialize};

use crate::{Action, Status};

pub const MODIFIERS: [&str; 4] = ["ControlLeft", "AltLeft", "ShiftLeft", "MetaLeft"];

#[derive(Clone, Copy, Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct InputAvailability {
    pub status: Status,
    pub control: bool,
    pub input_ready: bool,
    pub secure_attention: bool,
}

impl InputAvailability {
    pub fn available(self) -> bool {
        self.status == Status::Connected && self.control && self.input_ready
    }
}

/// Only window state that can change the interpretation of a user action.
#[derive(Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ControlState {
    pub ui: InputAvailability,
    pub mobile: bool,
    pub paused: bool,
    pub relative_mouse: bool,
    pub dragging: bool,
    pub hacker_open: bool,
    pub keyboard_open: bool,
    pub modifiers: [bool; 4],
    pub fullscreen: bool,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum HostEvent {
    SelectDisplay { display_id: u32 },
    SetControl { control: bool },
    Reconnect,
    Disconnect,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(tag = "type", content = "value", rename_all = "camelCase")]
pub enum Effect {
    /// Release remote input, optionally preserving the locally selected IME modifiers.
    Release(bool),
    Paused(bool),
    RelativeMouse(bool),
    DragButton(bool),
    ResetPointer,
    HackerOpen(bool),
    Modifiers([bool; 4]),
    /// A single ordered input batch, beginning with release-all.
    Chord(Vec<String>),
    Fullscreen(bool),
    Keyboard(bool),
    PasteShift(bool),
    ReverseScroll(bool),
    ClipboardSharing(bool),
    SyncClipboard,
    PinchZoom(bool),
    ResetZoom,
    SecureAttention,
    Emit(HostEvent),
    Close,
}

impl ControlState {
    pub fn effects<Key: AsRef<str>, Chord: AsRef<[Key]>>(
        &self,
        action: &Action<Key, Chord>,
    ) -> Vec<Effect> {
        use Effect as E;
        let available = self.ui.available();
        let enabled = available && !self.paused;
        match action {
            Action::SessionChanged {
                was_enabled,
                display_changed,
            } => {
                let mut effects = Vec::new();
                if (*was_enabled && !enabled) || *display_changed {
                    effects.extend([E::Release(false), E::Keyboard(false), E::HackerOpen(false)]);
                }
                if self.paused && !available {
                    effects.push(E::Paused(false));
                }
                if *display_changed && self.mobile {
                    effects.push(E::ResetPointer);
                }
                effects
            }
            Action::ToggleControl if available => {
                let mut effects = vec![E::Release(false), E::Paused(!self.paused)];
                if !self.paused {
                    effects.extend([E::HackerOpen(false), E::Keyboard(false)]);
                }
                effects
            }
            Action::ToggleMouseMode if self.mobile && enabled => {
                vec![
                    E::Release(false),
                    E::RelativeMouse(!self.relative_mouse),
                    E::ResetPointer,
                ]
            }
            Action::ToggleDrag if self.mobile && enabled => {
                if self.dragging {
                    return vec![E::DragButton(false)];
                }
                let mut effects = vec![E::Release(false)];
                if !self.relative_mouse {
                    effects.extend([E::RelativeMouse(true), E::ResetPointer]);
                }
                effects.push(E::DragButton(true));
                effects
            }
            Action::ToggleKeyboard if self.mobile && enabled => {
                vec![E::Release(true), E::Keyboard(!self.keyboard_open)]
            }
            Action::ToggleHackerKeyboard if enabled => {
                vec![E::Release(false), E::HackerOpen(!self.hacker_open)]
            }
            Action::ToggleModifier(code) if enabled => {
                let mut selected = self.modifiers;
                if let Some(index) = MODIFIERS.iter().position(|key| *key == code.as_ref()) {
                    selected[index] = !selected[index];
                    vec![E::Modifiers(selected)]
                } else {
                    vec![]
                }
            }
            Action::Key(key) if enabled => {
                let mut codes: Vec<_> = MODIFIERS
                    .into_iter()
                    .zip(self.modifiers)
                    .filter(|(_, down)| *down)
                    .map(|(code, _)| code.to_owned())
                    .collect();
                codes.push(key.as_ref().to_owned());
                vec![E::Modifiers([false; 4]), E::Chord(codes)]
            }
            Action::Shortcut(codes) if enabled && !codes.as_ref().is_empty() => {
                vec![
                    E::Modifiers([false; 4]),
                    E::Chord(
                        codes
                            .as_ref()
                            .iter()
                            .map(|k| k.as_ref().to_owned())
                            .collect(),
                    ),
                ]
            }
            Action::SecureAttention if enabled && self.ui.secure_attention => {
                vec![E::SecureAttention]
            }
            Action::SyncClipboard if enabled => vec![E::SyncClipboard],
            Action::ToggleFullscreen => vec![E::Fullscreen(!self.fullscreen)],
            Action::SetReverseScroll(on) if enabled => vec![E::ReverseScroll(*on)],
            Action::SetPasteShift(on) if self.mobile && enabled => vec![E::PasteShift(*on)],
            Action::SetClipboardSharing(on) => vec![E::ClipboardSharing(*on)],
            Action::SetPinchZoom(on) if self.mobile => {
                if *on {
                    vec![E::PinchZoom(true)]
                } else {
                    vec![E::PinchZoom(false), E::ResetZoom]
                }
            }
            Action::ResetZoom if self.mobile => vec![E::ResetZoom],
            Action::SelectDisplay(id) => vec![
                E::Release(false),
                E::Emit(HostEvent::SelectDisplay { display_id: *id }),
            ],
            Action::SetControl(control) => {
                let mut effects = vec![E::Release(false)];
                if self.paused {
                    effects.push(E::Paused(false));
                }
                effects.push(E::Emit(HostEvent::SetControl { control: *control }));
                effects
            }
            Action::Reconnect | Action::Disconnect => {
                let event = if matches!(action, Action::Reconnect) {
                    HostEvent::Reconnect
                } else {
                    HostEvent::Disconnect
                };
                vec![E::Release(false), E::HackerOpen(false), E::Emit(event)]
            }
            Action::TogglePanel(_) | Action::ToggleCollapsed => {
                vec![E::Release(false), E::HackerOpen(false)]
            }
            Action::FocusHandle | Action::SelectOpen(true) => vec![E::Release(false)],
            Action::Close => vec![E::Close],
            _ => vec![],
        }
    }
}
