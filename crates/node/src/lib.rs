//! Thin Node-API boundary for the TypeScript daemon and desktop integrations.

use napi_derive::napi;

mod catalog;
mod media;
mod permissions;
mod rtc;
mod terminal;

pub use catalog::{
    CatalogDirectory, CatalogSnapshot, CatalogWorkspace, CatalogWorkspaceSession, CatalogWorktree,
    NativeCatalog, open_catalog, open_in_memory_catalog,
};
pub use media::{DesktopConfig, DisplayInfo, capture_displays, supported_video_codecs};
pub use permissions::{
    check_accessibility_access, check_full_disk_access, check_screen_capture_access,
    request_accessibility_access, request_full_disk_access, request_screen_capture_access,
};
pub use rtc::{
    IceCandidate, IceServer, NativePeer, PeerConfig, PeerEvent, VideoCodec, create_peer,
};
pub use terminal::{NativeTerminal, TerminalConfig, TerminalEvent, create_terminal};

/// Build information for the loaded native addon.
#[napi(object)]
pub struct NativeInfo {
    pub version: String,
    pub os: String,
    pub arch: String,
}

/// Report the loaded addon version and platform without requiring a display.
#[napi]
pub fn native_info() -> NativeInfo {
    let platform = deskfleet_native::platform_info();
    NativeInfo {
        version: env!("CARGO_PKG_VERSION").to_owned(),
        os: platform.os.to_owned(),
        arch: platform.arch.to_owned(),
    }
}
