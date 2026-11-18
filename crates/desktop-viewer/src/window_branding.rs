//! Product identity for the standalone viewer's native window and task switcher.

use std::sync::Arc;

use crate::nsh_ui::label;

// Match the installed desktop entry so Wayland shells find DeskFleet's icon.
pub(crate) const APP_ID: &str = "io.github.yet_another_ai.deskfleet";
const ICON: &[u8] = include_bytes!("../../../apps/desktop/build/viewer-icon.png");

pub(crate) fn title(machine: &str, locale: Option<&str>) -> String {
    let desktop = label(locale, "windowTitle");
    if machine.is_empty() {
        format!("{desktop} — DeskFleet")
    } else {
        format!("{machine} · {desktop} — DeskFleet")
    }
}

pub(crate) fn icon() -> Result<Arc<image::RgbaImage>, crate::Error> {
    Ok(Arc::new(
        image::load_from_memory_with_format(ICON, image::ImageFormat::Png)?.into_rgba8(),
    ))
}

#[cfg(target_os = "windows")]
mod windows;
#[cfg(target_os = "windows")]
pub(crate) use windows::WindowIcon;

#[cfg(not(target_os = "windows"))]
pub(crate) struct WindowIcon;

#[cfg(not(target_os = "windows"))]
impl WindowIcon {
    pub(crate) fn new(_window: &gpui::Window) -> Result<Self, crate::Error> {
        #[cfg(target_os = "macos")]
        set_application_icon()?;
        Ok(Self)
    }
}

#[cfg(target_os = "macos")]
#[allow(unsafe_code)] // AppKit has no safe wrapper for the application icon setter.
fn set_application_icon() -> Result<(), crate::Error> {
    use objc2::{AllocAnyThread, MainThreadMarker};
    use objc2_app_kit::{NSApplication, NSImage};
    use objc2_foundation::NSData;

    let main_thread = MainThreadMarker::new().ok_or("viewer icon requires the main thread")?;
    let data = NSData::with_bytes(ICON);
    let image = NSImage::initWithData(NSImage::alloc(), &data)
        .ok_or("cannot decode the viewer application icon")?;
    // SAFETY: the application is accessed on its main thread and receives a
    // live, non-null image, which AppKit retains for the Dock tile.
    unsafe { NSApplication::sharedApplication(main_thread).setApplicationIconImage(Some(&image)) };
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn window_title_identifies_the_machine_and_uses_the_selected_language() {
        assert_eq!(title("", None), "Remote desktop — DeskFleet");
        assert_eq!(
            title("Mac mini", Some("zh-cmn-Hans-CN")),
            "Mac mini · 远程桌面 — DeskFleet"
        );
        assert_eq!(
            title("Build host", Some("ja-JP")),
            "Build host · リモートデスクトップ — DeskFleet"
        );
    }
}
