use std::fs;
use std::io;
use std::os::windows::io::OwnedHandle;
use std::path::Path;
use std::str::FromStr;
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
use super::{
    BUNDLED_MANIFEST_FILE, EXECUTABLE, MAINTENANCE_EXECUTABLE, MAINTENANCE_SERVICE_NAME, Pipe,
    SERVICE_NAME, broker, error, executable_path, installed_record_path, maintenance,
    maintenance_executable_path, owned, raw, service, wide,
};
use crate::ServiceStatus;
use crate::install_files::PreparedInstall;
use crate::manifest::{
    InstalledRecord, SemVer, ServiceManifest, check_version_floor, sha256_file,
    trusted_public_keys, verify_manifest,
};

const DELETE_RIGHT: u32 = 0x0001_0000;
const WRITE_DAC_RIGHT: u32 = 0x0004_0000;
const MAINTENANCE_SERVICE_SDDL: &str = "D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;0x00000014;;;IU)";

pub(super) struct ServiceHandle(pub(super) SC_HANDLE);
impl Drop for ServiceHandle {
    fn drop(&mut self) {
        // SAFETY: This object exclusively owns a service-control handle.
        let _ = unsafe { CloseServiceHandle(self.0) };
    }
}

pub(super) fn manager(access: u32) -> io::Result<ServiceHandle> {
    // SAFETY: Null names address the local SCM, and the returned handle is owned.
    unsafe { OpenSCManagerW(PCWSTR::null(), PCWSTR::null(), access) }
        .map(ServiceHandle)
        .map_err(error)
}

pub(super) fn open_named(
    manager: &ServiceHandle,
    service_name: &str,
    access: u32,
) -> io::Result<Option<ServiceHandle>> {
    let name = wide(service_name);
    // SAFETY: The manager handle and terminated fixed name are valid.
    match unsafe { OpenServiceW(manager.0, PCWSTR(name.as_ptr()), access) }.map_err(error) {
        Ok(handle) => Ok(Some(ServiceHandle(handle))),
        Err(error) if error.raw_os_error() == Some(1060) => Ok(None),
        Err(error) => Err(error),
    }
}

pub(super) fn query(handle: &ServiceHandle) -> io::Result<SERVICE_STATUS_PROCESS> {
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

pub(super) fn service_pid_named(service_name: &str) -> io::Result<Option<u32>> {
    let manager = manager(SC_MANAGER_CONNECT)?;
    let Some(service) = open_named(&manager, service_name, SERVICE_QUERY_STATUS)? else {
        return Ok(None);
    };
    let status = query(&service)?;
    Ok(Some(if status.dwCurrentState == SERVICE_RUNNING {
        status.dwProcessId
    } else {
        0
    }))
}

pub(super) fn service_pid() -> io::Result<Option<u32>> {
    service_pid_named(SERVICE_NAME)
}

fn maintenance_installed() -> io::Result<bool> {
    Ok(service_pid_named(MAINTENANCE_SERVICE_NAME)?.is_some()
        && maintenance_executable_path()?.try_exists()?)
}

/// Fast SCM-only status query used by runtime capability discovery.
pub fn status() -> io::Result<ServiceStatus> {
    let pid = service_pid()?;
    Ok(ServiceStatus {
        installed: pid.is_some(),
        running: pid.is_some_and(|pid| pid != 0),
        maintenance_installed: maintenance_installed()?,
        update_available: false,
        silent_update_available: false,
    })
}

/// Extended status query for the packaged desktop CLI that also inspects whether
/// the bundled desktop service binary differs from the installed service and
/// whether a signed silent update is available via `DeskFleetMaintenance`.
fn cli_status() -> io::Result<ServiceStatus> {
    let mut current = status()?;
    if !current.installed {
        return Ok(current);
    }
    let bundled = std::env::current_exe()?;
    if bundled
        .file_name()
        .and_then(|name| name.to_str())
        .is_none_or(|name| !name.eq_ignore_ascii_case(EXECUTABLE))
    {
        return Ok(current);
    }
    let installed_exe = executable_path()?;
    if installed_exe.try_exists()?
        && fs::canonicalize(&bundled).ok() == fs::canonicalize(&installed_exe).ok()
    {
        return Ok(current);
    }
    let (bundled_sha256, bundled_size) = sha256_file(&bundled)?;
    let installed_sha256 = installed_exe
        .try_exists()?
        .then(|| sha256_file(&installed_exe).ok().map(|(hash, _)| hash))
        .flatten();
    let binary_differs = installed_sha256.as_deref() != Some(bundled_sha256.as_str());
    current.update_available = !current.maintenance_installed || binary_differs;
    if current.maintenance_installed && binary_differs {
        current.silent_update_available = can_silent_update(
            &bundled,
            &bundled_sha256,
            bundled_size,
            installed_sha256.as_deref(),
        );
    }
    Ok(current)
}

fn can_silent_update(
    bundled_exe: &Path,
    bundled_sha256: &str,
    bundled_size: u64,
    installed_sha256: Option<&str>,
) -> bool {
    let Some(directory) = bundled_exe.parent() else {
        return false;
    };
    let Ok(raw) = fs::read_to_string(directory.join(BUNDLED_MANIFEST_FILE)) else {
        return false;
    };
    let Ok(manifest) = serde_json::from_str::<ServiceManifest>(&raw) else {
        return false;
    };
    let Ok(candidate) = verify_manifest(
        &manifest,
        bundled_sha256,
        bundled_size,
        trusted_public_keys(),
    ) else {
        return false;
    };
    let Ok(floor) = installed_version_floor() else {
        return false;
    };
    matches!(
        check_version_floor(&candidate, bundled_sha256, &floor, installed_sha256),
        Ok(true)
    )
}

pub(super) fn read_installed_record() -> io::Result<Option<InstalledRecord>> {
    let path = installed_record_path()?;
    reject_reparse(&path)?;
    match fs::read_to_string(&path) {
        Ok(raw) => serde_json::from_str(&raw)
            .map(Some)
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

pub(super) fn installed_version_floor() -> io::Result<SemVer> {
    let compiled = SemVer::from_str(env!("CARGO_PKG_VERSION"))?;
    let recorded =
        read_installed_record()?.and_then(|record| SemVer::from_str(&record.version).ok());
    Ok(match recorded {
        Some(version) if version > compiled => version,
        _ => compiled,
    })
}

pub(super) fn write_installed_record(record: &InstalledRecord) -> io::Result<()> {
    let path = installed_record_path()?;
    let staging = path.with_extension("json.tmp");
    reject_reparse(&path)?;
    reject_reparse(&staging)?;
    let bytes = serde_json::to_vec_pretty(record).map_err(io::Error::other)?;
    fs::write(&staging, bytes)?;
    protect(&staging, false)?;
    fs::rename(&staging, &path)?;
    protect(&path, false)
}

/// Fixed commands used by the packaged desktop UI and NSIS hooks. Privileged
/// commands install only the bundled service executables at their fixed
/// system-owned destination.
pub fn run_cli(args: &[String], worker: fn(Pipe) -> io::Result<()>) -> io::Result<()> {
    match args.first().map(String::as_str) {
        Some("--worker") => broker::worker(&args[1..], worker),
        Some(command) if args.len() == 1 => match command {
            "status" => {
                println!(
                    "{}",
                    serde_json::to_string(&cli_status()?).map_err(io::Error::other)?
                );
                Ok(())
            }
            "--service" => service::run(),
            "install" => install(false),
            "update" => install(true),
            "uninstall" => uninstall(),
            "maintenance-update" => maintenance::request_update(),
            "elevate-install" => elevate("install"),
            "elevate-update" => {
                if status()?.installed {
                    elevate("update")
                } else {
                    Ok(())
                }
            }
            "elevate-uninstall" => {
                let current = status()?;
                if current.installed
                    || current.maintenance_installed
                    || executable_path()?.try_exists()?
                    || maintenance_executable_path()?.try_exists()?
                {
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
        "expected status, maintenance-update, elevate-install, elevate-update, elevate-uninstall, install, update, or uninstall",
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
    let existing = open_named(
        &manager,
        SERVICE_NAME,
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
            configure_desktop_service(&service, &path)?;
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
                SERVICE_QUERY_STATUS | SERVICE_START | SERVICE_STOP | DELETE_RIGHT,
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
    files.commit()?;
    let (sha256, _) = sha256_file(&executable)?;
    let record_version = read_bundled_manifest_version(&source, &sha256)
        .unwrap_or_else(|| env!("CARGO_PKG_VERSION").to_owned());
    write_installed_record(&InstalledRecord {
        version: record_version,
        sha256,
    })?;
    if let Some(maintenance_source) = source
        .parent()
        .map(|parent| parent.join(MAINTENANCE_EXECUTABLE))
        && maintenance_source.try_exists()?
    {
        install_maintenance_service(&manager, &maintenance_source)?;
    }
    Ok(())
}

fn read_bundled_manifest_version(bundled_exe: &Path, actual_sha256: &str) -> Option<String> {
    let manifest_path = bundled_exe.parent()?.join(BUNDLED_MANIFEST_FILE);
    let raw = fs::read_to_string(manifest_path).ok()?;
    let manifest: ServiceManifest = serde_json::from_str(&raw).ok()?;
    if manifest.sha256 == actual_sha256 && SemVer::from_str(&manifest.version).is_ok() {
        Some(manifest.version)
    } else {
        None
    }
}

fn install_maintenance_service(manager: &ServiceHandle, source: &Path) -> io::Result<()> {
    let executable = maintenance_executable_path()?;
    let directory = executable
        .parent()
        .ok_or_else(|| io::Error::other("invalid maintenance service directory"))?;
    prepare_directory(directory)?;
    reject_reparse(&executable)?;
    for name in [
        "maintenance-service.installing.exe",
        "maintenance-service.previous.exe",
    ] {
        reject_reparse(&directory.join(name))?;
    }
    let existing = open_named(
        manager,
        MAINTENANCE_SERVICE_NAME,
        SERVICE_QUERY_STATUS | SERVICE_STOP | SERVICE_CHANGE_CONFIG | WRITE_DAC_RIGHT,
    )?;
    let mut files = PreparedInstall::stage_named(
        source,
        &executable,
        "maintenance-service.installing.exe",
        "maintenance-service.previous.exe",
    )?;
    protect(files.staging(), false)?;
    if let Some(previous) = files.previous() {
        protect(previous, false)?;
    }
    let path = wide(format!("\"{}\" --service", executable.display()));
    if let Some(service) = existing {
        stop(&service)?;
        let result = (|| {
            files.replace()?;
            // SAFETY: The handle permits configuration and strings remain live.
            unsafe {
                ChangeServiceConfigW(
                    service.0,
                    SERVICE_WIN32_OWN_PROCESS,
                    SERVICE_DEMAND_START,
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
            protect_maintenance_service(&service)
        })();
        if let Err(failure) = result {
            return Err(setup_failure(failure, files.rollback()));
        }
    } else {
        files.replace()?;
        let name = wide(MAINTENANCE_SERVICE_NAME);
        let display = wide("DeskFleet Maintenance Service");
        // SAFETY: The fixed service name/path and manager handle remain valid.
        let created = unsafe {
            CreateServiceW(
                manager.0,
                PCWSTR(name.as_ptr()),
                PCWSTR(display.as_ptr()),
                SERVICE_QUERY_STATUS | SERVICE_STOP | DELETE_RIGHT | WRITE_DAC_RIGHT,
                SERVICE_WIN32_OWN_PROCESS,
                SERVICE_DEMAND_START,
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
        if let Err(failure) = protect_maintenance_service(&service) {
            let recovery = (|| {
                // SAFETY: This transaction created the service and owns DELETE rights.
                unsafe { DeleteService(service.0) }.map_err(error)?;
                files.rollback()
            })();
            return Err(setup_failure(failure, recovery));
        }
    }
    files.commit()
}

fn protect_maintenance_service(service: &ServiceHandle) -> io::Result<()> {
    let descriptor = SecurityDescriptor::new(MAINTENANCE_SERVICE_SDDL)?;
    // SAFETY: The handle owns WRITE_DAC and the security descriptor remains live.
    // Interactive users receive only SERVICE_QUERY_STATUS | SERVICE_START (0x14).
    unsafe {
        SetServiceObjectSecurity(
            service.0,
            DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
            descriptor.as_ptr(),
        )
    }
    .map_err(error)
}

pub(super) fn configure_desktop_service(service: &ServiceHandle, path: &[u16]) -> io::Result<()> {
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
    .map_err(error)
}

pub(super) fn start_service(service: &ServiceHandle) -> io::Result<()> {
    // SAFETY: The service exists and accepts no service-start arguments.
    unsafe { StartServiceW(service.0, None) }.map_err(error)?;
    wait_state(service, SERVICE_RUNNING, None)
}

fn uninstall() -> io::Result<()> {
    let _setup = SetupLock::acquire()?;
    let manager = manager(SC_MANAGER_CONNECT)?;
    for service_name in [MAINTENANCE_SERVICE_NAME, SERVICE_NAME] {
        if let Some(service) = open_named(
            &manager,
            service_name,
            SERVICE_QUERY_STATUS | SERVICE_STOP | DELETE_RIGHT,
        )? {
            stop(&service)?;
            // SAFETY: The handle has DELETE rights; the service and its process have stopped.
            unsafe { DeleteService(service.0) }.map_err(error)?;
        }
    }
    let executable = executable_path()?;
    let maintenance_executable = maintenance_executable_path()?;
    let record = installed_record_path()?;
    for file in [&executable, &maintenance_executable, &record] {
        reject_reparse(file)?;
        if file.try_exists()? {
            fs::remove_file(file)?;
        }
    }
    if let Some(directory) = executable.parent() {
        for name in [
            "desktop-service.installing.exe",
            "desktop-service.previous.exe",
            "desktop-service.installed.json.tmp",
            "maintenance-service.installing.exe",
            "maintenance-service.previous.exe",
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

pub(super) fn stop(service: &ServiceHandle) -> io::Result<()> {
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

pub(super) fn wait_state(
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

pub(super) fn setup_failure(failure: io::Error, recovery: io::Result<()>) -> io::Error {
    match recovery {
        Ok(()) => failure,
        Err(recovery) => io::Error::other(SetupFailure { failure, recovery }),
    }
}

/// Multiple per-user app installations share one service and its staging files.
pub(super) struct SetupLock(OwnedHandle);

impl SetupLock {
    pub(super) fn acquire() -> io::Result<Self> {
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

pub(super) fn prepare_directory(directory: &Path) -> io::Result<()> {
    reject_reparse(directory)?;
    match fs::create_dir(directory) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(error),
    }
    protect(directory, true)
}

pub(super) fn reject_reparse(path: &Path) -> io::Result<()> {
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

pub(super) fn protect(path: &Path, directory: bool) -> io::Result<()> {
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
