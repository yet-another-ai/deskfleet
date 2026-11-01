use std::io::{self, Read, Write};
use std::os::windows::io::OwnedHandle;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use windows::Win32::Foundation::{GetLastError, HANDLE, WAIT_TIMEOUT};
use windows::Win32::Security::{
    AdjustTokenPrivileges, DuplicateTokenEx, LUID_AND_ATTRIBUTES, LookupPrivilegeValueW,
    SE_PRIVILEGE_ENABLED, SE_TCB_NAME, SecurityImpersonation, SetTokenInformation,
    TOKEN_ADJUST_PRIVILEGES, TOKEN_ALL_ACCESS, TOKEN_DUPLICATE, TOKEN_PRIVILEGES, TOKEN_QUERY,
    TokenPrimary, TokenSessionId,
};
use windows::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
    SetInformationJobObject,
};
use windows::Win32::System::Threading::{
    CREATE_NO_WINDOW, CREATE_SUSPENDED, CreateEventW, CreateProcessAsUserW, OpenEventW,
    PROCESS_INFORMATION, ResumeThread, STARTUPINFOW, SYNCHRONIZATION_SYNCHRONIZE, SetEvent,
    TerminateProcess, WaitForSingleObject,
};
use windows::core::{PCWSTR, PWSTR};

use super::identity::{
    Identity, current_token, impersonate, pipe_client, require_console, require_system,
};
use super::pipe::SecurityDescriptor;
use super::{BROKER_PIPE, Pipe, denied, error, executable_path, owned, raw, wide};

#[derive(serde::Serialize, serde::Deserialize)]
struct Endpoint {
    pipe: String,
    secret: String,
    pid: u32,
}

#[derive(serde::Serialize, serde::Deserialize)]
struct BrokerReply {
    worker: Option<Endpoint>,
    error: Option<String>,
}

enum Admission {
    Worker {
        child: OwnedHandle,
        endpoint: Endpoint,
    },
    Success,
}

/// Connect to the optional installed service. A stopped or broken installed
/// service is an error; only an absent installation permits in-process fallback.
pub fn connect() -> io::Result<Option<Pipe>> {
    let Some(pid) = super::install::service_pid()? else {
        return Ok(None);
    };
    if pid == 0 {
        return Err(io::Error::other(
            "Windows desktop service is installed but not running",
        ));
    }
    let mut broker = Pipe::open(BROKER_PIPE, pid)?;
    broker.write_all(b"DF\x01")?;
    let reply: BrokerReply = read_json(&mut broker)?;
    broker.write_all(&[1])?;
    drop(broker);
    if let Some(error) = reply.error {
        return Err(io::Error::other(error));
    }
    let endpoint = reply.worker.ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            "desktop service did not return a worker",
        )
    })?;
    if !endpoint
        .pipe
        .starts_with(r"\\.\pipe\deskfleet-desktop-worker-")
        || endpoint.secret.len() != 64
        || !endpoint.secret.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "invalid desktop worker endpoint",
        ));
    }
    let mut pipe = Pipe::open(&endpoint.pipe, endpoint.pid)?;
    pipe.write_all(endpoint.secret.as_bytes())?;
    let mut acknowledged = [0u8; 1];
    pipe.read_exact(&mut acknowledged)?;
    if acknowledged != [1] {
        return Err(denied("desktop worker authorization failed"));
    }
    Ok(Some(pipe))
}

/// Ask the actual SCM service to deliver Ctrl+Alt+Del to this console session.
pub fn send_secure_attention() -> io::Result<()> {
    let pid = super::install::service_pid()?
        .filter(|pid| *pid != 0)
        .ok_or_else(|| {
            io::Error::other("Ctrl+Alt+Del requires the running Windows desktop service")
        })?;
    let mut broker = Pipe::open_qos(BROKER_PIPE, pid, true)?;
    broker.write_all(b"DF\x02")?;
    let result: BrokerReply = read_json(&mut broker)?;
    broker.write_all(&[1])?;
    match result.error {
        Some(message) => Err(io::Error::other(message)),
        None => Ok(()),
    }
}

pub(super) fn serve(
    stop: &'static AtomicBool,
    ready: impl FnOnce() -> io::Result<()>,
) -> io::Result<()> {
    require_system()?;
    if std::fs::canonicalize(std::env::current_exe()?)?
        != std::fs::canonicalize(executable_path()?)?
    {
        return Err(denied(
            "desktop service must run from its protected installation",
        ));
    }
    enable_session_privilege()?;
    let mut workers = Workers::new()?;
    let mut pipe = Pipe::server(BROKER_PIPE, "IU")?;
    pipe.set_broker_stop(stop);
    ready()?;
    while !stop.load(Ordering::Acquire) {
        pipe.set_timeout(None);
        if let Err(error) = pipe.accept(stop) {
            if stop.load(Ordering::Acquire) {
                break;
            }
            return Err(error);
        }
        pipe.set_timeout(Some(Duration::from_secs(10)));
        workers.children.retain(|child| {
            // SAFETY: Each handle is a live child process; zero timeout only queries.
            (unsafe { WaitForSingleObject(raw(child), 0) }) == WAIT_TIMEOUT
        });
        match admit(&mut pipe, &workers) {
            Ok(Some(child)) => workers.children.push(child),
            Ok(None) => {}
            Err(error) => tracing::warn!(%error, "desktop service connection rejected"),
        }
        pipe.disconnect()?;
    }
    Ok(())
}

fn admit(pipe: &mut Pipe, workers: &Workers) -> io::Result<Option<OwnedHandle>> {
    let (reply, child) = match admission(pipe, workers) {
        Ok(Admission::Worker { child, endpoint }) => (
            BrokerReply {
                worker: Some(endpoint),
                error: None,
            },
            Some(child),
        ),
        Ok(Admission::Success) => (
            BrokerReply {
                worker: None,
                error: None,
            },
            None,
        ),
        Err(error) => (
            BrokerReply {
                worker: None,
                error: Some(error.to_string()),
            },
            None,
        ),
    };
    if let Err(error) = write_json(pipe, &reply).and_then(|()| acknowledge(pipe)) {
        if let Some(child) = &child {
            // SAFETY: This worker belongs to the failed request and has not served a client.
            let _ = unsafe { TerminateProcess(raw(child), 1) };
        }
        return Err(error);
    }
    Ok(child)
}

fn admission(pipe: &mut Pipe, workers: &Workers) -> io::Result<Admission> {
    let mut signature = [0u8; 3];
    pipe.read_exact(&mut signature)?;
    if signature[..2] != *b"DF" {
        return Err(denied("invalid desktop service handshake"));
    }
    let identity = pipe_client(pipe.handle())?;
    require_console(&identity)?;
    if signature[2] == 2 {
        impersonate(pipe.handle(), super::sas::send)?;
        return Ok(Admission::Success);
    }
    if signature[2] != 1 {
        return Err(denied("unknown desktop service operation"));
    }
    if workers.children.len() >= 32 {
        return Err(io::Error::other("desktop service worker limit reached"));
    }
    let random: [u8; 32] = rand::random();
    let secret = random
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let name = format!(
        r"\\.\pipe\deskfleet-desktop-worker-{:032x}",
        rand::random::<u128>()
    );
    let job = workers
        .job
        .as_ref()
        .ok_or_else(|| io::Error::other("desktop service stopped"))?;
    let (child, pid) = launch_worker(&name, &secret, &identity, job, &workers.stop_name)?;
    Ok(Admission::Worker {
        child,
        endpoint: Endpoint {
            pipe: name,
            secret,
            pid,
        },
    })
}

fn acknowledge(pipe: &mut Pipe) -> io::Result<()> {
    let mut byte = [0u8];
    pipe.read_exact(&mut byte)?;
    if byte != [1] {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "invalid desktop broker acknowledgement",
        ));
    }
    Ok(())
}

pub(super) fn worker(args: &[String], handler: fn(Pipe) -> io::Result<()>) -> io::Result<()> {
    require_system()?;
    if args.len() != 5 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "invalid desktop worker arguments",
        ));
    }
    let identity = Identity {
        sid: args[2].clone(),
        session: args[3].parse().map_err(|_| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                "invalid desktop worker session",
            )
        })?,
    };
    require_console(&identity)?;
    if args[1].len() != 64
        || !args[1].bytes().all(|byte| byte.is_ascii_hexdigit())
        || !args[0]
            .strip_prefix(r"\\.\pipe\deskfleet-desktop-worker-")
            .is_some_and(|suffix| {
                suffix.len() == 32 && suffix.bytes().all(|byte| byte.is_ascii_hexdigit())
            })
    {
        return Err(denied("invalid desktop worker credential"));
    }
    let mut pipe = Pipe::server(&args[0], &identity.sid)?;
    pipe.restrict_session(identity.clone());
    if !args[4]
        .strip_prefix("Global\\DeskFleetDesktopStop-")
        .is_some_and(|suffix| {
            suffix.len() == 32 && suffix.bytes().all(|byte| byte.is_ascii_hexdigit())
        })
    {
        return Err(denied("invalid desktop worker stop event"));
    }
    let event_name = wide(&args[4]);
    // SAFETY: The service-created SYSTEM-only event name is validated and terminated.
    let event = owned(
        unsafe {
            OpenEventW(
                SYNCHRONIZATION_SYNCHRONIZE,
                false,
                PCWSTR(event_name.as_ptr()),
            )
        }
        .map_err(error)?,
    );
    pipe.set_service_stop(event);
    pipe.accept(&AtomicBool::new(false))?;
    let mut secret = [0u8; 64];
    pipe.read_exact(&mut secret)?;
    if secret.as_slice() != args[1].as_bytes() || pipe_client(pipe.handle())? != identity {
        return Err(denied(
            "desktop worker client does not match its console owner",
        ));
    }
    pipe.write_all(&[1])?;
    pipe.set_timeout(None);
    handler(pipe)
}

fn enable_session_privilege() -> io::Result<()> {
    let token = current_token(TOKEN_ADJUST_PRIVILEGES | TOKEN_QUERY)?;
    let mut luid = Default::default();
    // SAFETY: The constant privilege name and output pointer are valid.
    unsafe { LookupPrivilegeValueW(PCWSTR::null(), SE_TCB_NAME, &mut luid) }.map_err(error)?;
    let privileges = TOKEN_PRIVILEGES {
        PrivilegeCount: 1,
        Privileges: [LUID_AND_ATTRIBUTES {
            Luid: luid,
            Attributes: SE_PRIVILEGE_ENABLED,
        }],
    };
    // SAFETY: SYSTEM owns this privilege; one initialized entry is provided.
    unsafe { AdjustTokenPrivileges(raw(&token), false, Some(&privileges), 0, None, None) }
        .map_err(error)
}

fn worker_job() -> io::Result<OwnedHandle> {
    // SAFETY: No name or security descriptor is supplied; the handle is owned here.
    let job = owned(unsafe { CreateJobObjectW(None, PCWSTR::null()) }.map_err(error)?);
    let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    // SAFETY: limits is the initialized structure matching the information class.
    unsafe {
        SetInformationJobObject(
            raw(&job),
            JobObjectExtendedLimitInformation,
            (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
            size_of_val(&limits) as u32,
        )
    }
    .map_err(error)?;
    Ok(job)
}

fn launch_worker(
    pipe: &str,
    secret: &str,
    identity: &Identity,
    job: &OwnedHandle,
    stop_event: &str,
) -> io::Result<(OwnedHandle, u32)> {
    let original = current_token(TOKEN_DUPLICATE | TOKEN_QUERY)?;
    let mut token = HANDLE::default();
    // SAFETY: A new primary SYSTEM token is created with no inherited handles.
    unsafe {
        DuplicateTokenEx(
            raw(&original),
            TOKEN_ALL_ACCESS,
            None,
            SecurityImpersonation,
            TokenPrimary,
            &mut token,
        )
    }
    .map_err(error)?;
    let token = owned(token);
    // SAFETY: The token is owned and the session DWORD has the required size.
    unsafe {
        SetTokenInformation(
            raw(&token),
            TokenSessionId,
            (&identity.session as *const u32).cast(),
            4,
        )
    }
    .map_err(error)?;
    let executable = executable_path()?;
    let application = wide(&executable);
    let directory = wide(
        executable
            .parent()
            .ok_or_else(|| io::Error::other("invalid service directory"))?,
    );
    let mut command = wide(format!(
        "\"{}\" --worker {pipe} {secret} {} {} {stop_event}",
        executable.display(),
        identity.sid,
        identity.session
    ));
    let mut desktop = wide("winsta0\\default");
    let startup = STARTUPINFOW {
        cb: size_of::<STARTUPINFOW>() as u32,
        lpDesktop: PWSTR(desktop.as_mut_ptr()),
        ..Default::default()
    };
    let mut process = PROCESS_INFORMATION::default();
    // SAFETY: All command/storage pointers remain live. No handles are inherited
    // across sessions. The exact protected executable is supplied separately.
    unsafe {
        CreateProcessAsUserW(
            Some(raw(&token)),
            PCWSTR(application.as_ptr()),
            Some(PWSTR(command.as_mut_ptr())),
            None,
            None,
            false,
            CREATE_NO_WINDOW | CREATE_SUSPENDED,
            None,
            PCWSTR(directory.as_ptr()),
            &startup,
            &mut process,
        )
    }
    .map_err(error)?;
    let child = owned(process.hProcess);
    let thread = owned(process.hThread);
    // SAFETY: The suspended child and job are live and owned by the service.
    if let Err(error) = unsafe { AssignProcessToJobObject(raw(job), raw(&child)) }.map_err(error) {
        // SAFETY: The child has not executed any user code and belongs to this request.
        let _ = unsafe { TerminateProcess(raw(&child), 1) };
        return Err(error);
    }
    // SAFETY: This is the sole suspension applied at process creation.
    if unsafe { ResumeThread(raw(&thread)) } == u32::MAX {
        let failure = io::Error::last_os_error();
        // SAFETY: The child belongs to this request and failed startup.
        let _ = unsafe { TerminateProcess(raw(&child), 1) };
        return Err(failure);
    }
    Ok((child, process.dwProcessId))
}

struct Workers {
    job: Option<OwnedHandle>,
    stop: OwnedHandle,
    stop_name: String,
    children: Vec<OwnedHandle>,
}

impl Workers {
    fn new() -> io::Result<Self> {
        let stop_name = format!(
            "Global\\DeskFleetDesktopStop-{:032x}",
            rand::random::<u128>()
        );
        let name = wide(&stop_name);
        let security = SecurityDescriptor::new("D:P(A;;GA;;;SY)")?;
        let attributes = security.attributes();
        // SAFETY: The descriptor and generated name remain live for the call.
        let stop = owned(
            unsafe { CreateEventW(Some(&attributes), true, false, PCWSTR(name.as_ptr())) }
                .map_err(error)?,
        );
        // SAFETY: Read immediately after CreateEventW to reject an existing object.
        if unsafe { GetLastError() }.0 == 183 {
            return Err(io::Error::other("desktop stop event already exists"));
        }
        Ok(Self {
            job: Some(worker_job()?),
            stop,
            stop_name,
            children: Vec::new(),
        })
    }

    fn wait(&self, timeout: Duration) {
        let start = Instant::now();
        for child in &self.children {
            let remaining = timeout.saturating_sub(start.elapsed());
            // SAFETY: The child handle is held; waits are bounded by one shared deadline.
            unsafe { WaitForSingleObject(raw(child), remaining.as_millis() as u32) };
        }
    }
}

impl Drop for Workers {
    fn drop(&mut self) {
        // SAFETY: The service owns the manual-reset event observed by all its workers.
        let _ = unsafe { SetEvent(raw(&self.stop)) };
        self.wait(Duration::from_secs(3));
        // Normally workers have released input and exited. The job handles an
        // unresponsive capture/encoder without leaving SYSTEM workers behind.
        self.job.take();
        self.wait(Duration::from_secs(3));
    }
}

fn read_json<T: serde::de::DeserializeOwned>(pipe: &mut Pipe) -> io::Result<T> {
    let mut size = [0u8; 4];
    pipe.read_exact(&mut size)?;
    let size = u32::from_le_bytes(size) as usize;
    if size > 2048 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "desktop handshake is too large",
        ));
    }
    let mut bytes = vec![0; size];
    pipe.read_exact(&mut bytes)?;
    serde_json::from_slice(&bytes)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))
}

fn write_json(pipe: &mut Pipe, value: &impl serde::Serialize) -> io::Result<()> {
    let bytes = serde_json::to_vec(value).map_err(io::Error::other)?;
    pipe.write_all(&(bytes.len() as u32).to_le_bytes())?;
    pipe.write_all(&bytes)
}
