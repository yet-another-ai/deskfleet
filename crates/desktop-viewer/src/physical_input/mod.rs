//! Physical keyboard capture on the existing GPUI window, before layout/IME.
//!
//! Native callbacks enqueue events behind the same gate that local UI updates.
//! Disabling clears queued presses, so a delayed wake cannot leak into a session.

use std::collections::{HashSet, VecDeque};
use std::sync::{Arc, Mutex, MutexGuard};

use deskfleet_input::{InputEvent, NativeKeyCode};

use crate::Error;

#[cfg(target_os = "linux")]
#[path = "linux.rs"]
mod platform;
#[cfg(target_os = "macos")]
#[path = "macos.rs"]
mod platform;
#[cfg(target_os = "windows")]
#[path = "windows.rs"]
mod platform;
#[cfg(target_os = "linux")]
mod wayland;
#[cfg(target_os = "linux")]
mod x11;

pub(crate) struct PhysicalInput {
    // Native hooks/foreign display queues must stop while the GPUI window lives.
    _platform: platform::Adapter,
    bridge: Bridge,
}

impl PhysicalInput {
    pub(crate) fn new(
        window: &gpui::Window,
        wake: impl Fn() + Send + Sync + 'static,
    ) -> Result<Self, Error> {
        let bridge = Bridge {
            state: Arc::new(Mutex::new(State::default())),
            wake: Arc::new(wake),
        };
        let platform = platform::Adapter::new(window, bridge.clone())?;
        Ok(Self {
            _platform: platform,
            bridge,
        })
    }

    /// The host releases remote controls before disabling this gate.
    pub(crate) fn set_enabled(&self, enabled: bool) {
        #[cfg(target_os = "macos")]
        if enabled && !self.bridge.enabled() {
            self._platform.refresh_modifiers();
        }
        self.bridge.set_enabled(enabled);
    }

    /// The OS may deliver releases to another window while this one is blurred.
    pub(crate) fn focus_lost(&self) {
        self.bridge.reset();
    }

    pub(crate) fn poll(&self) -> Result<Vec<InputEvent>, Error> {
        let mut state = self.bridge.state();
        if let Some(error) = state.failure.take() {
            return Err(error.into());
        }
        Ok(state.pending.drain(..).collect())
    }
}

#[derive(Default)]
struct State {
    enabled: bool,
    held: HashSet<&'static str>,
    forwarded: HashSet<&'static str>,
    pending: VecDeque<InputEvent>,
    failure: Option<String>,
}

#[derive(Clone)]
struct Bridge {
    state: Arc<Mutex<State>>,
    wake: Arc<dyn Fn() + Send + Sync>,
}

impl Bridge {
    fn state(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|error| error.into_inner())
    }

    fn set_enabled(&self, enabled: bool) {
        let mut state = self.state();
        if state.enabled == enabled {
            return;
        }
        state.enabled = enabled;
        state.pending.clear();
        state.forwarded.clear();
        if enabled {
            // Modifiers held while focus returns retain their physical sides.
            let modifiers: Vec<_> = state
                .held
                .iter()
                .copied()
                .filter(|code| is_modifier(code))
                .collect();
            for code in modifiers {
                state.forwarded.insert(code);
                state.pending.push_back(key(code, true, false));
            }
        }
        let wake = !state.pending.is_empty();
        drop(state);
        if wake {
            (self.wake)();
        }
    }

    #[cfg(any(target_os = "macos", target_os = "windows"))]
    fn enabled(&self) -> bool {
        self.state().enabled
    }

    fn key(&self, native: NativeKeyCode, pressed: bool, repeat: bool) {
        let Some(code) = native.code() else { return };
        let mut state = self.state();
        if pressed {
            state.held.insert(code);
        } else {
            state.held.remove(code);
        }
        if !state.enabled {
            return;
        }
        let repeat = if pressed {
            let was_pressed = state.forwarded.contains(code);
            // A release/pause revoked ownership of this press. Its remaining
            // typematic events must not start a new press after resuming.
            if repeat && !was_pressed || was_pressed && !repeat {
                return;
            }
            state.forwarded.insert(code);
            repeat
        } else {
            if !state.forwarded.remove(code) {
                return;
            }
            false
        };
        let wake = state.pending.is_empty();
        state.pending.push_back(key(code, pressed, repeat));
        drop(state);
        if wake {
            (self.wake)();
        }
    }

    fn reset(&self) {
        let mut state = self.state();
        state.held.clear();
        state.forwarded.clear();
        state.pending.clear();
        if state.enabled {
            state.pending.push_back(InputEvent::ReleaseAll);
        }
        let wake = !state.pending.is_empty();
        drop(state);
        if wake {
            (self.wake)();
        }
    }

    #[cfg(target_os = "linux")]
    fn fail(&self, error: impl std::fmt::Display) {
        self.reset();
        self.state().failure = Some(error.to_string());
        (self.wake)();
    }
}

fn key(code: &str, pressed: bool, repeat: bool) -> InputEvent {
    InputEvent::Key {
        code: code.into(),
        pressed,
        repeat,
    }
}

fn is_modifier(code: &str) -> bool {
    matches!(
        code,
        "ControlLeft"
            | "ControlRight"
            | "AltLeft"
            | "AltRight"
            | "ShiftLeft"
            | "ShiftRight"
            | "MetaLeft"
            | "MetaRight"
            | "Fn"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resuming_restores_the_held_modifier_side_without_replaying_local_keys() {
        let bridge = Bridge {
            state: Arc::new(Mutex::new(State::default())),
            wake: Arc::new(|| {}),
        };
        let right_control = if cfg!(target_os = "macos") {
            NativeKeyCode::MacOs(0x3e)
        } else if cfg!(target_os = "windows") {
            NativeKeyCode::Windows {
                scan_code: 0x1d,
                extended: true,
            }
        } else {
            NativeKeyCode::Evdev(97)
        };
        bridge.key(right_control, true, false);
        assert!(bridge.state().pending.is_empty());
        bridge.set_enabled(true);
        assert_eq!(
            bridge.state().pending.iter().cloned().collect::<Vec<_>>(),
            vec![key("ControlRight", true, false)]
        );
        bridge.set_enabled(false);
        bridge.key(right_control, false, false);
        bridge.set_enabled(true);
        assert!(bridge.state().pending.is_empty());
    }

    #[test]
    fn delayed_presses_are_cleared_and_repeats_keep_physical_positions() {
        let bridge = Bridge {
            state: Arc::new(Mutex::new(State::default())),
            wake: Arc::new(|| {}),
        };
        bridge.set_enabled(true);
        let native = if cfg!(target_os = "macos") {
            NativeKeyCode::MacOs(0x4c)
        } else if cfg!(target_os = "windows") {
            NativeKeyCode::Windows {
                scan_code: 0x1c,
                extended: true,
            }
        } else {
            NativeKeyCode::Evdev(96)
        };
        bridge.key(native, true, false);
        bridge.key(native, true, false);
        bridge.key(native, true, true);
        bridge.key(native, false, false);
        assert_eq!(
            bridge.state().pending.iter().cloned().collect::<Vec<_>>(),
            vec![
                key("NumpadEnter", true, false),
                key("NumpadEnter", true, true),
                key("NumpadEnter", false, false),
            ]
        );
        bridge.set_enabled(false);
        assert!(bridge.state().pending.is_empty());
        bridge.key(native, true, false);
        assert!(bridge.state().pending.is_empty());
        bridge.set_enabled(true);
        // Re-enabling does not replay an ordinary key held in local UI.
        assert!(bridge.state().pending.is_empty());
        bridge.key(native, true, true);
        assert!(bridge.state().pending.is_empty());
        bridge.reset();
        assert_eq!(
            bridge.state().pending.iter().cloned().collect::<Vec<_>>(),
            vec![InputEvent::ReleaseAll]
        );
    }
}
