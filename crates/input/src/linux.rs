//! Input follows the selected Linux desktop backend and its capture source IDs.

use deskfleet_linux_desktop::{Backend, backend};

use crate::{InputError, Result};

mod wayland;
mod x11;

pub(super) enum PlatformInput {
    Wayland(wayland::WaylandInput),
    X11(Box<x11::X11Input>),
}

impl PlatformInput {
    pub(super) fn new(display_id: u32) -> Result<Self> {
        match backend() {
            Backend::Wayland => wayland::WaylandInput::new(display_id).map(Self::Wayland),
            Backend::X11 => x11::X11Input::new(display_id).map(Box::new).map(Self::X11),
            Backend::Unavailable => Err(InputError::Unsupported("no Linux desktop session")),
        }
    }

    pub(super) fn move_pointer(&mut self, x: f64, y: f64) -> Result<()> {
        match self {
            Self::Wayland(input) => input.move_pointer(x, y),
            Self::X11(input) => input.move_pointer(x, y),
        }
    }

    pub(super) fn button(&mut self, button: u8, pressed: bool) -> Result<()> {
        match self {
            Self::Wayland(input) => input.button(button, pressed),
            Self::X11(input) => input.button(button, pressed),
        }
    }

    pub(super) fn wheel(&mut self, dx: f64, dy: f64) -> Result<()> {
        match self {
            Self::Wayland(input) => input.wheel(dx, dy),
            Self::X11(input) => input.wheel(dx, dy),
        }
    }

    pub(super) fn key(&mut self, code: &str, pressed: bool, repeat: bool) -> Result<()> {
        match self {
            Self::Wayland(input) => input.key(code, pressed, repeat),
            Self::X11(input) => input.key(code, pressed, repeat),
        }
    }
}

fn button_code(button: u8) -> Result<u32> {
    match button {
        0 => Ok(0x110), // BTN_LEFT
        1 => Ok(0x112), // BTN_MIDDLE
        2 => Ok(0x111), // BTN_RIGHT
        3 => Ok(0x113), // BTN_SIDE (browser back)
        4 => Ok(0x114), // BTN_EXTRA (browser forward)
        _ => Err(InputError::InvalidEvent("unknown mouse button")),
    }
}
