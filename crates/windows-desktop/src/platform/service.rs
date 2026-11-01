use std::io;
use std::sync::{
    Mutex,
    atomic::{AtomicBool, Ordering},
};

use windows::Win32::System::Services::*;
use windows::core::{PCWSTR, PWSTR};

use super::{SERVICE_NAME, broker, error, wide};

static STOP: AtomicBool = AtomicBool::new(false);
static FAILURE: Mutex<Option<String>> = Mutex::new(None);

pub(super) fn run() -> io::Result<()> {
    STOP.store(false, Ordering::Release);
    let mut name = wide(SERVICE_NAME);
    let table = [
        SERVICE_TABLE_ENTRYW {
            lpServiceName: PWSTR(name.as_mut_ptr()),
            lpServiceProc: Some(service_main),
        },
        SERVICE_TABLE_ENTRYW::default(),
    ];
    // SAFETY: The terminated service table and function pointer remain valid for
    // the blocking dispatcher lifetime; callbacks never unwind across the ABI.
    unsafe { StartServiceCtrlDispatcherW(table.as_ptr()) }.map_err(error)?;
    if let Some(failure) = FAILURE
        .lock()
        .map_err(|_| io::Error::other("service result lock poisoned"))?
        .take()
    {
        return Err(io::Error::other(failure));
    }
    Ok(())
}

unsafe extern "system" fn service_main(_: u32, _: *mut PWSTR) {
    let result = std::panic::catch_unwind(|| {
        let name = wide(SERVICE_NAME);
        // SAFETY: The service name is null terminated and the callback is static.
        let handle =
            unsafe { RegisterServiceCtrlHandlerExW(PCWSTR(name.as_ptr()), Some(control), None) }
                .map_err(error)?;
        report(handle, SERVICE_START_PENDING, 0)?;
        let result = broker::serve(&STOP, || report(handle, SERVICE_RUNNING, 0));
        let code = if result.is_ok() { 0 } else { 1066 };
        report(handle, SERVICE_STOPPED, code)?;
        result
    });
    let failure = match result {
        Ok(Ok(())) => None,
        Ok(Err(error)) => Some(error.to_string()),
        Err(_) => Some("desktop service panicked".into()),
    };
    if let Ok(mut slot) = FAILURE.lock() {
        *slot = failure;
    }
}

unsafe extern "system" fn control(
    code: u32,
    _: u32,
    _: *mut std::ffi::c_void,
    _: *mut std::ffi::c_void,
) -> u32 {
    match code {
        SERVICE_CONTROL_STOP | SERVICE_CONTROL_SHUTDOWN => {
            STOP.store(true, Ordering::Release);
            0
        }
        SERVICE_CONTROL_INTERROGATE => 0,
        _ => 120,
    }
}

fn report(
    handle: SERVICE_STATUS_HANDLE,
    state: SERVICE_STATUS_CURRENT_STATE,
    exit_code: u32,
) -> io::Result<()> {
    let status = SERVICE_STATUS {
        dwServiceType: SERVICE_WIN32_OWN_PROCESS,
        dwCurrentState: state,
        dwControlsAccepted: if state == SERVICE_RUNNING {
            SERVICE_ACCEPT_STOP | SERVICE_ACCEPT_SHUTDOWN
        } else {
            0
        },
        dwWin32ExitCode: exit_code,
        dwServiceSpecificExitCode: u32::from(exit_code != 0),
        dwWaitHint: if state == SERVICE_START_PENDING {
            10_000
        } else {
            0
        },
        ..Default::default()
    };
    // SAFETY: The handler and status structure are valid for the synchronous call.
    unsafe { SetServiceStatus(handle, &status) }.map_err(error)
}
