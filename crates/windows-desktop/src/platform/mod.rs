// Win32 capability boundaries are isolated here; each call documents ownership.
#![allow(unsafe_code)]

mod broker;
mod identity;
mod install;
mod pipe;
mod sas;
mod service;

pub use broker::{connect, send_secure_attention};
pub use install::{run_cli, status};
pub use pipe::Pipe;
pub use sas::secure_attention_available;

use std::io;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::path::Path;
use windows::Win32::Foundation::HANDLE;

const SERVICE_NAME: &str = "DeskFleetDesktop";
const BROKER_PIPE: &str = r"\\.\pipe\deskfleet-desktop-service";
const EXECUTABLE: &str = "deskfleet-desktop-service.exe";

fn wide(value: impl AsRef<std::ffi::OsStr>) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    value.as_ref().encode_wide().chain(Some(0)).collect()
}

fn error(error: windows::core::Error) -> io::Error {
    io::Error::from_raw_os_error(error.code().0 & 0xffff)
}

fn denied(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::PermissionDenied, message)
}

fn raw(handle: &impl AsRawHandle) -> HANDLE {
    HANDLE(handle.as_raw_handle())
}

/// Takes ownership of a newly returned Win32 kernel handle.
fn owned(handle: HANDLE) -> OwnedHandle {
    // SAFETY: All callers pass a successful API's newly owned handle.
    unsafe { OwnedHandle::from_raw_handle(handle.0) }
}

fn executable_path() -> io::Result<std::path::PathBuf> {
    use windows::Win32::System::Com::CoTaskMemFree;
    use windows::Win32::UI::Shell::{FOLDERID_ProgramFiles, SHGetKnownFolderPath};
    // SAFETY: The known folder is fixed and the returned COM allocation is freed.
    let path = unsafe { SHGetKnownFolderPath(&FOLDERID_ProgramFiles, Default::default(), None) }
        .map_err(error)?;
    // SAFETY: SHGetKnownFolderPath returned a null-terminated UTF-16 allocation.
    let text = unsafe { path.to_string() }.map_err(io::Error::other);
    // SAFETY: The allocation was returned by SHGetKnownFolderPath.
    unsafe { CoTaskMemFree(Some(path.0.cast())) };
    Ok(Path::new(&text?)
        .join("DeskFleet Desktop Service")
        .join(EXECUTABLE))
}
