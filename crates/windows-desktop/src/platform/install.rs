use std::fs;
use std::io;
use std::os::windows::io::OwnedHandle;
use std::path::Path;
use std::time::{Duration, Instant};

use windows::Win32::Foundation::{WAIT_ABANDONED, WAIT_OBJECT_0, WAIT_TIMEOUT};
use windows::Win32::Security::{
    DACL_SECURITY_INFORMATION, PROTECTED_DACL_SECURITY_INFORMATION, SetFileSecurityW,
};
use windows::Win32::System::Services::*;
use windows::Win32::System::Threading::{
    CreateMutexW, GetExitCodeProcess, INFINITE, OpenProcess, PROCESS_SYNCHRONIZE, ReleaseMutex,
    WaitForSingleObject,
};
use windows::Win32::UI::Shell::{SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW, ShellExecuteExW};
use windows::Win32::UI::WindowsAndMessaging::SW_HIDE;
use windows::core::PCWSTR;

use super::pipe::SecurityDescriptor;
use super::{Pipe, SERVICE_NAME, broker, error, executable_path, owned, raw, service, wide};
use crate::ServiceStatus;

#[path = "../install_files.rs"]
mod install_files;
use install_files::PreparedInstall;

struct ServiceHandle(SC_HANDLE);
impl Drop for ServiceHandle {
    fn drop(&mut self) {
        // SAFETY: This object exclusively owns a service-control handle.
        let _ = unsafe { CloseServiceHandle(self.0) };
    }
}

fn manager(access: u32) -> io::Result<ServiceHandle> {
    // SAFETY: Null names address the local SCM, and the returned handle is owned.
    unsafe { OpenSCManagerW(PCWSTR::null(), PCWSTR::null(), access) }
        .map(ServiceHandle)
        .map_err(error)
}

fn open(manager: &ServiceHandle, access: u32) -> io::Result<Option<ServiceHandle>> {
    let name = wide(SERVICE_NAME);
    // SAFETY: The manager handle and terminated fixed name are valid.
    match unsafe { OpenServiceW(manager.0, PCWSTR(name.as_ptr()), access) }.map_err(error) {
        Ok(handle) => Ok(Some(ServiceHandle(handle))),
        Err(error) if error.raw_os_error() == Some(1060) => Ok(None),
        Err(error) => Err(error),
    }
}

fn query(handle: &ServiceHandle) -> io::Result<SERVICE_STATUS_PROCESS> {
    let mut status = SERVICE_STATUS_PROCESS::default();
    let mut needed = 0;
    // SAFETY: The byte slice spans exactly the initialized aligned status structure.
    let bytes = unsafe {
        std::slice::from_raw_parts_mut(
            (&mut status as *mut SERVICE_STATUS_PROCESS).cast(),
            size_of_val(&status),
        )
    };
    // SAFETY: The structure size matches SC_STATUS_PROCESS_INFO and the handle is live.
    unsafe { QueryServiceStatusEx(handle.0, SC_STATUS_PROCESS_INFO, Some(bytes), &mut needed) }
        .map_err(error)?;
    Ok(status)
}

pub(super) fn service_pid() -> io::Result<Option<u32>> {
    let manager = manager(SC_MANAGER_CONNECT)?;
    let Some(service) = open(&manager, SERVICE_QUERY_STATUS)? else {
        return Ok(None);
    };
    let status = query(&service)?;
    Ok(Some(if status.dwCurrentState == SERVICE_RUNNING {
        status.dwProcessId
    } else {
        0
    }))
}

pub fn status() -> io::Result<ServiceStatus> {
    let pid = service_pid()?;
    Ok(ServiceStatus {
        installed: pid.is_some(),
        running: pid.is_some_and(|pid| pid != 0),
    })
}

/// Fixed commands used by the packaged desktop UI and NSIS hooks. Privileged
/// commands install only this executable at its fixed system-owned destination.
pub fn run_cli(args: &[String], worker: fn(Pipe) -> io::Result<()>) -> io::Result<()> {
    match args.first().map(String::as_str) {
        Some("--worker") => broker::worker(&args[1..], worker),
        Some(command) if args.len() == 1 => match command {
            "status" => {
                println!(
                    "{}",
                    serde_json::to_string(&status()?).map_err(io::Error::other)?
                );
                Ok(())
            }
            "--service" => service::run(),
            "install" => install(false),
            "update" => install(true),
            "uninstall" => uninstall(),
            "elevate-install" => elevate("install"),
            "elevate-update" => {
                if status()?.installed {
                    elevate("update")
                } else {
                    Ok(())
                }
            }
            "elevate-uninstall" => {
                if status()?.installed || executable_path()?.try_exists()? {
                    elevate("uninstall")
                } else {
                    Ok(())
                }
            }
            _ => Err(usage()),
        },
        _ => Err(usage()),
    }
}

fn usage() -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidInput,
        "expected status, elevate-install, elevate-update, elevate-uninstall, install, update, or uninstall",
    )
}

fn elevate(command: &str) -> io::Result<()> {
    let executable = wide(std::env::current_exe()?);
    let verb = wide("runas");
    let command = wide(command);
    let mut info = SHELLEXECUTEINFOW {
        cbSize: size_of::<SHELLEXECUTEINFOW>() as u32,
        fMask: SEE_MASK_NOCLOSEPROCESS,
        lpVerb: PCWSTR(verb.as_ptr()),
        lpFile: PCWSTR(executable.as_ptr()),
        lpParameters: PCWSTR(command.as_ptr()),
        nShow: SW_HIDE.0,
        ..Default::default()
    };
    // SAFETY: All strings and output storage remain live for the synchronous launch.
    unsafe { ShellExecuteExW(&mut info) }.map_err(error)?;
    if info.hProcess.is_invalid() {
        return Err(io::Error::other(
            "elevated desktop installer did not return a process",
        ));
    }
    let process = owned(info.hProcess);
    // SAFETY: The process handle is valid; waiting happens in the standalone CLI.
    if unsafe { WaitForSingleObject(raw(&process), INFINITE) } != WAIT_OBJECT_0 {
        return Err(io::Error::last_os_error());
    }
    let mut code = 0;
    // SAFETY: The terminated process is still held and the DWORD output is valid.
    unsafe { GetExitCodeProcess(raw(&process), &mut code) }.map_err(error)?;
    if code != 0 {
        return Err(io::Error::other(format!(
            "desktop service installer exited with code {code}"
        )));
    }
    Ok(())
}

fn install(update_only: bool) -> io::Result<()> {
    let _setup = SetupLock::acquire()?;
    let manager = manager(SC_MANAGER_CONNECT | SC_MANAGER_CREATE_SERVICE)?;
    let existing = open(
        &manager,
        SERVICE_QUERY_STATUS | SERVICE_STOP | SERVICE_START | SERVICE_CHANGE_CONFIG,
    )?;
    if update_only && existing.is_none() {
        return Ok(());
    }
    let executable = executable_path()?;
    let directory = executable
        .parent()
        .ok_or_else(|| io::Error::other("invalid desktop service directory"))?;
    prepare_directory(directory)?;
    let source = fs::canonicalize(std::env::current_exe()?)?;
    if executable.exists() && fs::canonicalize(&executable)? == source {
        return Err(io::Error::other(
            "run installation from the application's bundled desktop service executable",
        ));
    }
    reject_reparse(&executable)?;
    for name in [
        "desktop-service.installing.exe",
        "desktop-service.previous.exe",
    ] {
        reject_reparse(&directory.join(name))?;
    }
    let mut files = PreparedInstall::stage(&source, &executable)?;
    protect(files.staging(), false)?;
    if let Some(previous) = files.previous() {
        protect(previous, false)?;
    }
    // Staging and its recovery copy are ready before interrupting a working service.
    let path = wide(format!("\"{}\" --service", executable.display()));
    if let Some(service) = existing {
        let was_running = query(&service)?.dwCurrentState != SERVICE_STOPPED;
        stop(&service)?;
        let result = (|| {
            files.replace()?;
            // SAFETY: The handle permits configuration and strings remain live. The
            // service account is explicitly reset to LocalSystem for this binary.
            unsafe {
                ChangeServiceConfigW(
                    service.0,
                    SERVICE_WIN32_OWN_PROCESS,
                    SERVICE_AUTO_START,
                    SERVICE_ERROR_NORMAL,
                    PCWSTR(path.as_ptr()),
                    PCWSTR::null(),
                    None,
                    PCWSTR::null(),
                    windows::core::w!("LocalSystem"),
                    PCWSTR::null(),
                    PCWSTR::null(),
                )
            }
            .map_err(error)?;
            start_service(&service)
        })();
        if let Err(failure) = result {
            let recovery = (|| {
                stop(&service)?;
                files.rollback()?;
                if was_running {
                    start_service(&service)?;
                }
                Ok(())
            })();
            return Err(setup_failure(failure, recovery));
        }
    } else {
        files.replace()?;
        let name = wide(SERVICE_NAME);
        let display = wide("DeskFleet Desktop Service");
        // SAFETY: The fixed service name/path and manager handle remain valid.
        let created = unsafe {
            CreateServiceW(
                manager.0,
                PCWSTR(name.as_ptr()),
                PCWSTR(display.as_ptr()),
                SERVICE_QUERY_STATUS | SERVICE_START | SERVICE_STOP | 0x0001_0000,
                SERVICE_WIN32_OWN_PROCESS,
                SERVICE_AUTO_START,
                SERVICE_ERROR_NORMAL,
                PCWSTR(path.as_ptr()),
                PCWSTR::null(),
                None,
                PCWSTR::null(),
                PCWSTR::null(),
                PCWSTR::null(),
            )
        }
        .map(ServiceHandle)
        .map_err(error);
        let service = match created {
            Ok(service) => service,
            Err(failure) => return Err(setup_failure(failure, files.rollback())),
        };
        if let Err(failure) = start_service(&service) {
            let recovery = (|| {
                stop(&service)?;
                // SAFETY: This transaction created the stopped service and owns DELETE rights.
                unsafe { DeleteService(service.0) }.map_err(error)?;
                files.rollback()
            })();
            return Err(setup_failure(failure, recovery));
        }
    }
    files.commit()
}

fn start_service(service: &ServiceHandle) -> io::Result<()> {
    // SAFETY: The service exists and accepts no service-start arguments.
    unsafe { StartServiceW(service.0, None) }.map_err(error)?;
    wait_state(service, SERVICE_RUNNING, None)
}

fn uninstall() -> io::Result<()> {
    let _setup = SetupLock::acquire()?;
    let manager = manager(SC_MANAGER_CONNECT)?;
    if let Some(service) = open(&manager, SERVICE_QUERY_STATUS | SERVICE_STOP | 0x0001_0000)? {
        stop(&service)?;
        // SAFETY: The handle has DELETE rights; the service and its process have stopped.
        unsafe { DeleteService(service.0) }.map_err(error)?;
    }
    let executable = executable_path()?;
    reject_reparse(&executable)?;
    if executable.exists() {
        fs::remove_file(&executable)?;
    }
    if let Some(directory) = executable.parent() {
        for name in [
            "desktop-service.installing.exe",
            "desktop-service.previous.exe",
        ] {
            let file = directory.join(name);
            reject_reparse(&file)?;
            if file.try_exists()? {
                fs::remove_file(file)?;
            }
        }
        if directory.try_exists()? {
            fs::remove_dir(directory)?;
        }
    }
    Ok(())
}

fn stop(service: &ServiceHandle) -> io::Result<()> {
    let status = query(service)?;
    let process = service_process(status.dwProcessId)?;
    if !matches!(
        status.dwCurrentState,
        SERVICE_STOPPED | SERVICE_STOP_PENDING
    ) {
        let mut output = SERVICE_STATUS::default();
        // SAFETY: The service handle permits STOP and output storage is initialized.
        unsafe { ControlService(service.0, SERVICE_CONTROL_STOP, &mut output) }.map_err(error)?;
    }
    wait_state(service, SERVICE_STOPPED, process)
}

fn wait_state(
    service: &ServiceHandle,
    expected: SERVICE_STATUS_CURRENT_STATE,
    mut process: Option<OwnedHandle>,
) -> io::Result<()> {
    let start = Instant::now();
    loop {
        let state = query(service)?;
        if process.is_none() {
            process = service_process(state.dwProcessId)?;
        }
        if state.dwCurrentState == expected {
            if expected == SERVICE_STOPPED {
                wait_process(process.as_ref())?;
            }
            return Ok(());
        }
        if expected == SERVICE_RUNNING && state.dwCurrentState == SERVICE_STOPPED {
            wait_process(process.as_ref())?;
            return Err(io::Error::other(format!(
                "desktop service failed to start (Windows error {})",
                state.dwWin32ExitCode
            )));
        }
        if start.elapsed() >= Duration::from_secs(20) {
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "desktop service did not finish changing state",
            ));
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

fn service_process(pid: u32) -> io::Result<Option<OwnedHandle>> {
    if pid == 0 {
        return Ok(None);
    }
    // SAFETY: SCM supplied this own-process service's PID. The retained handle
    // prevents PID reuse from changing what shutdown waits for.
    match unsafe { OpenProcess(PROCESS_SYNCHRONIZE, false, pid) }.map_err(error) {
        Ok(handle) => Ok(Some(owned(handle))),
        // The service may exit between QueryServiceStatusEx and OpenProcess.
        Err(error) if error.raw_os_error() == Some(87) => Ok(None),
        Err(error) => Err(error),
    }
}

fn wait_process(process: Option<&OwnedHandle>) -> io::Result<()> {
    let Some(process) = process else {
        return Ok(());
    };
    // SAFETY: This is the retained service process, and the wait is bounded.
    match unsafe { WaitForSingleObject(raw(process), 20_000) } {
        WAIT_OBJECT_0 => Ok(()),
        WAIT_TIMEOUT => Err(io::Error::new(
            io::ErrorKind::TimedOut,
            "desktop service process did not exit",
        )),
        _ => Err(io::Error::last_os_error()),
    }
}

#[derive(Debug)]
struct SetupFailure {
    failure: io::Error,
    recovery: io::Error,
}

impl std::fmt::Display for SetupFailure {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            formatter,
            "{}; restoring the previous installation also failed: {}",
            self.failure, self.recovery
        )
    }
}

impl std::error::Error for SetupFailure {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(&self.failure)
    }
}

fn setup_failure(failure: io::Error, recovery: io::Result<()>) -> io::Error {
    match recovery {
        Ok(()) => failure,
        Err(recovery) => io::Error::other(SetupFailure { failure, recovery }),
    }
}

/// Multiple per-user app installations share one service and its staging files.
struct SetupLock(OwnedHandle);

impl SetupLock {
    fn acquire() -> io::Result<Self> {
        let descriptor = SecurityDescriptor::new("D:P(A;;GA;;;SY)(A;;GA;;;BA)")?;
        let attributes = descriptor.attributes();
        // SAFETY: The fixed system-wide mutex and descriptor remain live for creation.
        let handle = owned(
            unsafe {
                CreateMutexW(
                    Some(&attributes),
                    false,
                    windows::core::w!("Global\\DeskFleetDesktopInstall"),
                )
            }
            .map_err(error)?,
        );
        // SAFETY: This process owns the live mutex handle; zero timeout never blocks setup.
        match unsafe { WaitForSingleObject(raw(&handle), 0) } {
            WAIT_OBJECT_0 | WAIT_ABANDONED => Ok(Self(handle)),
            WAIT_TIMEOUT => Err(io::Error::other(
                "Windows desktop service setup is already in progress",
            )),
            _ => Err(io::Error::last_os_error()),
        }
    }
}

impl Drop for SetupLock {
    fn drop(&mut self) {
        // SAFETY: acquire() returned only after this thread took ownership.
        if let Err(error) = unsafe { ReleaseMutex(raw(&self.0)) } {
            tracing::warn!(%error, "release Windows desktop setup mutex failed");
        }
    }
}

fn prepare_directory(directory: &Path) -> io::Result<()> {
    reject_reparse(directory)?;
    match fs::create_dir(directory) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(error),
    }
    protect(directory, true)
}

fn reject_reparse(path: &Path) -> io::Result<()> {
    use std::os::windows::fs::MetadataExt;
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_attributes() & 0x400 != 0 => Err(super::denied(
            "desktop service paths must not be reparse points",
        )),
        Ok(_) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

fn protect(path: &Path, directory: bool) -> io::Result<()> {
    let inherit = if directory { "OICI" } else { "" };
    let descriptor = SecurityDescriptor::new(&format!(
        "D:P(A;{inherit};FA;;;SY)(A;{inherit};FA;;;BA)(A;{inherit};FRFX;;;BU)"
    ))?;
    let path = wide(path);
    // SAFETY: The path and descriptor are valid, and the elevated installer owns
    // the fixed destination. Users receive read/execute, never replacement rights.
    unsafe {
        SetFileSecurityW(
            PCWSTR(path.as_ptr()),
            DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
            descriptor.as_ptr(),
        )
    }
    .ok()
    .map_err(error)
}
