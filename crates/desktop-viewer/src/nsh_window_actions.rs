//! GPUI effects for the shared control policy, plus desktop window geometry.

use super::*;
use deskfleet_viewer_controls::{ControlState, Effect};

impl Viewer {
    pub(super) fn action(
        &mut self,
        action: ToolbarAction,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let effects = ControlState::from(&self.toolbar_state).effects(&action);
        match action {
            ToolbarAction::KeyboardMeasured(w, h) if valid_size(w, h) => {
                self.toolbar_state.keyboard_size = (w, h);
            }
            ToolbarAction::Measured(w, h) if valid_size(w, h) => {
                self.toolbar_state.toolbar_size = (w, h);
                self.clamp_position(window);
            }
            ToolbarAction::PanelMeasured(h) if h.is_finite() && h > 0. => {
                self.toolbar_state.panel_height = h;
            }
            ToolbarAction::TogglePanel(panel) => {
                if self.toolbar_state.panel == Some(panel) {
                    self.toolbar_state.panel = None;
                    self.keyboard_focus.resume();
                    self.resume_focus(window, cx);
                } else {
                    self.toolbar_state.panel = Some(panel);
                }
            }
            ToolbarAction::ToggleCollapsed => {
                self.toolbar_state.collapsed = !self.toolbar_state.collapsed;
                self.toolbar_state.panel = None;
                self.select_open = false;
                if self.toolbar_state.collapsed {
                    self.keyboard_focus.resume();
                    self.resume_focus(window, cx);
                }
            }
            ToolbarAction::ToggleHackerKeyboard if self.toolbar_state.controls_enabled() => {
                self.toolbar_state.panel = None;
            }
            ToolbarAction::Reconnect
            | ToolbarAction::Disconnect
            | ToolbarAction::SelectDisplay(_) => {
                self.toolbar_state.panel = None;
            }
            ToolbarAction::FocusHandle => self.handle_focused = true,
            ToolbarAction::BlurHandle => self.handle_focused = false,
            ToolbarAction::SelectOpen(open) => self.select_open = open,
            _ => {}
        }
        self.apply_effects(effects, window, cx);
        self.sync_input(window, cx);
        cx.notify();
    }

    pub(super) fn apply_effects(
        &mut self,
        effects: Vec<Effect>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        for effect in effects {
            match effect {
                Effect::Release(preserve_modifiers) => {
                    if !preserve_modifiers {
                        self.toolbar_state.modifiers = [false; 4];
                    }
                    self.release(window, cx);
                }
                Effect::Paused(paused) => {
                    self.toolbar_state.paused = paused;
                    if !paused && self.toolbar_state.controls_enabled() {
                        self.keyboard_focus.resume();
                        self.resume_focus(window, cx);
                    }
                }
                Effect::HackerOpen(open) => {
                    self.toolbar_state.hacker_open = open;
                    if open {
                        self.toolbar_state.panel = None;
                        self.toolbar_state.keyboard_size = (520., 400.);
                    }
                }
                Effect::Modifiers(selected) => self.toolbar_state.modifiers = selected,
                Effect::Chord(codes) => {
                    let events = crate::nsh_keyboard::chord_events(&codes);
                    let clip = self.clipboard.before_events(
                        self.toolbar_state.clipboard_sharing,
                        &events,
                        cx,
                    );
                    if let Err(error) = self.controls.send_chord(&self.input, events, clip) {
                        self.fail(error, window, cx);
                        return;
                    }
                }
                Effect::Fullscreen(fullscreen) => {
                    if window.is_fullscreen() != fullscreen {
                        window.toggle_fullscreen();
                    }
                }
                Effect::ReverseScroll(on) => self.toolbar_state.reverse_scroll = on,
                Effect::ClipboardSharing(on) => {
                    self.toolbar_state.clipboard_sharing = on;
                    if on {
                        self.sync_local_clipboard(window, cx);
                    }
                }
                Effect::SyncClipboard => {
                    let event = self
                        .clipboard
                        .explicit(self.toolbar_state.controls_enabled(), cx);
                    self.send(event, window, cx);
                }
                Effect::SecureAttention => {
                    self.send([InputEvent::SecureAttention], window, cx);
                    self.keyboard_focus.resume();
                    self.resume_focus(window, cx);
                }
                Effect::Emit(event) => {
                    if let Err(error) = protocol::emit(event) {
                        self.fail(error, window, cx);
                        return;
                    }
                }
                Effect::Close => {
                    self.close(true, window, cx);
                    return;
                }
                Effect::Keyboard(_)
                | Effect::PinchZoom(_)
                | Effect::ResetZoom
                | Effect::RelativeMouse(_)
                | Effect::DragButton(_)
                | Effect::ResetPointer
                | Effect::PasteShift(_) => {}
            }
        }
    }
}

fn valid_size(width: f32, height: f32) -> bool {
    width.is_finite() && height.is_finite() && width > 0. && height > 0.
}
