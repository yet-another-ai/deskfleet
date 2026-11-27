//! Quartz input injection in the logged-in macOS session.
//!
//! CGDisplayBounds and CGEvent use logical desktop coordinates, independently
//! of the capture stream's Retina pixel dimensions. The daemon requests
//! Accessibility consent at startup; remote connections only check that access.
//! Remote control and input events also declare remote user activity through
//! IOKit Power Management so `UserIsActive` transitions to active for display
//! wake and lock-screen authentication.

use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{Duration, Instant};

use objc2_core_foundation::{CFRetained, CFString, CGPoint, CGRect};
use objc2_core_graphics::{
    CGDisplayBounds, CGDisplayIsOnline, CGEvent, CGEventField, CGEventFlags, CGEventSource,
    CGEventSourceStateID, CGEventTapLocation, CGEventType, CGMouseButton,
    CGPreflightPostEventAccess, CGScrollEventUnit,
};
use objc2_io_kit::{
    IOPMAssertionDeclareUserActivity, IOPMAssertionID, IOPMUserActiveType, IOReturn,
    kIOPMNullAssertionID, kIOReturnSuccess,
};

use crate::{InputError, Result};

use crate::macos_keys as keys;

/// Minimum interval between IOKit remote user-activity declarations while input
/// is arriving. Short enough to recover well inside `loginwindow`'s 5-second
/// unlock activity wait without spamming `powerd` on high-rate pointer motion.
const USER_ACTIVITY_INTERVAL: Duration = Duration::from_secs(2);

/// Assertion name reported to IOKit Power Management (`<= 128` characters).
const USER_ACTIVITY_NAME: &str = "DeskFleet remote desktop input";

/// Process-wide assertion ID passed back to `IOPMAssertionDeclareUserActivity`
/// so repeated calls and reconnected control sessions refresh one `UserIsActive`
/// assertion in `powerd` rather than accumulating entries.
static SHARED_ACTIVITY_ASSERTION: AtomicU32 = AtomicU32::new(kIOPMNullAssertionID);

pub(super) struct PlatformInput {
    display_id: u32,
    source: CFRetained<CGEventSource>,
    position: CGPoint,
    buttons: [bool; 5],
    modifiers: [bool; 9],
    caps_lock: bool,
    scroll_remainder: [f64; 2],
    clicks: [Option<Click>; 5],
    clipboard: crate::macos_clipboard::MacOsClipboard,
    user_activity: UserActivity,
}

struct UserActivity {
    name: CFRetained<CFString>,
    last_declared: Option<Instant>,
}

impl UserActivity {
    fn new() -> Self {
        Self {
            name: CFString::from_static_str(USER_ACTIVITY_NAME),
            last_declared: None,
        }
    }

    fn declare(&mut self) {
        let mut assertion_id = SHARED_ACTIVITY_ASSERTION.load(Ordering::Acquire);
        self.declare_at(
            Instant::now(),
            &mut assertion_id,
            declare_remote_user_activity,
        );
        SHARED_ACTIVITY_ASSERTION.store(assertion_id, Ordering::Release);
    }

    fn declare_at(
        &mut self,
        now: Instant,
        assertion_id: &mut IOPMAssertionID,
        declare: impl FnOnce(&CFString, &mut IOPMAssertionID) -> IOReturn,
    ) {
        if self
            .last_declared
            .is_some_and(|last| now.saturating_duration_since(last) < USER_ACTIVITY_INTERVAL)
        {
            return;
        }
        self.last_declared = Some(now);
        let status = declare(&self.name, assertion_id);
        if status != kIOReturnSuccess {
            *assertion_id = kIOPMNullAssertionID;
            tracing::warn!(status, "failed to declare remote user activity");
        }
    }
}

#[allow(unsafe_code)]
fn declare_remote_user_activity(name: &CFString, assertion_id: &mut IOPMAssertionID) -> IOReturn {
    // SAFETY: `name` is a valid non-null `CFString` reference and `assertion_id`
    // is a valid, aligned writable pointer to an initialized `IOPMAssertionID`.
    unsafe {
        IOPMAssertionDeclareUserActivity(
            Some(name),
            IOPMUserActiveType::Remote,
            std::ptr::from_mut(assertion_id),
        )
    }
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
        let mut user_activity = UserActivity::new();
        user_activity.declare();
        Ok(Self {
            display_id,
            source,
            position: bounds.origin,
            buttons: [false; 5],
            modifiers: [false; 9],
            caps_lock,
            scroll_remainder: [0.0; 2],
            clicks: [None; 5],
            clipboard: crate::macos_clipboard::MacOsClipboard::new(),
            user_activity,
        })
    }

    pub(super) fn set_clipboard(&mut self, text: &str) -> Result<()> {
        self.clipboard.set_text(text)
    }

    pub(super) fn poll_clipboard(&mut self) -> Result<Option<String>> {
        self.clipboard.poll_text()
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
        let flags = self.flags();
        self.post(&event, flags)?;
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
        let flags = self.flags();
        self.post(&event, flags)?;
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
            let flags = self.flags();
            self.post(&event, flags)?;
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

    fn post(&mut self, event: &CGEvent, flags: CGEventFlags) -> Result<()> {
        // CGEventPost has no return value. Preflight avoids silently accepting
        // commands after Accessibility access has been revoked.
        check_permission()?;
        self.user_activity.declare();
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

    #[test]
    fn user_activity_throttles_reuses_and_resets_assertion_id_on_error() {
        let mut activity = UserActivity::new();
        let mut assertion_id = kIOPMNullAssertionID;
        let mut seen = Vec::new();
        let start = Instant::now();

        activity.declare_at(start, &mut assertion_id, |_, id| {
            seen.push(*id);
            *id = 42;
            kIOReturnSuccess
        });
        assert_eq!(assertion_id, 42);

        // Inside the throttle window, IOKit is not called again.
        activity.declare_at(
            start + USER_ACTIVITY_INTERVAL - Duration::from_millis(1),
            &mut assertion_id,
            |_, id| {
                seen.push(*id);
                *id = 99;
                kIOReturnSuccess
            },
        );
        assert_eq!(assertion_id, 42);
        assert_eq!(seen, [kIOPMNullAssertionID]);

        // After the interval, the previous ID is reused; an error resets it to null.
        activity.declare_at(
            start + USER_ACTIVITY_INTERVAL,
            &mut assertion_id,
            |_, id| {
                seen.push(*id);
                -1
            },
        );
        assert_eq!(assertion_id, kIOPMNullAssertionID);
        assert_eq!(seen, [kIOPMNullAssertionID, 42]);

        // Next eligible call starts cleanly from a null ID.
        activity.declare_at(
            start + USER_ACTIVITY_INTERVAL * 2,
            &mut assertion_id,
            |_, id| {
                seen.push(*id);
                *id = 88;
                kIOReturnSuccess
            },
        );
        assert_eq!(assertion_id, 88);
        assert_eq!(seen, [kIOPMNullAssertionID, 42, kIOPMNullAssertionID]);
    }
}
