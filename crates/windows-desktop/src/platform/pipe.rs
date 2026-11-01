use std::fs::File;
use std::io::{self, Read, Write};
use std::os::windows::io::{FromRawHandle, OwnedHandle};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use std::time::{Duration, Instant};

use windows::Win32::Foundation::{HANDLE, HLOCAL, LocalFree, WAIT_OBJECT_0, WAIT_TIMEOUT};
use windows::Win32::Security::Authorization::{
    ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
};
use windows::Win32::Security::{PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES};
use windows::Win32::Storage::FileSystem::{
    CreateFileW, FILE_FLAG_FIRST_PIPE_INSTANCE, FILE_FLAG_OVERLAPPED, FILE_FLAGS_AND_ATTRIBUTES,
    FILE_SHARE_MODE, OPEN_EXISTING, PIPE_ACCESS_DUPLEX, ReadFile, SECURITY_IDENTIFICATION,
    SECURITY_IMPERSONATION, SECURITY_SQOS_PRESENT, WriteFile,
};
use windows::Win32::System::IO::{CancelIoEx, GetOverlappedResult, OVERLAPPED};
use windows::Win32::System::Pipes::{
    ConnectNamedPipe, CreateNamedPipeW, DisconnectNamedPipe, GetNamedPipeServerProcessId,
    PIPE_READMODE_BYTE, PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_BYTE,
};
use windows::Win32::System::Threading::{CreateEventW, WaitForSingleObject};
use windows::core::PCWSTR;

use super::identity::{Identity, require_console};
use super::{error, owned, raw, wide};

/// A cancellable local byte stream. Client operations have a ten-second deadline;
/// workers may wait for commands indefinitely while monitoring their console owner.
pub struct Pipe {
    file: File,
    timeout: Option<Duration>,
    cancel: Arc<AtomicBool>,
    identity: Option<Identity>,
    checked_at: Instant,
    service_stop: Option<Arc<OwnedHandle>>,
    broker_stop: Option<&'static AtomicBool>,
}

impl Pipe {
    pub fn set_timeout(&mut self, timeout: Option<Duration>) {
        self.timeout = timeout;
    }

    pub fn cancel_handle(&self) -> Arc<AtomicBool> {
        Arc::clone(&self.cancel)
    }

    pub fn try_clone(&self) -> io::Result<Self> {
        Ok(Self {
            file: self.file.try_clone()?,
            timeout: self.timeout,
            cancel: Arc::clone(&self.cancel),
            identity: self.identity.clone(),
            checked_at: Instant::now(),
            service_stop: self.service_stop.clone(),
            broker_stop: self.broker_stop,
        })
    }

    /// Reject further requests when logout or fast user switching changes the console.
    pub fn check_session(&self) -> io::Result<()> {
        if self.cancel.load(Ordering::Acquire)
            || self
                .broker_stop
                .is_some_and(|stop| stop.load(Ordering::Acquire))
        {
            return Err(io::Error::new(
                io::ErrorKind::ConnectionAborted,
                "desktop pipe cancelled",
            ));
        }
        if let Some(event) = &self.service_stop {
            // SAFETY: The event remains owned by this pipe; zero timeout only queries.
            if unsafe { WaitForSingleObject(raw(event.as_ref()), 0) } == WAIT_OBJECT_0 {
                return Err(io::Error::new(
                    io::ErrorKind::ConnectionAborted,
                    "desktop service stopped",
                ));
            }
        }
        if let Some(identity) = &self.identity {
            require_console(identity)?;
        }
        Ok(())
    }

    pub(super) fn handle(&self) -> HANDLE {
        raw(&self.file)
    }

    pub(super) fn restrict_session(&mut self, identity: Identity) {
        self.identity = Some(identity);
    }

    pub(super) fn set_service_stop(&mut self, event: OwnedHandle) {
        self.service_stop = Some(Arc::new(event));
    }

    pub(super) fn set_broker_stop(&mut self, stop: &'static AtomicBool) {
        self.broker_stop = Some(stop);
    }

    fn tick(&mut self, started: Instant) -> io::Result<()> {
        if self.cancel.load(Ordering::Acquire)
            || self
                .broker_stop
                .is_some_and(|stop| stop.load(Ordering::Acquire))
        {
            return Err(io::Error::new(
                io::ErrorKind::ConnectionAborted,
                "desktop pipe cancelled",
            ));
        }
        if self
            .timeout
            .is_some_and(|timeout| started.elapsed() >= timeout)
        {
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "desktop pipe operation timed out",
            ));
        }
        if self.checked_at.elapsed() >= Duration::from_millis(250) {
            self.check_session()?;
            self.checked_at = Instant::now();
        }
        Ok(())
    }

    pub(super) fn server(name: &str, allowed_sid: &str) -> io::Result<Self> {
        // Pipe creation rights belong only to SYSTEM. The user receives specific
        // read/write/synchronize rights, excluding FILE_CREATE_PIPE_INSTANCE (0x4).
        let descriptor =
            SecurityDescriptor::new(&format!("D:P(A;;GA;;;SY)(A;;0x0012019b;;;{allowed_sid})"))?;
        let attributes = descriptor.attributes();
        let name = wide(name);
        // SAFETY: Name and the self-relative descriptor remain live for this call.
        let handle = unsafe {
            CreateNamedPipeW(
                PCWSTR(name.as_ptr()),
                PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE | FILE_FLAG_OVERLAPPED,
                PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_REJECT_REMOTE_CLIENTS,
                1,
                64 * 1024,
                64 * 1024,
                0,
                Some(&attributes),
            )
        };
        if handle.is_invalid() {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: CreateNamedPipeW returned a newly owned valid handle.
        Ok(Self::from_file(unsafe { File::from_raw_handle(handle.0) }))
    }

    pub(super) fn accept(&mut self, stop: &AtomicBool) -> io::Result<()> {
        let event = io_event()?;
        let mut operation = OVERLAPPED {
            hEvent: raw(&event),
            ..Default::default()
        };
        // SAFETY: The handle is overlapped; operation and event remain alive until
        // wait_operation completes or cancels and drains the pending connect.
        match unsafe { ConnectNamedPipe(self.handle(), Some(&mut operation)) }.map_err(error) {
            Ok(()) => Ok(()),
            Err(error) if error.raw_os_error() == Some(535) => Ok(()),
            Err(error) if error.raw_os_error() == Some(997) => self
                .wait_operation(&mut operation, Some(stop), None)
                .map(|_| ()),
            Err(error) => Err(error),
        }
    }

    pub(super) fn disconnect(&mut self) -> io::Result<()> {
        // SAFETY: This is the reusable broker's server handle, with no pending I/O.
        match unsafe { DisconnectNamedPipe(self.handle()) }.map_err(error) {
            Err(error) if error.raw_os_error() == Some(233) => Ok(()),
            result => result,
        }
    }

    pub(super) fn open(name: &str, expected_pid: u32) -> io::Result<Self> {
        Self::open_qos(name, expected_pid, false)
    }

    pub(super) fn open_qos(name: &str, expected_pid: u32, impersonate: bool) -> io::Result<Self> {
        let name = wide(name);
        let started = Instant::now();
        let file = loop {
            // SAFETY: A fixed/local named-pipe path is null terminated. Identification
            // QoS lets SYSTEM inspect identity without impersonating client authority.
            let result = unsafe {
                CreateFileW(
                    PCWSTR(name.as_ptr()),
                    0x0012_019b,
                    FILE_SHARE_MODE(0),
                    None,
                    OPEN_EXISTING,
                    FILE_FLAGS_AND_ATTRIBUTES(
                        FILE_FLAG_OVERLAPPED.0
                            | SECURITY_SQOS_PRESENT.0
                            | if impersonate {
                                SECURITY_IMPERSONATION.0
                            } else {
                                SECURITY_IDENTIFICATION.0
                            },
                    ),
                    None,
                )
            }
            .map_err(error);
            match result {
                Ok(handle) => {
                    // SAFETY: CreateFileW returned a new owned valid handle.
                    break unsafe { File::from_raw_handle(handle.0) };
                }
                Err(error)
                    if matches!(error.raw_os_error(), Some(2 | 231))
                        && started.elapsed() < Duration::from_secs(10) =>
                {
                    std::thread::sleep(Duration::from_millis(10));
                }
                Err(error) => return Err(error),
            }
        };
        let mut server_pid = 0;
        // SAFETY: The pipe is connected and the output DWORD is valid.
        unsafe { GetNamedPipeServerProcessId(raw(&file), &mut server_pid) }.map_err(error)?;
        if server_pid != expected_pid {
            return Err(super::denied(
                "desktop pipe server does not match the system service",
            ));
        }
        Ok(Self::from_file(file))
    }

    fn wait_operation(
        &mut self,
        operation: &mut OVERLAPPED,
        stop: Option<&AtomicBool>,
        maximum: Option<Duration>,
    ) -> io::Result<usize> {
        let started = Instant::now();
        loop {
            let cancelled = if maximum.is_some_and(|maximum| started.elapsed() >= maximum) {
                Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "desktop pipe operation timed out",
                ))
            } else if stop.is_some_and(|stop| stop.load(Ordering::Acquire)) {
                Err(io::Error::new(
                    io::ErrorKind::ConnectionAborted,
                    "desktop service stopped",
                ))
            } else {
                self.tick(started)
            };
            if let Err(failure) = cancelled {
                let mut transferred = 0;
                // SAFETY: The same live OVERLAPPED identifies this operation. Drain
                // it before returning so Windows never accesses released Rust memory.
                unsafe {
                    let _ = CancelIoEx(self.handle(), Some(operation));
                    let _ = GetOverlappedResult(self.handle(), operation, &mut transferred, true);
                }
                return Err(failure);
            }
            // SAFETY: The event belongs to this live operation and the wait is bounded.
            match unsafe { WaitForSingleObject(operation.hEvent, 50) } {
                WAIT_OBJECT_0 => {
                    let mut transferred = 0;
                    // SAFETY: Completion signaled, and output storage is valid.
                    unsafe {
                        GetOverlappedResult(self.handle(), operation, &mut transferred, false)
                    }
                    .map_err(error)?;
                    return Ok(transferred as usize);
                }
                WAIT_TIMEOUT => {}
                _ => {
                    let failure = io::Error::last_os_error();
                    let mut transferred = 0;
                    // SAFETY: Cancel and drain before the OVERLAPPED storage is released.
                    unsafe {
                        let _ = CancelIoEx(self.handle(), Some(operation));
                        let _ =
                            GetOverlappedResult(self.handle(), operation, &mut transferred, true);
                    }
                    return Err(failure);
                }
            }
        }
    }

    fn from_file(file: File) -> Self {
        Self {
            file,
            timeout: Some(Duration::from_secs(10)),
            cancel: Arc::new(AtomicBool::new(false)),
            identity: None,
            checked_at: Instant::now(),
            service_stop: None,
            broker_stop: None,
        }
    }
}

impl Read for Pipe {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        if buffer.is_empty() {
            return Ok(0);
        }
        self.tick(Instant::now())?;
        let event = io_event()?;
        let mut operation = OVERLAPPED {
            hEvent: raw(&event),
            ..Default::default()
        };
        let mut transferred = 0;
        // SAFETY: Buffer, OVERLAPPED, and event stay live until completion or drained cancellation.
        let result = match unsafe {
            ReadFile(
                self.handle(),
                Some(buffer),
                Some(&mut transferred),
                Some(&mut operation),
            )
        }
        .map_err(error)
        {
            Ok(()) => Ok(transferred as usize),
            Err(error) if error.raw_os_error() == Some(997) => {
                self.wait_operation(&mut operation, None, None)
            }
            Err(error) => Err(error),
        };
        match result {
            Err(error) if error.raw_os_error() == Some(109) => Ok(0),
            result => result,
        }
    }
}

impl Write for Pipe {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        if buffer.is_empty() {
            return Ok(0);
        }
        self.tick(Instant::now())?;
        let event = io_event()?;
        let mut operation = OVERLAPPED {
            hEvent: raw(&event),
            ..Default::default()
        };
        let mut transferred = 0;
        // SAFETY: Buffer, OVERLAPPED, and event stay live until completion or drained cancellation.
        match unsafe {
            WriteFile(
                self.handle(),
                Some(buffer),
                Some(&mut transferred),
                Some(&mut operation),
            )
        }
        .map_err(error)
        {
            Ok(()) => Ok(transferred as usize),
            Err(error) if error.raw_os_error() == Some(997) => {
                self.wait_operation(&mut operation, None, Some(Duration::from_secs(10)))
            }
            Err(error) => Err(error),
        }
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

fn io_event() -> io::Result<OwnedHandle> {
    // SAFETY: No pointers or shared name are supplied; the returned event is owned.
    Ok(owned(
        unsafe { CreateEventW(None, true, false, PCWSTR::null()) }.map_err(error)?,
    ))
}

pub(super) struct SecurityDescriptor(PSECURITY_DESCRIPTOR);
impl SecurityDescriptor {
    pub fn new(sddl: &str) -> io::Result<Self> {
        let text = wide(sddl);
        let mut descriptor = PSECURITY_DESCRIPTOR::default();
        // SAFETY: The SDDL is null terminated, and output storage is valid.
        unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                PCWSTR(text.as_ptr()),
                SDDL_REVISION_1,
                &mut descriptor,
                None,
            )
        }
        .map_err(error)?;
        Ok(Self(descriptor))
    }
    pub fn attributes(&self) -> SECURITY_ATTRIBUTES {
        SECURITY_ATTRIBUTES {
            nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: self.0.0,
            bInheritHandle: false.into(),
        }
    }
    pub fn as_ptr(&self) -> PSECURITY_DESCRIPTOR {
        self.0
    }
}
impl Drop for SecurityDescriptor {
    fn drop(&mut self) {
        // SAFETY: ConvertStringSecurityDescriptorToSecurityDescriptorW uses LocalAlloc.
        unsafe { LocalFree(Some(HLOCAL(self.0.0))) };
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::platform::identity::{current_token, token_identity};
    use windows::Win32::Security::TOKEN_QUERY;
    use windows::Win32::System::Threading::GetCurrentProcessId;

    fn pair() -> (Pipe, Pipe) {
        let token = current_token(TOKEN_QUERY).unwrap();
        let identity = token_identity(raw(&token)).unwrap();
        let name = format!(
            r"\\.\pipe\deskfleet-desktop-test-{:032x}",
            rand::random::<u128>()
        );
        let mut server = Pipe::server(&name, &identity.sid).unwrap();
        // SAFETY: The current process ID query has no pointer arguments.
        let client = Pipe::open(&name, unsafe { GetCurrentProcessId() }).unwrap();
        server.accept(&AtomicBool::new(false)).unwrap();
        (server, client)
    }

    #[test]
    fn local_pipe_transfers_binary_data_and_observes_disconnect() {
        let (mut server, mut client) = pair();
        client.write_all(&[0, 127, 255, 1]).unwrap();
        let mut bytes = [0; 4];
        server.read_exact(&mut bytes).unwrap();
        assert_eq!(bytes, [0, 127, 255, 1]);
        server.write_all(b"ok").unwrap();
        let mut response = [0; 2];
        client.read_exact(&mut response).unwrap();
        assert_eq!(&response, b"ok");
        drop(client);
        assert_eq!(server.read(&mut bytes).unwrap(), 0);
    }

    #[test]
    fn idle_read_timeout_cancels_io_without_consuming_later_data() {
        let (mut server, mut client) = pair();
        server.set_timeout(Some(Duration::from_millis(25)));
        let mut byte = [0];
        assert_eq!(
            server.read(&mut byte).unwrap_err().kind(),
            io::ErrorKind::TimedOut
        );
        client.write_all(&[42]).unwrap();
        server.set_timeout(Some(Duration::from_secs(1)));
        server.read_exact(&mut byte).unwrap();
        assert_eq!(byte, [42]);
    }

    #[test]
    fn cancelled_idle_read_exact_returns_instead_of_retrying_interrupted() {
        let (mut server, _client) = pair();
        server.set_timeout(None);
        let cancel = server.cancel_handle();
        let reader = std::thread::spawn(move || server.read_exact(&mut [0u8]));
        cancel.store(true, Ordering::Release);
        assert_eq!(
            reader.join().unwrap().unwrap_err().kind(),
            io::ErrorKind::ConnectionAborted
        );
    }

    #[test]
    fn client_rejects_pipe_from_an_unexpected_server_process() {
        let token = current_token(TOKEN_QUERY).unwrap();
        let identity = token_identity(raw(&token)).unwrap();
        let name = format!(
            r"\\.\pipe\deskfleet-desktop-test-{:032x}",
            rand::random::<u128>()
        );
        let _server = Pipe::server(&name, &identity.sid).unwrap();
        let result = Pipe::open(&name, 0);
        assert!(matches!(result, Err(error) if error.kind() == io::ErrorKind::PermissionDenied));
    }

    #[test]
    fn backpressured_binary_payload_exceeding_pipe_capacity_is_delivered_intact() {
        let (mut server, mut client) = pair();
        let payload = (0..196_613)
            .map(|index| (index % 251) as u8)
            .collect::<Vec<_>>();
        let expected = payload.clone();
        let sending = std::thread::spawn(move || {
            client.write_all(&payload).unwrap();
            let mut reply = [0; 2];
            client.read_exact(&mut reply).unwrap();
            assert_eq!(&reply, b"ok");
        });
        let mut received = vec![0u8; expected.len()];
        server.read_exact(&mut received).unwrap();
        assert_eq!(received, expected);
        server.write_all(b"ok").unwrap();
        sending.join().unwrap();
        assert_eq!(server.read(&mut [0u8]).unwrap(), 0);
    }

    #[test]
    fn broker_reaccepts_without_releasing_name_while_old_client_handle_is_alive() {
        let token = current_token(TOKEN_QUERY).unwrap();
        let identity = token_identity(raw(&token)).unwrap();
        let name = format!(
            r"\\.\pipe\deskfleet-desktop-test-{:032x}",
            rand::random::<u128>()
        );
        let mut server = Pipe::server(&name, &identity.sid).unwrap();
        // SAFETY: The current process ID query has no pointer arguments.
        let pid = unsafe { GetCurrentProcessId() };
        let mut old_client = Pipe::open(&name, pid).unwrap();
        server.accept(&AtomicBool::new(false)).unwrap();
        old_client.write_all(&[1]).unwrap();
        server.read_exact(&mut [0u8]).unwrap();
        server.disconnect().unwrap();
        assert!(
            Pipe::server(&name, &identity.sid).is_err(),
            "the broker must retain ownership of its pipe name"
        );
        // A reused instance becomes connectable when ConnectNamedPipe starts
        // listening again. Let the client retry concurrently, as it does with
        // the broker loop, instead of blocking the server before accept().
        let connecting = std::thread::spawn(move || Pipe::open(&name, pid));
        server.accept(&AtomicBool::new(false)).unwrap();
        let mut next_client = connecting.join().unwrap().unwrap();
        next_client.write_all(&[2]).unwrap();
        let mut byte = [0u8];
        server.read_exact(&mut byte).unwrap();
        assert_eq!(byte, [2]);
        assert!(matches!(old_client.read(&mut byte), Ok(0) | Err(_)));
    }
}
