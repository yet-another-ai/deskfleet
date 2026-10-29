//! Select one Linux desktop backend for capture, input and authorization.
//!
//! Selection does not connect to a display or load a media runtime. A failed
//! Wayland connection or denied Portal grant never falls back to Xwayland.

use std::ffi::OsStr;
use std::sync::OnceLock;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Backend {
    Wayland,
    X11,
    Unavailable,
}

impl Backend {
    #[must_use]
    pub fn as_str(self) -> Option<&'static str> {
        match self {
            Self::Wayland => Some("wayland"),
            Self::X11 => Some("x11"),
            Self::Unavailable => None,
        }
    }
}

/// All native consumers use the same process-session choice. Restart the daemon
/// when changing its graphical session environment.
#[must_use]
pub fn backend() -> Backend {
    static BACKEND: OnceLock<Backend> = OnceLock::new();
    *BACKEND.get_or_init(|| {
        select(
            std::env::var_os("XDG_SESSION_TYPE").as_deref(),
            std::env::var_os("WAYLAND_DISPLAY").as_deref(),
            std::env::var_os("DISPLAY").as_deref(),
        )
    })
}

fn select(session: Option<&OsStr>, wayland: Option<&OsStr>, x11: Option<&OsStr>) -> Backend {
    if session == Some(OsStr::new("wayland")) || wayland.is_some_and(|value| !value.is_empty()) {
        Backend::Wayland
    } else if x11.is_some_and(|value| !value.is_empty()) {
        Backend::X11
    } else {
        Backend::Unavailable
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn choose(session: Option<&str>, wayland: Option<&str>, x11: Option<&str>) -> Backend {
        select(
            session.map(OsStr::new),
            wayland.map(OsStr::new),
            x11.map(OsStr::new),
        )
    }

    #[test]
    fn wayland_never_falls_back_to_its_xwayland_display() {
        assert_eq!(choose(Some("wayland"), None, Some(":0")), Backend::Wayland);
        assert_eq!(
            choose(None, Some("wayland-0"), Some(":0")),
            Backend::Wayland
        );
    }

    #[test]
    fn xorg_and_nested_displays_work_without_session_metadata() {
        assert_eq!(choose(Some("x11"), None, Some(":0")), Backend::X11);
        assert_eq!(choose(None, None, Some(":99")), Backend::X11);
        assert_eq!(choose(Some("tty"), Some(""), Some(":99")), Backend::X11);
    }

    #[test]
    fn headless_process_has_no_desktop_backend() {
        assert_eq!(choose(None, None, None), Backend::Unavailable);
        assert_eq!(choose(Some("x11"), None, Some("")), Backend::Unavailable);
    }
}
