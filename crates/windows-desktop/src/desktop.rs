//! Bind a windowless worker to its session's current input desktop.
//!
//! Handles stay on the OS thread that selected them. The caller must already
//! belong to the target interactive session and its WinSta0 window station.

#![allow(unsafe_code)]

use std::{cell::RefCell, io};

use windows::Win32::Foundation::HANDLE;
use windows::Win32::System::StationsAndDesktops::{
    CloseDesktop, DESKTOP_ACCESS_FLAGS, DESKTOP_CONTROL_FLAGS, DESKTOP_CREATEWINDOW,
    DESKTOP_READOBJECTS, DESKTOP_WRITEOBJECTS, GetThreadDesktop, GetUserObjectInformationW, HDESK,
    OpenInputDesktop, SetThreadDesktop, UOI_NAME,
};
use windows::Win32::System::Threading::GetCurrentThreadId;

thread_local! {
    static DESKTOP: RefCell<Option<Binding>> = const { RefCell::new(None) };
}

struct OpenDesktop(HDESK);

impl Drop for OpenDesktop {
    fn drop(&mut self) {
        // SAFETY: This handle came from OpenInputDesktop, not GetThreadDesktop.
        // Binding switches away before dropping the handle it selected.
        if let Err(error) = unsafe { CloseDesktop(self.0) } {
            tracing::warn!(%error, "close worker desktop handle failed");
        }
    }
}

struct Binding {
    original: HDESK,
    selected: OpenDesktop,
    name: Vec<u16>,
    generation: u64,
}

impl Binding {
    fn select(&mut self, desktop: OpenDesktop, name: Vec<u16>) -> io::Result<u64> {
        if name != self.name {
            // SAFETY: This TLS value is used only on its owning thread. The
            // handle belongs to this process's window station; no UI is created.
            unsafe { SetThreadDesktop(desktop.0) }.map_err(os_error)?;
            self.selected = desktop;
            self.name = name;
            self.generation = self.generation.wrapping_add(1);
        }
        Ok(self.generation)
    }
}

impl Drop for Binding {
    fn drop(&mut self) {
        // SAFETY: original is the borrowed desktop of this same OS thread before
        // binding. Restoring it permits selected to close during field cleanup.
        if let Err(error) = unsafe { SetThreadDesktop(self.original) } {
            tracing::warn!(%error, "restore worker desktop failed");
        }
    }
}

/// Select the desktop receiving input and return this thread's binding epoch.
///
/// The epoch changes when the desktop's name changes. Capture users must also
/// invalidate their surfaces on DXGI access loss (a switch can happen between
/// two calls). This function never activates a desktop or unlocks a session.
///
/// # Errors
/// Returns the Windows access or thread-binding error. Call only on windowless
/// worker threads: Windows disallows moving a thread that owns windows or hooks.
pub fn bind_input_desktop() -> io::Result<u64> {
    // SAFETY: No handles are inherited. These rights allow capture/input and
    // creation of the framework's internal desktop objects, never ACL changes.
    let desktop = OpenDesktop(
        unsafe {
            OpenInputDesktop(
                DESKTOP_CONTROL_FLAGS(0),
                false,
                DESKTOP_ACCESS_FLAGS(
                    DESKTOP_READOBJECTS.0 | DESKTOP_WRITEOBJECTS.0 | DESKTOP_CREATEWINDOW.0,
                ),
            )
        }
        .map_err(os_error)?,
    );
    let name = desktop_name(desktop.0)?;
    DESKTOP.with(|state| {
        let mut state = state.borrow_mut();
        if let Some(binding) = state.as_mut() {
            return binding.select(desktop, name);
        }
        // SAFETY: The thread ID is this thread; GetThreadDesktop returns a
        // borrowed handle which is retained only in this thread's TLS value.
        let original = unsafe { GetThreadDesktop(GetCurrentThreadId()) }.map_err(os_error)?;
        // SAFETY: This desktop was opened from this session's input window
        // station; the caller promises a windowless worker thread.
        unsafe { SetThreadDesktop(desktop.0) }.map_err(os_error)?;
        *state = Some(Binding {
            original,
            selected: desktop,
            name,
            generation: 1,
        });
        Ok(1)
    })
}

fn desktop_name(desktop: HDESK) -> io::Result<Vec<u16>> {
    let mut required = 0;
    // SAFETY: Null output asks Windows for the required byte count; required is
    // valid writable storage. This call normally reports insufficient buffer.
    let _ = unsafe {
        GetUserObjectInformationW(
            HANDLE(desktop.0),
            UOI_NAME,
            None,
            0,
            Some(&raw mut required),
        )
    };
    if required == 0 || required % 2 != 0 || required > 64 * 1024 {
        return Err(io::Error::other("invalid Windows desktop name size"));
    }
    let mut name = vec![0u16; required as usize / 2];
    // SAFETY: name has the exact byte count returned above and desktop remains
    // open. Windows writes a nul-terminated UTF-16 object name into this buffer.
    unsafe {
        GetUserObjectInformationW(
            HANDLE(desktop.0),
            UOI_NAME,
            Some(name.as_mut_ptr().cast()),
            required,
            None,
        )
    }
    .map_err(os_error)?;
    if let Some(end) = name.iter().position(|character| *character == 0) {
        name.truncate(end);
    }
    Ok(name)
}

fn os_error(error: windows::core::Error) -> io::Error {
    io::Error::other(error)
}
