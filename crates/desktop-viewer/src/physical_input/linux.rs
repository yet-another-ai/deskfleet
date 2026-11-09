use raw_window_handle::{HasWindowHandle, RawWindowHandle};

use super::{Bridge, wayland, x11};
use crate::Error;

pub(super) enum Adapter {
    Wayland { _capture: wayland::Adapter },
    X11 { _capture: x11::Adapter },
}

impl Adapter {
    pub(super) fn new(window: &gpui::Window, bridge: Bridge) -> Result<Self, Error> {
        match HasWindowHandle::window_handle(window)?.as_raw() {
            RawWindowHandle::Wayland(_) => Ok(Self::Wayland {
                _capture: wayland::Adapter::new(window, bridge)?,
            }),
            RawWindowHandle::Xcb(handle) => Ok(Self::X11 {
                _capture: x11::Adapter::new(handle.window.get(), bridge)?,
            }),
            RawWindowHandle::Xlib(handle) => Ok(Self::X11 {
                _capture: x11::Adapter::new(handle.window.try_into()?, bridge)?,
            }),
            _ => Err("unsupported Linux window handle for physical keyboard input".into()),
        }
    }
}
