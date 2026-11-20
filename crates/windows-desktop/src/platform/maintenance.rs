//! On-demand Windows maintenance service for signed `DeskFleetDesktop` updates.
//!
//! The service stays stopped (`SERVICE_DEMAND_START`) until an interactive user
//! starts it through SCM. Instead of opening any caller-supplied filesystem path
//! as `LocalSystem`, the caller streams the binary bytes over an authenticated
//! local named pipe directly into the protected staging file, where the service
//! verifies SHA-256, Ed25519 signature, and anti-downgrade version rules before
//! atomically replacing `deskfleet-desktop-service.exe`.

use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::sync::{
    Mutex,
    atomic::{AtomicBool, Ordering},
};
use std::time::{Duration, Instant};

use sha2::{Digest as _, Sha256};
use windows::Win32::System::Services::*;
use windows::core::{PCWSTR, PWSTR};

use super::identity::{pipe_client, require_console, require_system};
use super::install::{
    SetupLock, configure_desktop_service, installed_version_floor, manager, open_named,
    prepare_directory, protect, query, read_installed_record, reject_reparse, setup_failure,
    start_service, stop, write_installed_record,
};
use super::{
    BUNDLED_MANIFEST_FILE, MAINTENANCE_PIPE, MAINTENANCE_SERVICE_NAME, Pipe, SERVICE_NAME, denied,
    error, executable_path, maintenance_executable_path, wide,
};
use crate::install_files::PreparedInstall;
use crate::manifest::{
    InstalledRecord, MAX_SERVICE_BINARY_SIZE, ServiceManifest, check_version_floor, encode_hex,
    sha256_file, should_update_installed_record, trusted_public_keys, verify_manifest,
};

const MAX_MESSAGE: usize = 16 * 1024;
const IDLE_ACCEPT_TIMEOUT: Duration = Duration::from_secs(30);
const HANDSHAKE_MAGIC: [u8; 3] = *b"DM\x01";

static STOP: AtomicBool = AtomicBool::new(false);
static FAILURE: Mutex<Option<String>> = Mutex::new(None);

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MaintenanceRequest {
    manifest: ServiceManifest,
}

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MaintenanceReply {
    ok: bool,
    updated: bool,
    version: Option<String>,
    error: Option<String>,
}

/// Entry point for the dedicated `deskfleet-maintenance-service.exe` binary.
///
/// # Errors
/// Returns an error for unknown arguments or SCM service execution failures.
pub fn run_maintenance_cli(args: &[String]) -> io::Result<()> {
    match args.first().map(String::as_str) {
        Some("--service") if args.len() == 1 => run_service(),
        _ => Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "expected --service",
        )),
    }
}

fn run_service() -> io::Result<()> {
    STOP.store(false, Ordering::Release);
    let mut name = wide(MAINTENANCE_SERVICE_NAME);
    let table = [
        SERVICE_TABLE_ENTRYW {
            lpServiceName: PWSTR(name.as_mut_ptr()),
            lpServiceProc: Some(service_main),
        },
        SERVICE_TABLE_ENTRYW::default(),
    ];
    // SAFETY: The terminated service table and callback remain valid for the
    // blocking dispatcher lifetime; callbacks catch panics before crossing FFI.
    unsafe { StartServiceCtrlDispatcherW(table.as_ptr()) }.map_err(error)?;
    if let Some(failure) = FAILURE
        .lock()
        .map_err(|_| io::Error::other("maintenance service result lock poisoned"))?
        .take()
    {
        return Err(io::Error::other(failure));
    }
    Ok(())
}

unsafe extern "system" fn service_main(_: u32, _: *mut PWSTR) {
    let result = std::panic::catch_unwind(|| {
        let name = wide(MAINTENANCE_SERVICE_NAME);
        // SAFETY: The service name is null terminated and the handler is static.
        let handle =
            unsafe { RegisterServiceCtrlHandlerExW(PCWSTR(name.as_ptr()), Some(control), None) }
                .map_err(error)?;
        report(handle, SERVICE_START_PENDING, 0)?;
        let result = serve(&STOP, || report(handle, SERVICE_RUNNING, 0));
        let code = if result.is_ok() { 0 } else { 1066 };
        report(handle, SERVICE_STOPPED, code)?;
        result
    });
    let failure = match result {
        Ok(Ok(())) => None,
        Ok(Err(error)) => Some(error.to_string()),
        Err(_) => Some("maintenance service panicked".into()),
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
    // SAFETY: The handler and status structure remain valid for the synchronous call.
    unsafe { SetServiceStatus(handle, &status) }.map_err(error)
}

fn serve(stop: &'static AtomicBool, ready: impl FnOnce() -> io::Result<()>) -> io::Result<()> {
    require_system()?;
    if fs::canonicalize(std::env::current_exe()?)?
        != fs::canonicalize(maintenance_executable_path()?)?
    {
        return Err(denied(
            "maintenance service must run from its protected installation",
        ));
    }
    let mut pipe = Pipe::server(MAINTENANCE_PIPE, "IU")?;
    pipe.set_broker_stop(stop);
    pipe.set_timeout(Some(IDLE_ACCEPT_TIMEOUT));
    ready()?;
    match pipe.accept(stop) {
        Ok(()) => {}
        Err(error)
            if matches!(
                error.kind(),
                io::ErrorKind::TimedOut | io::ErrorKind::ConnectionAborted
            ) =>
        {
            return Ok(());
        }
        Err(error) => return Err(error),
    }
    pipe.set_timeout(Some(Duration::from_secs(10)));
    let reply = match handle_request(&mut pipe) {
        Ok((updated, version)) => MaintenanceReply {
            ok: true,
            updated,
            version: Some(version),
            error: None,
        },
        Err(error) => {
            tracing::warn!(%error, "maintenance service rejected desktop service update");
            MaintenanceReply {
                ok: false,
                updated: false,
                version: None,
                error: Some(error.to_string()),
            }
        }
    };
    let _ = write_json(&mut pipe, &reply).and_then(|()| read_ack(&mut pipe));
    let _ = pipe.disconnect();
    Ok(())
}

fn handle_request(pipe: &mut Pipe) -> io::Result<(bool, String)> {
    let mut magic = [0u8; 3];
    pipe.read_exact(&mut magic)?;
    if magic != HANDSHAKE_MAGIC {
        return Err(denied("invalid maintenance service handshake"));
    }
    let identity = pipe_client(pipe.handle())?;
    require_console(&identity)?;
    let request: MaintenanceRequest = read_json(pipe)?;
    let manifest = request.manifest;
    if manifest.size == 0 || manifest.size > MAX_SERVICE_BINARY_SIZE {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "desktop service binary size is out of bounds",
        ));
    }
    let _setup = SetupLock::acquire()?;
    let scm = manager(SC_MANAGER_CONNECT)?;
    let desktop_service = open_named(
        &scm,
        SERVICE_NAME,
        SERVICE_QUERY_STATUS | SERVICE_STOP | SERVICE_START | SERVICE_CHANGE_CONFIG,
    )?
    .ok_or_else(|| {
        denied("DeskFleetDesktop service is not installed; enable it with administrator approval first")
    })?;

    let executable = executable_path()?;
    let directory = executable
        .parent()
        .ok_or_else(|| io::Error::other("invalid desktop service directory"))?;
    prepare_directory(directory)?;
    reject_reparse(&executable)?;
    let staging = directory.join("desktop-service.installing.exe");
    let previous = directory.join("desktop-service.previous.exe");
    reject_reparse(&staging)?;
    reject_reparse(&previous)?;

    let stream_result = stream_verified_binary(pipe, &staging, manifest.size);
    let actual_sha256 = match stream_result {
        Ok(digest) => digest,
        Err(error) => {
            let _ = fs::remove_file(&staging);
            return Err(error);
        }
    };

    let candidate_version = match verify_manifest(
        &manifest,
        &actual_sha256,
        manifest.size,
        trusted_public_keys(),
    ) {
        Ok(version) => version,
        Err(error) => {
            let _ = fs::remove_file(&staging);
            return Err(error);
        }
    };

    let floor = installed_version_floor()?;
    let installed_sha256 = executable
        .try_exists()?
        .then(|| sha256_file(&executable).ok().map(|(hash, _)| hash))
        .flatten();
    let needs_replace = match check_version_floor(
        &candidate_version,
        &actual_sha256,
        &floor,
        installed_sha256.as_deref(),
    ) {
        Ok(needs_replace) => needs_replace,
        Err(error) => {
            let _ = fs::remove_file(&staging);
            return Err(error);
        }
    };
    if !needs_replace {
        let _ = fs::remove_file(&staging);
        let existing_record = read_installed_record().ok().flatten();
        if should_update_installed_record(
            existing_record.as_ref(),
            &candidate_version,
            &actual_sha256,
        ) {
            write_installed_record(&InstalledRecord {
                version: manifest.version.clone(),
                sha256: actual_sha256,
            })?;
        }
        return Ok((false, manifest.version));
    }

    let mut files =
        PreparedInstall::from_staged(staging, &executable, "desktop-service.previous.exe")?;
    if let Some(previous_file) = files.previous() {
        protect(previous_file, false)?;
    }

    let was_running = query(&desktop_service)?.dwCurrentState != SERVICE_STOPPED;
    stop(&desktop_service)?;
    let path = wide(format!("\"{}\" --service", executable.display()));
    let replace_result = (|| {
        files.replace()?;
        configure_desktop_service(&desktop_service, &path)?;
        if was_running {
            start_service(&desktop_service)?;
        }
        // Persist the new anti-downgrade floor before deleting the recovery
        // copy so a record write failure rolls back the binary cleanly.
        write_installed_record(&InstalledRecord {
            version: manifest.version.clone(),
            sha256: actual_sha256,
        })?;
        Ok(())
    })();
    if let Err(failure) = replace_result {
        let recovery = (|| {
            stop(&desktop_service)?;
            files.rollback()?;
            if was_running {
                start_service(&desktop_service)?;
            }
            Ok(())
        })();
        return Err(setup_failure(failure, recovery));
    }
    files.commit()?;
    Ok((true, manifest.version))
}

fn stream_verified_binary(
    pipe: &mut Pipe,
    staging: &std::path::Path,
    expected_size: u64,
) -> io::Result<String> {
    let mut file = File::create(staging)?;
    protect(staging, false)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    let mut remaining = expected_size;
    while remaining > 0 {
        let to_read = (remaining as usize).min(buffer.len());
        pipe.read_exact(&mut buffer[..to_read])?;
        file.write_all(&buffer[..to_read])?;
        hasher.update(&buffer[..to_read]);
        remaining -= to_read as u64;
    }
    file.sync_all()?;
    Ok(encode_hex(&hasher.finalize()))
}

/// Unprivileged client request to trigger the on-demand `DeskFleetMaintenance`
/// service and stream the bundled signed `deskfleet-desktop-service.exe`.
pub(super) fn request_update() -> io::Result<()> {
    let bundled_exe = fs::canonicalize(std::env::current_exe()?)?;
    let directory = bundled_exe
        .parent()
        .ok_or_else(|| io::Error::other("invalid bundled desktop service directory"))?;
    let manifest_path = directory.join(BUNDLED_MANIFEST_FILE);
    let raw_manifest = fs::read_to_string(&manifest_path).map_err(|error| {
        io::Error::new(
            error.kind(),
            format!("signed desktop service manifest is unavailable: {error}"),
        )
    })?;
    let manifest: ServiceManifest = serde_json::from_str(&raw_manifest)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
    let (actual_sha256, actual_size) = sha256_file(&bundled_exe)?;
    if manifest.sha256 != actual_sha256 || manifest.size != actual_size {
        return Err(denied(
            "bundled desktop service binary does not match its manifest",
        ));
    }

    let scm = manager(SC_MANAGER_CONNECT)?;
    let service = open_named(
        &scm,
        MAINTENANCE_SERVICE_NAME,
        SERVICE_QUERY_STATUS | SERVICE_START,
    )?
    .ok_or_else(|| io::Error::other("Windows maintenance service is not installed"))?;

    let mut pipe = connect_on_demand_service(&service)?;
    pipe.write_all(&HANDSHAKE_MAGIC)?;
    write_json(&mut pipe, &MaintenanceRequest { manifest })?;

    let mut file = File::open(&bundled_exe)?;
    let mut buffer = [0u8; 64 * 1024];
    let mut sent = 0u64;
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        pipe.write_all(&buffer[..count])?;
        sent += count as u64;
    }
    if sent != actual_size {
        return Err(io::Error::other(
            "bundled desktop service size changed while streaming",
        ));
    }

    // Stopping, replacing, and starting DeskFleetDesktop can take longer than
    // the default ten-second handshake timeout on busy hosts.
    pipe.set_timeout(Some(Duration::from_secs(60)));
    let reply: MaintenanceReply = read_json(&mut pipe)?;
    let _ = pipe.write_all(&[1]);
    if !reply.ok {
        return Err(io::Error::other(
            reply
                .error
                .unwrap_or_else(|| "maintenance service update failed".to_owned()),
        ));
    }
    Ok(())
}

#[derive(Debug, PartialEq, Eq)]
enum OnDemandAction {
    Start,
    Connect(u32),
    Wait,
    Failed(u32),
}

fn decide_on_demand_action(
    state: SERVICE_STATUS_CURRENT_STATE,
    pid: u32,
    win32_exit_code: u32,
    started_by_us: bool,
) -> OnDemandAction {
    match state {
        SERVICE_RUNNING if pid != 0 => OnDemandAction::Connect(pid),
        SERVICE_STOPPED if started_by_us && win32_exit_code != 0 => {
            OnDemandAction::Failed(win32_exit_code)
        }
        SERVICE_STOPPED => OnDemandAction::Start,
        _ => OnDemandAction::Wait,
    }
}

fn connect_on_demand_service(service: &super::install::ServiceHandle) -> io::Result<Pipe> {
    let deadline = Instant::now() + Duration::from_secs(30);
    let mut started_by_us = false;
    loop {
        let state = query(service)?;
        match decide_on_demand_action(
            state.dwCurrentState,
            state.dwProcessId,
            state.dwWin32ExitCode,
            started_by_us,
        ) {
            OnDemandAction::Connect(pid) => match Pipe::open(MAINTENANCE_PIPE, pid) {
                Ok(pipe) => return Ok(pipe),
                Err(error) => {
                    // The single-shot service may have just finished serving
                    // another per-user caller and exited (or restarted with a
                    // new PID). Retry within the shared deadline when the
                    // service state moved on; surface hard access errors.
                    let latest = query(service)?;
                    let service_moved_on =
                        latest.dwCurrentState != SERVICE_RUNNING || latest.dwProcessId != pid;
                    let retryable = service_moved_on
                        || matches!(error.raw_os_error(), Some(2 | 231 | 232 | 233));
                    if !retryable {
                        return Err(error);
                    }
                    started_by_us = false;
                }
            },
            OnDemandAction::Start => {
                // SAFETY: The handle owns SERVICE_START and accepts no arguments.
                match unsafe { StartServiceW(service.0, None) }.map_err(error) {
                    Ok(()) => {
                        started_by_us = true;
                    }
                    Err(error) if error.raw_os_error() == Some(1056) => {
                        // Another instance is already running or starting; the
                        // next iteration observes SERVICE_RUNNING and connects.
                        started_by_us = false;
                        continue;
                    }
                    Err(error) => return Err(error),
                }
            }
            OnDemandAction::Wait => {}
            OnDemandAction::Failed(code) => {
                return Err(io::Error::other(format!(
                    "Windows maintenance service failed to start (Windows error {code})"
                )));
            }
        }
        if Instant::now() >= deadline {
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "Windows maintenance service is busy",
            ));
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

fn read_ack(pipe: &mut Pipe) -> io::Result<()> {
    let mut byte = [0u8];
    pipe.read_exact(&mut byte)?;
    if byte != [1] {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "invalid maintenance service acknowledgement",
        ));
    }
    Ok(())
}

fn read_json<T: serde::de::DeserializeOwned>(pipe: &mut Pipe) -> io::Result<T> {
    let mut size = [0u8; 4];
    pipe.read_exact(&mut size)?;
    let size = u32::from_le_bytes(size) as usize;
    if size == 0 || size > MAX_MESSAGE {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "maintenance message size is invalid",
        ));
    }
    let mut bytes = vec![0u8; size];
    pipe.read_exact(&mut bytes)?;
    serde_json::from_slice(&bytes)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))
}

fn write_json(pipe: &mut Pipe, value: &impl serde::Serialize) -> io::Result<()> {
    let bytes = serde_json::to_vec(value).map_err(io::Error::other)?;
    if bytes.len() > MAX_MESSAGE {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "maintenance message exceeds its limit",
        ));
    }
    pipe.write_all(&(bytes.len() as u32).to_le_bytes())?;
    pipe.write_all(&bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::platform::identity::{current_token, token_identity};
    use crate::platform::raw;
    use ed25519_dalek::{Signer as _, SigningKey};
    use std::path::PathBuf;
    use windows::Win32::Security::TOKEN_QUERY;
    use windows::Win32::System::Threading::GetCurrentProcessId;

    #[test]
    fn on_demand_state_machine_connects_to_running_service_and_reports_start_failures() {
        assert_eq!(
            decide_on_demand_action(SERVICE_RUNNING, 4242, 0, false),
            OnDemandAction::Connect(4242)
        );
        assert_eq!(
            decide_on_demand_action(SERVICE_RUNNING, 0, 0, true),
            OnDemandAction::Wait
        );
        assert_eq!(
            decide_on_demand_action(SERVICE_START_PENDING, 0, 0, false),
            OnDemandAction::Wait
        );
        assert_eq!(
            decide_on_demand_action(SERVICE_STOP_PENDING, 4242, 0, false),
            OnDemandAction::Wait
        );
        assert_eq!(
            decide_on_demand_action(SERVICE_STOPPED, 0, 0, false),
            OnDemandAction::Start
        );
        // Clean exit (code 0) after another caller raced in permits a fresh start.
        assert_eq!(
            decide_on_demand_action(SERVICE_STOPPED, 0, 0, true),
            OnDemandAction::Start
        );
        // Non-zero exit after our StartServiceW fails immediately.
        assert_eq!(
            decide_on_demand_action(SERVICE_STOPPED, 0, 1066, true),
            OnDemandAction::Failed(1066)
        );
    }

    #[test]
    fn streamed_binary_over_named_pipe_verifies_digest_and_signature() {
        let token = current_token(TOKEN_QUERY).unwrap();
        let identity = token_identity(raw(&token)).unwrap();
        let pipe_name = format!(
            r"\\.\pipe\deskfleet-maintenance-test-{:032x}",
            rand::random::<u128>()
        );
        let mut server = Pipe::server(&pipe_name, &identity.sid).unwrap();
        // SAFETY: Querying the current process ID takes no pointer arguments.
        let pid = unsafe { GetCurrentProcessId() };
        let mut client = Pipe::open(&pipe_name, pid).unwrap();
        server.accept(&AtomicBool::new(false)).unwrap();

        let payload: Vec<u8> = (0..180_000).map(|i| (i % 251) as u8).collect();
        let key = SigningKey::from_bytes(&[9u8; 32]);
        let digest = encode_hex(&Sha256::digest(&payload));
        let size = payload.len() as u64;
        let msg = crate::manifest::canonical_signing_message("0.20.0", &digest, size);
        let signature = base64::Engine::encode(
            &base64::engine::general_purpose::STANDARD,
            key.sign(msg.as_bytes()).to_bytes(),
        );
        let manifest = ServiceManifest {
            format_version: crate::manifest::MANIFEST_FORMAT_VERSION,
            version: "0.20.0".to_owned(),
            sha256: digest,
            size,
            key_id: "v1".to_owned(),
            signature,
        };

        let request = MaintenanceRequest {
            manifest: manifest.clone(),
        };
        let payload_copy = payload.clone();
        let sender = std::thread::spawn(move || {
            client.write_all(&HANDSHAKE_MAGIC).unwrap();
            write_json(&mut client, &request).unwrap();
            client.write_all(&payload_copy).unwrap();
        });

        let mut magic = [0u8; 3];
        server.read_exact(&mut magic).unwrap();
        assert_eq!(magic, HANDSHAKE_MAGIC);
        let received_request: MaintenanceRequest = read_json(&mut server).unwrap();
        assert_eq!(received_request.manifest, manifest);

        let dir: PathBuf = std::env::temp_dir().join(format!(
            "deskfleet-maintenance-stream-{}",
            rand::random::<u64>()
        ));
        fs::create_dir(&dir).unwrap();
        let staged = dir.join("staged.exe");
        let mut file = File::create(&staged).unwrap();
        let mut hasher = Sha256::new();
        let mut buffer = [0u8; 64 * 1024];
        let mut remaining = received_request.manifest.size;
        while remaining > 0 {
            let chunk = (remaining as usize).min(buffer.len());
            server.read_exact(&mut buffer[..chunk]).unwrap();
            file.write_all(&buffer[..chunk]).unwrap();
            hasher.update(&buffer[..chunk]);
            remaining -= chunk as u64;
        }
        drop(file);
        sender.join().unwrap();

        let actual_digest = encode_hex(&hasher.finalize());
        let trusted = [("v1", key.verifying_key().to_bytes())];
        verify_manifest(
            &received_request.manifest,
            &actual_digest,
            received_request.manifest.size,
            &trusted,
        )
        .unwrap();
        assert_eq!(fs::read(&staged).unwrap(), payload);
        fs::remove_dir_all(&dir).unwrap();
    }
}
