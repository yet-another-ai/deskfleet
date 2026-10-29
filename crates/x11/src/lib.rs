//! Access to the logged-in user's Xorg desktop. Connections use DISPLAY and
//! Xauthority through x11rb's Rust transport; no Xlib or process-global setup.
//! Only local Unix X11 sockets are supported. TCP/SSH-forwarded X displays are
//! outside the machine-local desktop; WebRTC handles remote access instead.
#![cfg(target_os = "linux")]

mod capture;
mod connection;
mod display;
mod input;
mod keys;
mod pixels;
#[cfg(test)]
mod tests;

pub use capture::{Capture, VideoFrame};
pub use display::{Source, sources};
pub use input::InputConnection;

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Clone, Debug, thiserror::Error)]
pub enum Error {
    #[error("X11 desktop access is unavailable: {0}")]
    Unavailable(String),
    #[error("X11 desktop operation failed: {0}")]
    Platform(String),
    #[error("the selected X11 display changed or is no longer available")]
    StaleSource,
    #[error("X11 capture stopped")]
    Stopped,
    #[error("invalid X11 remote input: {0}")]
    InvalidInput(&'static str),
    #[error("the X11 keyboard has no matching physical key")]
    UnsupportedKey,
}

fn platform(error: impl std::fmt::Display) -> Error {
    Error::Platform(error.to_string())
}

#[derive(Clone, Copy, Debug, Default)]
pub struct Access {
    pub screen_capture: bool,
    pub control: bool,
}

/// Probe the user's X server without starting capture or injecting events.
/// Capture and control are independent: a server without XTEST remains viewable.
pub fn probe() -> Result<Access> {
    let (connection, deadline) = display::connect_with_deadline()?;
    deadline.finish(probe_connection(&connection))
}

fn probe_connection(connection: &x11rb::rust_connection::RustConnection) -> Result<Access> {
    let sources = display::enumerate(connection)?;
    let screen_capture = sources
        .iter()
        .any(|source| capture::prepare(connection, source, true).is_ok());
    Ok(Access {
        screen_capture,
        control: !sources.is_empty() && input::initialize(connection).is_ok(),
    })
}
