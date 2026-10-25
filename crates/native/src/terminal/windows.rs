//! Wait for Windows process cleanup before releasing a terminal's working directory.

#![allow(unsafe_code)]

use portable_pty::Child;
use windows::Win32::Foundation::{HANDLE, WAIT_FAILED, WAIT_OBJECT_0};
use windows::Win32::System::Threading::{INFINITE, WaitForSingleObject};

use super::{Result, backend};

pub(super) fn wait_for_termination(child: &dyn Child) -> Result<()> {
    let handle = child
        .as_raw_handle()
        .ok_or_else(|| backend("wait for termination", "child has no process handle"))?;
    // portable-pty 0.9 can return from wait() when an exit code is available,
    // before asynchronous TerminateProcess has finished releasing resources.
    // SAFETY: The caller holds the child mutex for this entire wait. The child
    // owns this process handle and keeps it valid; this function only borrows it.
    let result = unsafe { WaitForSingleObject(HANDLE(handle), INFINITE) };
    match result {
        WAIT_OBJECT_0 => Ok(()),
        WAIT_FAILED => Err(backend(
            "wait for termination",
            std::io::Error::last_os_error(),
        )),
        other => Err(backend(
            "wait for termination",
            format!("unexpected wait result: {}", other.0),
        )),
    }
}
