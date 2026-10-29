//! XTEST input shares RandR source coordinates with X11 capture.

use deskfleet_x11::InputConnection;

use crate::{InputError, Result, linux_keys};

use super::button_code;

pub(crate) struct X11Input {
    connection: InputConnection,
}

impl X11Input {
    pub(super) fn new(display_id: u32) -> Result<Self> {
        Ok(Self {
            connection: InputConnection::new(display_id).map_err(platform_error)?,
        })
    }

    pub(super) fn move_pointer(&mut self, x: f64, y: f64) -> Result<()> {
        self.connection.move_pointer(x, y).map_err(platform_error)
    }

    pub(super) fn button(&mut self, button: u8, pressed: bool) -> Result<()> {
        self.connection
            .button(button_code(button)?, pressed)
            .map_err(platform_error)
    }

    pub(super) fn wheel(&mut self, dx: f64, dy: f64) -> Result<()> {
        self.connection.wheel(dx, dy).map_err(platform_error)
    }

    pub(super) fn key(&mut self, code: &str, pressed: bool, repeat: bool) -> Result<()> {
        let code = linux_keys::keycode(code).ok_or(InputError::UnsupportedKey)?;
        // XTEST holds server key state; XKB repeat settings supply auto-repeat.
        if pressed && repeat {
            return Ok(());
        }
        self.connection.key(code, pressed).map_err(platform_error)
    }
}

fn platform_error(error: deskfleet_x11::Error) -> InputError {
    match error {
        deskfleet_x11::Error::UnsupportedKey => InputError::UnsupportedKey,
        error => InputError::Platform(error.to_string()),
    }
}
