//! A user-session Wayland portal shared by capture workers and remote controllers.
//!
//! Authorization is explicit. Dropping a viewer or controller does not end the
//! portal session; shutdown, compositor revocation and portal disconnection do.
#![cfg(target_os = "linux")]

mod identity;
mod input;
mod portal;
mod runtime;
mod token;

use std::{os::fd::OwnedFd, path::PathBuf};

pub const APP_ID: &str = "io.github.yet_another_ai.deskfleet";

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("Wayland desktop access is unavailable: {0}")]
    Unavailable(String),
    #[error("Wayland desktop authorization was cancelled")]
    Cancelled,
    #[error("Wayland desktop access has not been granted")]
    PermissionDenied,
    #[error("Wayland desktop authorization is already in progress")]
    Busy,
    #[error("the selected Wayland source is no longer available")]
    StaleSource,
    #[error("invalid remote input: {0}")]
    InvalidInput(&'static str),
    #[error("Wayland portal failed: {0}")]
    Portal(#[from] zbus::Error),
    #[error("Wayland desktop I/O failed: {0}")]
    Io(#[from] std::io::Error),
    #[error("Wayland input failed: {0}")]
    Input(String),
    #[error("Wayland desktop runtime stopped")]
    Stopped,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum PermissionStatus {
    #[default]
    Unknown,
    Requesting,
    Granted,
    Denied,
    Unavailable,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct PermissionSnapshot {
    pub screen_capture: bool,
    pub control: bool,
    pub status: PermissionStatus,
    pub persistent: bool,
}

/// A session-scoped monitor. `id` is opaque and never a PipeWire node number.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Source {
    pub id: u32,
    pub name: String,
    /// Compositor logical dimensions; negotiate actual image pixels with PipeWire.
    pub width: u32,
    pub height: u32,
    pub node_id: u32,
    /// ScreenCast v6's stable PipeWire object serial; absent with older portals.
    pub pipewire_serial: Option<u64>,
    pub mapping_id: Option<String>,
}

/// Checks the current graphical user's portal without opening a permission dialog.
pub async fn supported() -> Result<bool> {
    portal::supported().await
}

/// Requests combined screen and input permission, restoring a saved grant when possible.
///
/// A live capture session whose remote input is disconnected connects again.
/// Display listing uses [`restore_access`] and does not open another input connection.
pub async fn request_access(directory: PathBuf) -> Result<PermissionSnapshot> {
    runtime::request(Some(directory)).await
}

/// Restores previously configured access during an explicit remote connection attempt.
///
/// Requires a saved token. A revoked token may still cause the portal to ask the
/// local user again; there is no standard portal "restore without dialog" flag.
pub async fn restore_access() -> Result<PermissionSnapshot> {
    runtime::request(None).await
}

/// Reads locally observed grants. This function never contacts the portal.
pub fn check_access() -> PermissionSnapshot {
    runtime::snapshot()
}

pub async fn shutdown() -> Result<()> {
    runtime::shutdown().await
}

/// Waits until the observed grant changes.
///
/// `seen` is the generation returned by the previous call, or zero to wait for
/// the next change. Resolves with `None` when [`shutdown`] ends this watch.
/// A call started after that shutdown waits for a later change.
pub async fn wait_for_access_change(seen: u32) -> Option<u32> {
    runtime::wait_for_access_change(seen).await
}

pub fn sources() -> Result<Vec<Source>> {
    runtime::sources()
}

/// Opens a PipeWire connection scoped to the selected live portal session.
/// Call this synchronous API from a capture worker, outside a Tokio async task.
pub fn open_pipewire(source_id: u32) -> Result<(OwnedFd, Source)> {
    runtime::open_pipewire(source_id)
}

/// One remote controller. Its held keys/buttons are released on drop.
pub struct InputConnection {
    id: u64,
}

impl InputConnection {
    /// Called on a blocking input worker, as are the other input methods.
    pub fn new(source_id: u32) -> Result<Self> {
        Ok(Self {
            id: runtime::attach(source_id)?,
        })
    }

    pub fn move_pointer(&mut self, x: f64, y: f64) -> Result<()> {
        self.send(input::Action::Move { x, y })
    }

    /// Linux evdev button code (e.g. BTN_LEFT = 272).
    pub fn button(&mut self, code: u32, pressed: bool) -> Result<()> {
        self.send(input::Action::Button { code, pressed })
    }

    /// Linux evdev key code, without X11's additional offset of eight.
    pub fn key(&mut self, code: u32, pressed: bool) -> Result<()> {
        self.send(input::Action::Key { code, pressed })
    }

    /// Smooth scroll deltas in logical pixels, positive right/down.
    pub fn wheel(&mut self, dx: f64, dy: f64) -> Result<()> {
        self.send(input::Action::Wheel { dx, dy })
    }

    pub fn release_all(&mut self) -> Result<()> {
        self.send(input::Action::Release)
    }

    fn send(&self, action: input::Action) -> Result<()> {
        runtime::input(self.id, action)
    }
}

impl Drop for InputConnection {
    fn drop(&mut self) {
        runtime::detach(self.id);
    }
}
