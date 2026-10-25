//! Display-scoped input injection, independent of Node.js and transport.
//!
//! A session owns only the keys and mouse buttons it pressed. Closing it releases
//! those inputs. Create and use the session on a dedicated blocking worker.

use std::sync::atomic::{AtomicBool, Ordering};

use serde::Deserialize;

#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
use macos::PlatformInput;
#[cfg(target_os = "windows")]
mod windows;
#[cfg(target_os = "windows")]
mod windows_keys;
#[cfg(target_os = "windows")]
use windows::PlatformInput;
#[cfg(not(any(target_os = "windows", target_os = "macos")))]
mod unsupported;
#[cfg(not(any(target_os = "windows", target_os = "macos")))]
use unsupported::PlatformInput;

mod session;
use session::Controller;

/// Input injection or validation failure.
#[derive(Debug, thiserror::Error)]
pub enum InputError {
    #[error("desktop input is unsupported: {0}")]
    Unsupported(&'static str),
    /// The physical key has no platform mapping; no event was injected.
    #[error("physical key code has no platform mapping")]
    UnsupportedKey,
    #[error("desktop control needs Accessibility permission on the remote Mac")]
    PermissionDenied,
    #[error("invalid desktop input: {0}")]
    InvalidEvent(&'static str),
    #[error("desktop input failed: {0}")]
    Platform(String),
    #[error("another viewer is already controlling this desktop")]
    Busy,
}

/// Result returned by the input backend.
pub type Result<T> = std::result::Result<T, InputError>;

/// Check Accessibility consent without prompting or initializing input.
///
/// Returns `None` on platforms without an upfront permission request.
#[must_use]
pub fn check_accessibility_access() -> Option<bool> {
    #[cfg(target_os = "macos")]
    {
        Some(objc2_core_graphics::CGPreflightPostEventAccess())
    }
    #[cfg(not(target_os = "macos"))]
    {
        None
    }
}

/// Request Accessibility consent for this process during daemon startup.
///
/// Existing macOS consent is checked before requesting access. This does not
/// initialize input, enumerate displays, or acquire a controller. Other
/// platforms return `None` without prompting.
#[must_use]
pub fn request_accessibility_access() -> Option<bool> {
    #[cfg(target_os = "macos")]
    {
        use objc2_core_graphics::{CGPreflightPostEventAccess, CGRequestPostEventAccess};

        Some(CGPreflightPostEventAccess() || CGRequestPostEventAccess())
    }
    #[cfg(not(target_os = "macos"))]
    {
        None
    }
}

/// Messages on the ordered desktop-input channel.
///
/// Positions are normalized to the selected display, independent of video size.
/// Wheel distances are CSS pixels, positive right/down. Keys use physical DOM
/// `KeyboardEvent.code` names, interpreted with the remote machine's layout.
#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub enum InputEvent {
    PointerMove {
        x: f64,
        y: f64,
    },
    PointerButton {
        button: u8,
        pressed: bool,
        x: f64,
        y: f64,
    },
    Wheel {
        #[serde(rename = "deltaX")]
        delta_x: f64,
        #[serde(rename = "deltaY")]
        delta_y: f64,
    },
    Key {
        code: String,
        pressed: bool,
        #[serde(default)]
        repeat: bool,
    },
    ReleaseAll,
}

impl InputEvent {
    fn validate(&self) -> Result<()> {
        match self {
            Self::PointerMove { x, y } | Self::PointerButton { x, y, .. }
                if !x.is_finite()
                    || !y.is_finite()
                    || !(0.0..=1.0).contains(x)
                    || !(0.0..=1.0).contains(y) =>
            {
                Err(InputError::InvalidEvent(
                    "position must be finite and in [0, 1]",
                ))
            }
            Self::PointerButton { button, .. } if *button > 4 => {
                Err(InputError::InvalidEvent("unknown mouse button"))
            }
            Self::Wheel { delta_x, delta_y }
                if !delta_x.is_finite()
                    || !delta_y.is_finite()
                    || delta_x.abs() > 10_000.0
                    || delta_y.abs() > 10_000.0 =>
            {
                Err(InputError::InvalidEvent(
                    "wheel distance must be finite and at most 10000 pixels",
                ))
            }
            Self::Key { code, .. } if code.is_empty() || code.len() > 32 => {
                Err(InputError::InvalidEvent("invalid physical key code"))
            }
            _ => Ok(()),
        }
    }
}

/// Injectable backend boundary used to test input ownership without OS events.
trait Backend {
    fn move_pointer(&mut self, x: f64, y: f64) -> Result<()>;
    fn button(&mut self, button: u8, pressed: bool) -> Result<()>;
    fn wheel(&mut self, dx: f64, dy: f64) -> Result<()>;
    fn key(&mut self, code: &str, pressed: bool, repeat: bool) -> Result<()>;
}

impl Backend for PlatformInput {
    fn move_pointer(&mut self, x: f64, y: f64) -> Result<()> {
        self.move_pointer(x, y)
    }
    fn button(&mut self, button: u8, pressed: bool) -> Result<()> {
        self.button(button, pressed)
    }
    fn wheel(&mut self, dx: f64, dy: f64) -> Result<()> {
        self.wheel(dx, dy)
    }
    fn key(&mut self, code: &str, pressed: bool, repeat: bool) -> Result<()> {
        self.key(code, pressed, repeat)
    }
}

static CONTROL_ACTIVE: AtomicBool = AtomicBool::new(false);

struct ControlLease;

impl ControlLease {
    fn acquire() -> Result<Self> {
        CONTROL_ACTIVE
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| InputError::Busy)?;
        Ok(Self)
    }
}

impl Drop for ControlLease {
    fn drop(&mut self) {
        CONTROL_ACTIVE.store(false, Ordering::Release);
    }
}

/// Exclusive control of this process's desktop input, scoped to one display.
///
/// The controller is initialized only on explicit control requests. Loading the
/// library does not enumerate displays or request operating-system permissions.
pub struct InputSession {
    // Fields drop in declaration order: release inputs before relinquishing the lease.
    controller: Controller<PlatformInput>,
    _lease: ControlLease,
}

impl InputSession {
    /// Open the same display ID used by screen capture.
    ///
    /// # Errors
    /// Returns an error for missing displays, denied permissions, unsupported
    /// platforms, or another controller already holding the desktop.
    pub fn new(display_id: u32) -> Result<Self> {
        let lease = ControlLease::acquire()?;
        Ok(Self {
            controller: Controller::new(PlatformInput::new(display_id)?),
            _lease: lease,
        })
    }

    /// Validate and inject one ordered event. Errors trigger held-input cleanup.
    /// Physical keys without a platform mapping are ignored.
    ///
    /// # Errors
    /// Returns invalid input or OS injection errors.
    pub fn handle(&mut self, event: InputEvent) -> Result<()> {
        self.controller.handle(event)
    }

    /// Release this session's held keys and buttons. Safe to call repeatedly.
    ///
    /// # Errors
    /// Reports failed OS releases; failed releases remain tracked for a retry.
    pub fn release_all(&mut self) -> Result<()> {
        self.controller.release_all()
    }
}
