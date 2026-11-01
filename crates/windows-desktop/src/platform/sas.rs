//! Secure attention is issued by the SCM service while impersonating its
//! authenticated console client. A SYSTEM media worker is not itself a service.

#![allow(unsafe_code)]

use std::io;

use windows::Win32::Foundation::{
    ERROR_FILE_NOT_FOUND, ERROR_PATH_NOT_FOUND, ERROR_SUCCESS, FreeLibrary, HMODULE,
};
use windows::Win32::System::LibraryLoader::{
    GetProcAddress, LOAD_LIBRARY_SEARCH_SYSTEM32, LoadLibraryExW,
};
use windows::Win32::System::Registry::{
    HKEY_LOCAL_MACHINE, REG_ROUTINE_FLAGS, RRF_RT_REG_DWORD, RRF_SUBKEY_WOW6464KEY, RegGetValueW,
};
use windows::core::{BOOL, s, w};

use super::{denied, error};

struct Module(HMODULE);

impl Drop for Module {
    fn drop(&mut self) {
        // SAFETY: This module was loaded successfully and no function pointer
        // escapes send(); the call has returned before its module is unloaded.
        if let Err(error) = unsafe { FreeLibrary(self.0) } {
            tracing::warn!(%error, "unload Windows secure attention library failed");
        }
    }
}

pub(super) fn send() -> io::Result<()> {
    if !service_policy_allowed()? {
        return Err(denied(
            "Windows policy must allow services to send Ctrl+Alt+Del: Windows Components > Windows Logon Options > Disable or enable software Secure Attention Sequence",
        ));
    }
    // SAFETY: Loading is restricted to the Windows system directory. The DLL
    // name is fixed, so a client cannot choose code for this privileged process.
    let module = Module(
        unsafe { LoadLibraryExW(w!("sas.dll"), None, LOAD_LIBRARY_SEARCH_SYSTEM32) }
            .map_err(error)?,
    );
    // SAFETY: The module is live and SendSAS is the documented system export.
    let address = unsafe { GetProcAddress(module.0, s!("SendSAS")) }
        .ok_or_else(|| io::Error::other("Windows does not provide SendSAS"))?;
    // SAFETY: sas.dll's documented SendSAS export has exactly this ABI and
    // signature. The system DLL remains loaded for the entire call.
    let send: unsafe extern "system" fn(BOOL) = unsafe { std::mem::transmute(address) };
    // SAFETY: The caller is the running SCM service, impersonating the
    // authenticated console client so Windows selects that client's session.
    // FALSE identifies the service path; this function has no return status.
    unsafe {
        send(BOOL(0));
    }
    Ok(())
}

/// Read current service availability and software SAS policy without connecting
/// to a worker, prompting for elevation, or changing machine configuration.
///
/// # Errors
/// Returns service-manager or registry query errors.
pub fn secure_attention_available() -> io::Result<bool> {
    let service = super::status()?;
    if !service.installed || !service.running {
        return Ok(false);
    }
    service_policy_allowed()
}

fn service_policy_allowed() -> io::Result<bool> {
    let mut value = 0u32;
    let mut size = size_of::<u32>() as u32;
    // SAFETY: The key/value names are fixed; value is aligned writable DWORD
    // storage and size describes it. This is a read-only policy query.
    let result = unsafe {
        RegGetValueW(
            HKEY_LOCAL_MACHINE,
            w!("Software\\Microsoft\\Windows\\CurrentVersion\\Policies\\System"),
            w!("SoftwareSASGeneration"),
            REG_ROUTINE_FLAGS(RRF_RT_REG_DWORD.0 | RRF_SUBKEY_WOW6464KEY.0),
            None,
            Some((&raw mut value).cast()),
            Some(&raw mut size),
        )
    };
    if !matches!(
        result,
        ERROR_SUCCESS | ERROR_FILE_NOT_FOUND | ERROR_PATH_NOT_FOUND
    ) {
        return Err(io::Error::from_raw_os_error(result.0 as i32));
    }
    // Policy values: 0 none; 1 services; 2 accessibility apps; 3 both.
    // Absent/disabled policy permits only secure-desktop accessibility apps.
    Ok(result == ERROR_SUCCESS && matches!(value, 1 | 3))
}
