//! EIS input shares the daemon's authorized Wayland session with screen capture.

use deskfleet_wayland::InputConnection;

use crate::{InputError, Result, linux_keys};

pub(super) struct PlatformInput {
    connection: InputConnection,
}

impl PlatformInput {
    pub(super) fn new(display_id: u32) -> Result<Self> {
        Ok(Self {
            connection: InputConnection::new(display_id).map_err(platform_error)?,
        })
    }

    pub(super) fn move_pointer(&mut self, x: f64, y: f64) -> Result<()> {
        self.connection.move_pointer(x, y).map_err(platform_error)
    }

    pub(super) fn button(&mut self, button: u8, pressed: bool) -> Result<()> {
        let code = match button {
            0 => 0x110, // BTN_LEFT
            1 => 0x112, // BTN_MIDDLE
            2 => 0x111, // BTN_RIGHT
            3 => 0x113, // BTN_SIDE (browser back)
            4 => 0x114, // BTN_EXTRA (browser forward)
            _ => return Err(InputError::InvalidEvent("unknown mouse button")),
        };
        self.connection
            .button(code, pressed)
            .map_err(platform_error)
    }

    pub(super) fn wheel(&mut self, dx: f64, dy: f64) -> Result<()> {
        self.connection.wheel(dx, dy).map_err(platform_error)
    }

    pub(super) fn key(&mut self, code: &str, pressed: bool, repeat: bool) -> Result<()> {
        let code = linux_keys::keycode(code).ok_or(InputError::UnsupportedKey)?;
        // Wayland clients repeat held keys using the compositor's keymap/repeat
        // settings. Repeated browser keydown events are not additional presses.
        if repeat && pressed {
            return Ok(());
        }
        self.connection.key(code, pressed).map_err(platform_error)
    }
}

fn platform_error(error: impl std::fmt::Display) -> InputError {
    InputError::Platform(error.to_string())
}
