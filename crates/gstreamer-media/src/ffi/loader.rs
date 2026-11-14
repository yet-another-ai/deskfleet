//! Find one optional GStreamer installation without changing process search paths.

use libloading::Library;

#[cfg(target_os = "linux")]
pub(super) fn load() -> Result<[Library; 4], String> {
    // SAFETY: These are the system GStreamer 1.x / GLib libraries. Their native
    // initialization is the documented loading contract; Api retains the handles.
    unsafe {
        Ok([
            Library::new("libgstreamer-1.0.so.0").map_err(|error| error.to_string())?,
            Library::new("libgstapp-1.0.so.0").map_err(|error| error.to_string())?,
            Library::new("libgstvideo-1.0.so.0").map_err(|error| error.to_string())?,
            Library::new("libglib-2.0.so.0").map_err(|error| error.to_string())?,
        ])
    }
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
use std::path::{Path, PathBuf};

#[cfg(target_os = "macos")]
pub(super) fn load() -> Result<[Library; 4], String> {
    load_from_directories(
        &[
            PathBuf::from("/Library/Frameworks/GStreamer.framework/Versions/Current/lib"),
            PathBuf::new(),
        ],
        [
            "libgstreamer-1.0.0.dylib",
            "libgstapp-1.0.0.dylib",
            "libgstvideo-1.0.0.dylib",
            "libglib-2.0.0.dylib",
        ],
    )
}

#[cfg(target_os = "windows")]
pub(super) fn load() -> Result<[Library; 4], String> {
    // The official runtime's bin directory must be on the process PATH so
    // GStreamer's own plugin loader can resolve each plugin's DLL dependencies.
    load_from_directories(
        &[PathBuf::new()],
        [
            "gstreamer-1.0-0.dll",
            "gstapp-1.0-0.dll",
            "gstvideo-1.0-0.dll",
            "glib-2.0-0.dll",
        ],
    )
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn load_from_directories(
    directories: &[PathBuf],
    names: [&str; 4],
) -> Result<[Library; 4], String> {
    let mut errors = Vec::new();
    for directory in directories {
        // Empty means the OS loader's default search.
        if !directory.as_os_str().is_empty() && !directory.join(names[0]).is_file() {
            continue;
        }
        let libraries = names.map(|name| load_library(&directory.join(name)));
        let [core, app, video, glib] = libraries;
        match (core, app, video, glib) {
            (Ok(core), Ok(app), Ok(video), Ok(glib)) => return Ok([core, app, video, glib]),
            (core, app, video, glib) => {
                for result in [core, app, video, glib] {
                    if let Err(error) = result {
                        errors.push(error);
                    }
                }
            }
        }
    }
    if errors.is_empty() {
        Err("GStreamer runtime was not found".into())
    } else {
        Err(errors.join("; "))
    }
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn load_library(path: &Path) -> Result<Library, String> {
    // SAFETY: The path names a GStreamer 1.x / GLib library with the documented
    // native initialization contract; Api retains each successful handle.
    let library = unsafe { Library::new(path) };
    library.map_err(|error| format!("{}: {error}", path.display()))
}
