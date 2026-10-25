//! Quartz input injection in the logged-in macOS session.
//!
//! CGDisplayBounds and CGEvent use logical desktop coordinates, independently
//! of the capture stream's Retina pixel dimensions. The daemon requests
//! Accessibility consent at startup; remote connections only check that access.

use std::time::{Duration, Instant};

use objc2_core_foundation::{CFRetained, CGPoint, CGRect};
use objc2_core_graphics::{
    CGDisplayBounds, CGDisplayIsOnline, CGEvent, CGEventField, CGEventFlags, CGEventSource,
    CGEventSourceStateID, CGEventTapLocation, CGEventType, CGMouseButton,
    CGPreflightPostEventAccess, CGScrollEventUnit,
};

use crate::{InputError, Result};

#[path = "macos_keys.rs"]
mod keys;

pub(super) struct PlatformInput {
    display_id: u32,
    source: CFRetained<CGEventSource>,
    position: CGPoint,
    buttons: [bool; 5],
    modifiers: [bool; 9],
    caps_lock: bool,
    scroll_remainder: [f64; 2],
    clicks: [Option<Click>; 5],
}

#[derive(Clone, Copy)]
struct Click {
    at: Instant,
    position: CGPoint,
    count: i64,
}

impl PlatformInput {
    pub(super) fn new(display_id: u32) -> Result<Self> {
        check_permission()?;
        let bounds = display_bounds(display_id)?;
        let source = CGEventSource::new(CGEventSourceStateID::Private)
            .ok_or_else(|| InputError::Platform("cannot create Quartz input source".into()))?;
        let caps_lock = CGEventSource::flags_state(CGEventSourceStateID::CombinedSessionState)
            .contains(CGEventFlags::MaskAlphaShift);
        Ok(Self {
            display_id,
            source,
            position: bounds.origin,
            buttons: [false; 5],
            modifiers: [false; 9],
            caps_lock,
            scroll_remainder: [0.0; 2],
            clicks: [None; 5],
        })
    }

    pub(super) fn move_pointer(&mut self, x: f64, y: f64) -> Result<()> {
        let bounds = display_bounds(self.display_id)?;
        let position = display_position(bounds, x, y);
        let (kind, button) = motion_kind(&self.buttons);
        let event = CGEvent::new_mouse_event(Some(&self.source), kind, position, button)
            .ok_or_else(event_creation_error)?;
        CGEvent::set_double_value_field(
            Some(&event),
            CGEventField::MouseEventDeltaX,
            position.x - self.position.x,
        );
        CGEvent::set_double_value_field(
            Some(&event),
            CGEventField::MouseEventDeltaY,
            position.y - self.position.y,
        );
        self.post(&event, self.flags())?;
        self.position = position;
        Ok(())
    }

    pub(super) fn button(&mut self, button: u8, pressed: bool) -> Result<()> {
        let (kind, quartz_button) = button_kind(button, pressed)?;
        let event =
            CGEvent::new_mouse_event(Some(&self.source), kind, self.position, quartz_button)
                .ok_or_else(event_creation_error)?;
        let previous = self.clicks[usize::from(button)];
        let click = if pressed {
            next_click(previous, self.position, Instant::now())
        } else {
            previous.unwrap_or(Click {
                at: Instant::now(),
                position: self.position,
                count: 1,
            })
        };
        CGEvent::set_integer_value_field(
            Some(&event),
            CGEventField::MouseEventClickState,
            click.count,
        );
        self.post(&event, self.flags())?;
        self.buttons[usize::from(button)] = pressed;
        self.clicks[usize::from(button)] = Some(click);
        Ok(())
    }

    pub(super) fn wheel(&mut self, dx: f64, dy: f64) -> Result<()> {
        let totals = [self.scroll_remainder[0] + dx, self.scroll_remainder[1] + dy];
        let pixels = [totals[0].trunc() as i32, totals[1].trunc() as i32];
        if pixels != [0, 0] {
            // Quartz's positive axes are up/left; the wire follows DOM down/right.
            let event = CGEvent::new_scroll_wheel_event2(
                Some(&self.source),
                CGScrollEventUnit::Pixel,
                2,
                -pixels[1],
                -pixels[0],
                0,
            )
            .ok_or_else(event_creation_error)?;
            CGEvent::set_location(Some(&event), self.position);
            self.post(&event, self.flags())?;
        }
        self.scroll_remainder = [
            totals[0] - f64::from(pixels[0]),
            totals[1] - f64::from(pixels[1]),
        ];
        Ok(())
    }

    pub(super) fn key(&mut self, code: &str, pressed: bool, repeat: bool) -> Result<()> {
        let keycode = keys::keycode(code).ok_or(InputError::UnsupportedKey)?;
        let event = CGEvent::new_keyboard_event(Some(&self.source), keycode, pressed)
            .ok_or_else(event_creation_error)?;
        let mut modifiers = self.modifiers;
        if let Some(index) = keys::modifier_index(code) {
            modifiers[index] = pressed;
            CGEvent::set_type(Some(&event), CGEventType::FlagsChanged);
        }
        let caps_lock = if code == "CapsLock" {
            CGEvent::set_type(Some(&event), CGEventType::FlagsChanged);
            self.caps_lock ^ (pressed && !repeat)
        } else {
            self.caps_lock
        };
        let mut flags = modifier_flags(&modifiers, caps_lock);
        if code.starts_with("Numpad") {
            flags |= CGEventFlags::MaskNumericPad;
        }
        CGEvent::set_integer_value_field(
            Some(&event),
            CGEventField::KeyboardEventAutorepeat,
            i64::from(pressed && repeat),
        );
        self.post(&event, flags)?;
        self.modifiers = modifiers;
        self.caps_lock = caps_lock;
        Ok(())
    }

    fn flags(&self) -> CGEventFlags {
        modifier_flags(&self.modifiers, self.caps_lock)
    }

    fn post(&self, event: &CGEvent, flags: CGEventFlags) -> Result<()> {
        // CGEventPost has no return value. Preflight avoids silently accepting
        // commands after Accessibility access has been revoked.
        check_permission()?;
        CGEvent::set_flags(Some(event), flags);
        CGEvent::post(CGEventTapLocation::HIDEventTap, Some(event));
        Ok(())
    }
}

fn check_permission() -> Result<()> {
    if CGPreflightPostEventAccess() {
        Ok(())
    } else {
        Err(InputError::PermissionDenied)
    }
}

fn display_bounds(display_id: u32) -> Result<CGRect> {
    if !CGDisplayIsOnline(display_id) {
        return Err(InputError::Platform("selected display is offline".into()));
    }
    let bounds = CGDisplayBounds(display_id);
    if !bounds.origin.x.is_finite()
        || !bounds.origin.y.is_finite()
        || !bounds.size.width.is_finite()
        || !bounds.size.height.is_finite()
        || bounds.size.width < 1.0
        || bounds.size.height < 1.0
    {
        return Err(InputError::Platform(
            "selected display has invalid bounds".into(),
        ));
    }
    Ok(bounds)
}

fn display_position(bounds: CGRect, x: f64, y: f64) -> CGPoint {
    CGPoint {
        x: bounds.origin.x + x * (bounds.size.width - 1.0),
        y: bounds.origin.y + y * (bounds.size.height - 1.0),
    }
}

fn event_creation_error() -> InputError {
    InputError::Platform("cannot create Quartz input event".into())
}

fn button_kind(button: u8, pressed: bool) -> Result<(CGEventType, CGMouseButton)> {
    let quartz_button = match button {
        0 => CGMouseButton::Left,
        1 => CGMouseButton::Center,
        2 => CGMouseButton::Right,
        3 | 4 => CGMouseButton(u32::from(button)),
        _ => return Err(InputError::InvalidEvent("unsupported mouse button")),
    };
    let kind = match (button, pressed) {
        (0, true) => CGEventType::LeftMouseDown,
        (0, false) => CGEventType::LeftMouseUp,
        (2, true) => CGEventType::RightMouseDown,
        (2, false) => CGEventType::RightMouseUp,
        (_, true) => CGEventType::OtherMouseDown,
        (_, false) => CGEventType::OtherMouseUp,
    };
    Ok((kind, quartz_button))
}

fn motion_kind(buttons: &[bool; 5]) -> (CGEventType, CGMouseButton) {
    if buttons[0] {
        (CGEventType::LeftMouseDragged, CGMouseButton::Left)
    } else if buttons[2] {
        (CGEventType::RightMouseDragged, CGMouseButton::Right)
    } else if buttons[1] {
        (CGEventType::OtherMouseDragged, CGMouseButton::Center)
    } else if buttons[3] {
        (CGEventType::OtherMouseDragged, CGMouseButton(3))
    } else if buttons[4] {
        (CGEventType::OtherMouseDragged, CGMouseButton(4))
    } else {
        (CGEventType::MouseMoved, CGMouseButton::Left)
    }
}

fn modifier_flags(modifiers: &[bool; 9], caps_lock: bool) -> CGEventFlags {
    let mut flags = CGEventFlags::empty();
    for (held, flag) in [
        (modifiers[0] || modifiers[1], CGEventFlags::MaskShift),
        (modifiers[2] || modifiers[3], CGEventFlags::MaskControl),
        (modifiers[4] || modifiers[5], CGEventFlags::MaskAlternate),
        (modifiers[6] || modifiers[7], CGEventFlags::MaskCommand),
        (modifiers[8], CGEventFlags::MaskSecondaryFn),
        (caps_lock, CGEventFlags::MaskAlphaShift),
    ] {
        if held {
            flags |= flag;
        }
    }
    flags
}

fn next_click(previous: Option<Click>, position: CGPoint, now: Instant) -> Click {
    let count = previous
        .filter(|click| {
            now.duration_since(click.at) <= Duration::from_millis(500)
                && (click.position.x - position.x).abs() <= 4.0
                && (click.position.y - position.y).abs() <= 4.0
        })
        .map_or(1, |click| (click.count + 1).min(3));
    Click {
        at: now,
        position,
        count,
    }
}

#[cfg(test)]
mod tests {
    use objc2_core_foundation::CGSize;

    use super::*;

    #[test]
    fn positions_use_display_bounds_including_negative_origins() {
        let bounds = CGRect {
            origin: CGPoint {
                x: -1440.0,
                y: 100.0,
            },
            size: CGSize {
                width: 1440.0,
                height: 900.0,
            },
        };
        assert_eq!(display_position(bounds, 0.0, 0.0), bounds.origin);
        assert_eq!(
            display_position(bounds, 1.0, 1.0),
            CGPoint { x: -1.0, y: 999.0 }
        );
    }

    #[test]
    fn held_buttons_select_drag_events_and_browser_button_order() {
        assert_eq!(motion_kind(&[false; 5]).0, CGEventType::MouseMoved);
        assert_eq!(
            motion_kind(&[false, true, false, false, false]),
            (CGEventType::OtherMouseDragged, CGMouseButton::Center)
        );
        assert_eq!(
            button_kind(2, true).unwrap(),
            (CGEventType::RightMouseDown, CGMouseButton::Right)
        );
        assert!(button_kind(5, true).is_err());
    }

    #[test]
    fn releasing_one_modifier_side_keeps_the_other_active() {
        let mut held = [false; 9];
        held[0] = true;
        held[1] = true;
        held[0] = false;
        assert_eq!(modifier_flags(&held, false), CGEventFlags::MaskShift);
        held[1] = false;
        assert!(modifier_flags(&held, false).is_empty());
    }

    #[test]
    fn consecutive_clicks_increment_and_distant_clicks_restart() {
        let now = Instant::now();
        let position = CGPoint { x: 10.0, y: 20.0 };
        let first = next_click(None, position, now);
        let second = next_click(Some(first), position, now + Duration::from_millis(100));
        assert_eq!(second.count, 2);
        assert_eq!(
            next_click(Some(second), position, now + Duration::from_secs(1)).count,
            1
        );
        assert_eq!(
            next_click(
                Some(second),
                CGPoint { x: 200.0, y: 20.0 },
                now + Duration::from_millis(200)
            )
            .count,
            1
        );
    }
}
