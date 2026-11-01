//! Optional Windows desktop service. The business daemon remains a user process.
//!
//! The service grants only the requesting console user's desktop and launches
//! a copy of its own protected executable in that session. Media travels over
//! local named pipes; this crate has no network or daemon authority.

#[derive(Debug, Clone, Copy, serde::Serialize, serde::Deserialize)]
pub struct ServiceStatus {
    pub installed: bool,
    pub running: bool,
}

#[cfg(all(test, not(windows)))]
mod install_files;

#[cfg(windows)]
pub mod desktop;
#[cfg(windows)]
mod platform;
#[cfg(windows)]
pub use platform::{
    Pipe, connect, run_cli, secure_attention_available, send_secure_attention, status,
};
