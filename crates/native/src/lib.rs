//! Native platform capabilities, independent of Node.js and the HTTP server.

pub mod desktop_access;
pub mod filesystem_permissions;
pub mod input;
pub mod local_applications;
pub mod media;
#[cfg(target_os = "macos")]
mod permission_settings;
pub mod rtc;
pub mod system_status;
pub mod terminal;

/// The operating system and architecture this library was built for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PlatformInfo {
    pub os: &'static str,
    pub arch: &'static str,
}

/// Return build-target information without initializing any graphical subsystem.
pub const fn platform_info() -> PlatformInfo {
    PlatformInfo {
        os: std::env::consts::OS,
        arch: std::env::consts::ARCH,
    }
}
