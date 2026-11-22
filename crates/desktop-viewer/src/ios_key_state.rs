//! Track physical keys and the modifier flags UIKit reports with each press.

use std::collections::HashSet;

use deskfleet_input::InputEvent;

const SIDES: [(&str, &str); 4] = [
    ("ControlLeft", "ControlRight"),
    ("AltLeft", "AltRight"),
    ("ShiftLeft", "ShiftRight"),
    ("MetaLeft", "MetaRight"),
];

#[derive(Default)]
pub(super) struct HeldKeys {
    physical: HashSet<&'static str>,
    inferred: [bool; 4],
}

fn key(code: &str, pressed: bool, repeat: bool) -> InputEvent {
    InputEvent::Key {
        code: code.into(),
        pressed,
        repeat,
    }
}

impl HeldKeys {
    pub(super) fn contains(&self, code: &str) -> bool {
        self.physical.contains(code)
    }

    pub(super) fn reset(&mut self) -> bool {
        let held = !self.physical.is_empty();
        *self = Self::default();
        held
    }

    /// Flags are ordered Control, Option, Shift, Command. UIKit may only
    /// report a modifier as a flag when it was held before gaining focus or
    /// the IME consumed the modifier's own press.
    pub(super) fn transition(
        &mut self,
        code: &'static str,
        flags: [bool; 4],
        pressed: bool,
        events: &mut Vec<InputEvent>,
    ) {
        if !pressed && self.physical.remove(code) {
            events.push(key(code, false, false));
        }
        let mut promoted = false;
        for (i, (left, right)) in SIDES.into_iter().enumerate() {
            let explicit = code == left || code == right;
            if self.inferred[i] && (explicit || !flags[i]) {
                self.inferred[i] = false;
                if pressed && code == left {
                    promoted = true;
                } else {
                    events.push(key(left, false, false));
                }
            }
            if pressed
                && flags[i]
                && !explicit
                && !self.inferred[i]
                && !self.contains(left)
                && !self.contains(right)
            {
                self.inferred[i] = true;
                events.push(key(left, true, false));
            }
        }
        if pressed {
            let repeat = !self.physical.insert(code);
            if !promoted {
                events.push(key(code, true, repeat));
            }
        }
        if self.physical.is_empty() {
            for (i, (left, _)) in SIDES.into_iter().enumerate().rev() {
                if std::mem::take(&mut self.inferred[i]) {
                    events.push(key(left, false, false));
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn editor_chord_releases_the_key_before_its_flag_only_modifier() {
        let mut held = HeldKeys::default();
        let mut events = Vec::new();
        held.transition("KeyC", [true, false, false, false], true, &mut events);
        held.transition("KeyC", [true, false, false, false], true, &mut events);
        held.transition("KeyC", [false; 4], false, &mut events);
        assert_eq!(
            events,
            [
                key("ControlLeft", true, false),
                key("KeyC", true, false),
                key("KeyC", true, true),
                key("KeyC", false, false),
                key("ControlLeft", false, false),
            ]
        );
        assert!(!held.reset());
    }

    #[test]
    fn sided_modifier_after_a_flag_does_not_restart_the_same_key() {
        let mut held = HeldKeys::default();
        let mut events = Vec::new();
        let shift = [false, false, true, false];
        held.transition("KeyA", shift, true, &mut events);
        events.clear();
        held.transition("ShiftLeft", shift, true, &mut events);
        held.transition("ShiftRight", shift, true, &mut events);
        held.transition("KeyA", shift, false, &mut events);
        assert_eq!(
            events,
            [key("ShiftRight", true, false), key("KeyA", false, false)]
        );
        assert!(held.reset());
        assert!(!held.contains("ShiftRight"));
    }
}
