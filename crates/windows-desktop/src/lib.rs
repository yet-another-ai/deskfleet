//! Optional Windows desktop service. The business daemon remains a user process.
//!
//! The service grants only the requesting console user's desktop and launches
//! a copy of its own protected executable in that session. Media travels over
//! local named pipes; this crate has no network or daemon authority.
//!
//! An accompanying on-demand maintenance service (`DeskFleetMaintenance`) can
//! apply Ed25519-signed updates to `DeskFleetDesktop` without prompting for UAC.

pub mod manifest;

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceStatus {
    pub installed: bool,
    pub running: bool,
    #[serde(default)]
    pub maintenance_installed: bool,
    #[serde(default)]
    pub update_available: bool,
    #[serde(default)]
    pub silent_update_available: bool,
}

#[cfg(any(windows, test))]
mod install_files;

#[cfg(windows)]
pub mod desktop;
#[cfg(windows)]
mod platform;
#[cfg(windows)]
pub use platform::{
    Pipe, connect, run_cli, run_maintenance_cli, secure_attention_available, send_secure_attention,
    status,
};
