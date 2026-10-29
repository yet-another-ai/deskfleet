//! EIS input shares the daemon's authorized Wayland session with screen capture.

use deskfleet_wayland::InputConnection;

use crate::{InputError, Result, linux_keys};

use super::button_code;

pub(crate) struct WaylandInput {
    connection: InputConnection,
}

impl WaylandInput {
    pub(super) fn new(display_id: u32) -> Result<Self> {
        Ok(Self {
            connection: InputConnection::new(display_id).map_err(platform_error)?,
        })
    }

    pub(super) fn move_pointer(&mut self, x: f64, y: f64) -> Result<()> {
        self.connection.move_pointer(x, y).map_err(platform_error)
    }

    pub(super) fn button(&mut self, button: u8, pressed: bool) -> Result<()> {
        let code = button_code(button)?;
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
