//! Physical key transitions from the Metal and text views' UIKit responders.

use std::cell::RefCell;

use deskfleet_input::{InputEvent, NativeKeyCode};
use objc2::MainThreadMarker;
use objc2::rc::Retained;
use objc2_foundation::{NSArray, NSSet, NSString};
use objc2_ui_kit::{UIKeyModifierFlags as Flags, UIPress};

use crate::android::send_view_input;
use crate::ios_key_state::HeldKeys;

#[derive(Default)]
pub(crate) struct HardwareKeyboard {
    held: RefCell<HeldKeys>,
}

impl HardwareKeyboard {
    pub(crate) fn presses(
        &self,
        mtm: MainThreadMarker,
        presses: &NSSet<UIPress>,
        pressed: bool,
    ) -> Retained<NSSet<UIPress>> {
        self.route(mtm, presses, pressed, None)
    }

    /// In the editor, UIKit handles composition and ordinary printable keys.
    /// Shortcut and navigation presses use the same state as the video responder.
    pub(crate) fn route(
        &self,
        mtm: MainThreadMarker,
        presses: &NSSet<UIPress>,
        pressed: bool,
        composing: Option<bool>,
    ) -> Retained<NSSet<UIPress>> {
        let mut other = Vec::new();
        let mut keys = Vec::new();
        let mut held = self.held.borrow_mut();
        for press in presses {
            let Some(input) = press.key(mtm) else {
                other.push(press);
                continue;
            };
            let Ok(usage) = u16::try_from(input.keyCode().0) else {
                other.push(press);
                continue;
            };
            let Some(code) = NativeKeyCode::KeyboardHid(usage).code() else {
                other.push(press);
                continue;
            };
            let flags = input.modifierFlags();
            if let Some(composing) = composing {
                let chord = flags.intersects(Flags::Control | Flags::Alternate | Flags::Command);
                let navigation =
                    matches!(usage, 0x29 | 0x2b | 0x3a..=0x45 | 0x49..=0x52 | 0x68..=0x73);
                // Let UITextView see its actual modifier keys and synthesize
                // the indicated flags only for remote shortcut strokes.
                let intercept = if pressed {
                    !composing && usage < 0xe0 && (chord || navigation)
                } else {
                    held.contains(code)
                };
                if !intercept {
                    other.push(press);
                    continue;
                }
            }
            keys.push((usage, code, flags));
        }
        // UIKit batches simultaneous changes in an unordered set.
        keys.sort_unstable_by_key(|(usage, _, _)| (0xe0..=0xe7).contains(usage) != pressed);
        let mut events = Vec::new();
        for (_, code, flags) in keys {
            let active = [
                Flags::Control,
                Flags::Alternate,
                Flags::Shift,
                Flags::Command,
            ]
            .map(|modifier| flags.contains(modifier));
            held.transition(code, active, pressed, &mut events);
        }
        if !events.is_empty() {
            send_view_input(events)
        }
        NSSet::from_retained_slice(&other)
    }

    pub(crate) fn release(&self) {
        let mut held = self.held.borrow_mut();
        if held.reset() {
            send_view_input(vec![InputEvent::ReleaseAll]);
        }
    }
}

/// # Safety
/// Swift borrows an NSArray of physical key code strings for this main-thread call.
#[allow(unsafe_code)]
#[unsafe(no_mangle)]
unsafe extern "C" fn deskfleet_ios_send_key_chord(codes: &NSArray<NSString>) {
    let codes: Vec<_> = codes.iter().map(|code| code.to_string()).collect();
    send_view_input(crate::nsh_keyboard::chord_events(&codes));
}
