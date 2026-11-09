//! Physical keyboard events from an AppKit monitor scoped to the GPUI window.

#![allow(unsafe_code)] // This module owns the AppKit event-monitor FFI boundary.

use std::cell::Cell;
use std::ptr::NonNull;
use std::rc::Rc;

use block2::RcBlock;
use deskfleet_input::NativeKeyCode;
use objc2::{MainThreadMarker, rc::Retained, runtime::AnyObject};
use objc2_app_kit::{NSEvent, NSEventMask, NSEventModifierFlags, NSEventType, NSView};
use raw_window_handle::{HasWindowHandle, RawWindowHandle};

use super::Bridge;

pub(super) struct Adapter {
    monitor: Retained<AnyObject>,
    bridge: Bridge,
    caps_lock: Rc<Cell<bool>>,
    _handler: RcBlock<dyn Fn(NonNull<NSEvent>) -> *mut NSEvent>,
    _main_thread: MainThreadMarker,
}

impl Adapter {
    pub(super) fn new(window: &gpui::Window, bridge: Bridge) -> Result<Self, crate::Error> {
        let main_thread =
            MainThreadMarker::new().ok_or("physical keyboard requires the main thread")?;
        let RawWindowHandle::AppKit(handle) = HasWindowHandle::window_handle(window)?.as_raw()
        else {
            return Err("physical keyboard requires an AppKit window".into());
        };
        // SAFETY: GPUI supplies its live NSView, and this code runs on the main
        // thread. Retaining its NSWindow keeps the filter target valid.
        let view = unsafe { handle.ns_view.cast::<NSView>().as_ref() };
        let target = view
            .window()
            .ok_or("physical keyboard view has no window")?;
        let caps_lock = Rc::new(Cell::new(
            NSEvent::modifierFlags_class().contains(NSEventModifierFlags::CapsLock),
        ));
        let monitor_caps_lock = Rc::clone(&caps_lock);
        let monitor_bridge = bridge.clone();
        let handler = RcBlock::new(move |native: NonNull<NSEvent>| -> *mut NSEvent {
            // SAFETY: AppKit passes a live event for the duration of this block.
            let event = unsafe { native.as_ref() };
            let Some(event_window) = event.window(main_thread) else {
                return native.as_ptr();
            };
            if !std::ptr::eq(&*event_window, &*target) {
                return native.as_ptr();
            }
            let bridge = &monitor_bridge;
            let flags = event.modifierFlags();
            // Each event carries device-side masks, including when focus was
            // acquired with a modifier already held. The bridge deduplicates.
            sync_modifiers(bridge, flags.bits());
            let current_caps_lock = flags.contains(NSEventModifierFlags::CapsLock);
            let previous_caps_lock = monitor_caps_lock.replace(current_caps_lock);
            match event.r#type() {
                NSEventType::KeyDown => bridge.key(
                    NativeKeyCode::MacOs(event.keyCode()),
                    true,
                    event.isARepeat(),
                ),
                NSEventType::KeyUp => {
                    bridge.key(NativeKeyCode::MacOs(event.keyCode()), false, false)
                }
                NSEventType::FlagsChanged if event.keyCode() == 0x3f => {
                    // Arrow/function-key events also carry the Function mask.
                    // Only this physical flagsChanged event identifies Fn.
                    bridge.key(
                        NativeKeyCode::MacOs(0x3f),
                        flags.contains(NSEventModifierFlags::Function),
                        false,
                    );
                }
                NSEventType::FlagsChanged
                    if event.keyCode() == 0x39 && current_caps_lock != previous_caps_lock =>
                {
                    // Caps Lock reports a latched state change, not an ordinary
                    // press/release pair. Send one balanced physical press.
                    bridge.key(NativeKeyCode::MacOs(0x39), true, false);
                    bridge.key(NativeKeyCode::MacOs(0x39), false, false);
                }
                _ => {}
            }
            if bridge.enabled()
                && matches!(event.r#type(), NSEventType::KeyDown | NSEventType::KeyUp)
            {
                std::ptr::null_mut()
            } else {
                // GPUI still needs flagsChanged for its local modifier state.
                native.as_ptr()
            }
        });
        // SAFETY: The block returns its live incoming event or null. Adapter
        // retains the block and removes this exact monitor before dropping it.
        let monitor = unsafe {
            NSEvent::addLocalMonitorForEventsMatchingMask_handler(
                NSEventMask::KeyDown | NSEventMask::KeyUp | NSEventMask::FlagsChanged,
                &handler,
            )
        }
        .ok_or("could not install physical keyboard event monitor")?;
        Ok(Self {
            monitor,
            bridge,
            caps_lock,
            _handler: handler,
            _main_thread: main_thread,
        })
    }

    pub(super) fn refresh_modifiers(&self) {
        // Called before reopening the bridge gate. Unlike events missed while
        // unfocused, this snapshot reflects the current side-specific state.
        let flags = NSEvent::modifierFlags_class();
        self.caps_lock
            .set(flags.contains(NSEventModifierFlags::CapsLock));
        sync_modifiers(&self.bridge, flags.bits());
    }
}

impl Drop for Adapter {
    fn drop(&mut self) {
        // SAFETY: This is the monitor returned by AppKit, removed on the same
        // main thread before its retained callback and target window are dropped.
        unsafe { NSEvent::removeMonitor(&self.monitor) };
    }
}

fn sync_modifiers(bridge: &Bridge, flags: usize) {
    // Device-side modifier bits from IOKit/hidsystem/IOLLEvent.h. The usual
    // device-independent Shift/Control/Option/Command flags merge both sides.
    for (keycode, mask) in [
        (0x3b, 0x0000_0001), // left Control
        (0x38, 0x0000_0002), // left Shift
        (0x3c, 0x0000_0004), // right Shift
        (0x37, 0x0000_0008), // left Command
        (0x36, 0x0000_0010), // right Command
        (0x3a, 0x0000_0020), // left Option
        (0x3d, 0x0000_0040), // right Option
        (0x3e, 0x0000_2000), // right Control
    ] {
        bridge.key(NativeKeyCode::MacOs(keycode), flags & mask != 0, false);
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use deskfleet_input::InputEvent;

    use super::super::State;
    use super::*;

    #[test]
    fn function_key_event_flag_does_not_invent_a_physical_fn_press() {
        let bridge = Bridge {
            state: Arc::new(Mutex::new(State {
                enabled: true,
                ..State::default()
            })),
            wake: Arc::new(|| {}),
        };
        sync_modifiers(&bridge, NSEventModifierFlags::Function.bits() | 0x0000_0004);
        let events: Vec<_> = bridge.state().pending.drain(..).collect();
        assert_eq!(events.len(), 1);
        assert!(
            matches!(&events[0], InputEvent::Key { code, pressed: true, repeat: false } if code == "ShiftRight")
        );
    }
}
