//! Bound desktop discovery and input transactions at the transport, including setup.
//! Xlib-compatible DISPLAY parsing and Xauthority lookup remain in x11rb.
use std::ffi::OsStr;
use std::os::fd::{AsFd, OwnedFd};
use std::os::unix::ffi::OsStrExt;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, mpsc};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use socket2::{Domain, SockAddr, Socket, Type};
use x11rb::reexports::x11rb_protocol::{parse_display::parse_display, xauth::get_auth};
use x11rb::rust_connection::{DefaultStream, RustConnection};

use crate::{Error, Result, platform};

pub(crate) const DISCOVERY_TIMEOUT: Duration = Duration::from_secs(2);

/// One transport watchdog, idle between input transactions. The native input
/// worker serializes scopes; arm/disarm messages retain that same order.
pub(crate) struct Watchdog {
    expired: Arc<AtomicBool>,
    commands: mpsc::Sender<WatchCommand>,
    worker: Option<JoinHandle<()>>,
}

enum WatchCommand {
    Arm(Instant),
    Disarm,
    Stop,
}

impl Watchdog {
    pub(crate) fn new(stream: &impl AsFd) -> Result<Self> {
        let socket = Socket::from(stream.as_fd().try_clone_to_owned().map_err(platform)?);
        let (commands, incoming) = mpsc::channel();
        let expired = Arc::new(AtomicBool::new(false));
        let worker_expired = Arc::clone(&expired);
        let worker = thread::Builder::new()
            .name("deskfleet-x11-deadline".into())
            .spawn(move || {
                let mut deadline: Option<Instant> = None;
                loop {
                    let command = match deadline {
                        Some(deadline) => incoming
                            .recv_timeout(deadline.saturating_duration_since(Instant::now())),
                        None => incoming
                            .recv()
                            .map_err(|_| mpsc::RecvTimeoutError::Disconnected),
                    };
                    match command {
                        Ok(WatchCommand::Arm(next)) => deadline = Some(next),
                        Ok(WatchCommand::Disarm) => deadline = None,
                        Ok(WatchCommand::Stop) | Err(mpsc::RecvTimeoutError::Disconnected) => break,
                        Err(mpsc::RecvTimeoutError::Timeout) => {
                            worker_expired.store(true, Ordering::Release);
                            let _ = socket.shutdown(std::net::Shutdown::Both);
                            break;
                        }
                    }
                }
            })
            .map_err(platform)?;
        Ok(Self {
            expired,
            commands,
            worker: Some(worker),
        })
    }

    fn at(&self, deadline: Instant) -> Result<Deadline> {
        if self.expired.load(Ordering::Acquire) {
            return Err(timed_out());
        }
        self.commands
            .send(WatchCommand::Arm(deadline))
            .map_err(|_| timed_out())?;
        Ok(Deadline {
            expired: Arc::clone(&self.expired),
            commands: self.commands.clone(),
            _owner: None,
        })
    }

    pub(crate) fn operation(&self) -> Result<Deadline> {
        self.at(Instant::now() + DISCOVERY_TIMEOUT)
    }
}

impl Drop for Watchdog {
    fn drop(&mut self) {
        let _ = self.commands.send(WatchCommand::Stop);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

/// Shutdown wakes x11rb's unbounded poll, including during authentication.
/// A standalone discovery scope owns its watchdog; input scopes reuse one.
pub(crate) struct Deadline {
    expired: Arc<AtomicBool>,
    commands: mpsc::Sender<WatchCommand>,
    _owner: Option<Watchdog>,
}

impl Deadline {
    pub(crate) fn new(stream: &impl AsFd, deadline: Instant) -> Result<Self> {
        let watchdog = Watchdog::new(stream)?;
        let mut scope = watchdog.at(deadline)?;
        scope._owner = Some(watchdog);
        Ok(scope)
    }

    pub(crate) fn finish<T>(&self, result: Result<T>) -> Result<T> {
        if self.expired.load(Ordering::Acquire) {
            Err(timed_out())
        } else {
            result
        }
    }
}

impl Drop for Deadline {
    fn drop(&mut self) {
        let _ = self.commands.send(WatchCommand::Disarm);
    }
}

fn timed_out() -> Error {
    Error::Unavailable("X11 desktop operation timed out after 2 seconds".into())
}

pub(crate) fn connect() -> Result<(RustConnection, Deadline)> {
    let deadline = Instant::now() + DISCOVERY_TIMEOUT;
    let display =
        std::env::var("DISPLAY").map_err(|_| Error::Unavailable("DISPLAY is not set".into()))?;
    let display = normalize_display(&display);
    let parsed =
        parse_display(Some(&display)).map_err(|error| Error::Unavailable(error.to_string()))?;
    if parsed
        .protocol
        .as_deref()
        .is_some_and(|protocol| protocol != "unix")
        || (!parsed.host.is_empty()
            && parsed.host != "unix"
            && parsed.protocol.as_deref() != Some("unix"))
    {
        return Err(Error::Unavailable("only local Unix X11 displays are supported; TCP and SSH-forwarded DISPLAY are unsupported".into()));
    }
    let path = if parsed.host.starts_with('/') {
        parsed.host.clone()
    } else {
        format!("/tmp/.X11-unix/X{}", parsed.display)
    };
    let socket =
        open_socket(&path, deadline).map_err(|error| Error::Unavailable(error.to_string()))?;
    let fd: OwnedFd = socket.into();
    let (stream, (family, address)) =
        DefaultStream::from_unix_stream(fd.into()).map_err(platform)?;
    let guard = Deadline::new(&stream, deadline)?;
    let (name, data) = get_auth(family, &address, parsed.display)
        .unwrap_or(None)
        .unwrap_or_default();
    let connection = guard.finish(
        RustConnection::connect_to_stream_with_auth_info(
            stream,
            usize::from(parsed.screen),
            name,
            data,
        )
        .map_err(|error| Error::Unavailable(error.to_string())),
    )?;
    Ok((connection, guard))
}

fn normalize_display(display: &str) -> String {
    // x11rb also uses unix:/absolute/path for direct socket paths. Preserve it,
    // while accepting the conventional unix:N.S spelling as a local display.
    if let Some(number) = display.strip_prefix("unix:")
        && !number.is_empty()
        && number
            .bytes()
            .all(|byte| byte.is_ascii_digit() || byte == b'.')
    {
        format!(":{number}")
    } else {
        display.to_owned()
    }
}

fn open_socket(path: &str, deadline: Instant) -> std::io::Result<Socket> {
    let abstract_path = [&[0], path.as_bytes()].concat();
    let addresses = [
        SockAddr::unix(OsStr::from_bytes(&abstract_path))?,
        SockAddr::unix(path)?,
    ];
    let mut failure = None;
    for address in addresses {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(std::io::ErrorKind::TimedOut.into());
        }
        let socket = Socket::new(Domain::UNIX, Type::STREAM, None)?;
        match socket.connect_timeout(&address, remaining) {
            Ok(()) => return Ok(socket),
            Err(error) => failure = Some(error),
        }
    }
    Err(failure.unwrap_or_else(|| std::io::ErrorKind::NotConnected.into()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn conventional_unix_display_keeps_its_screen_number() {
        let display = normalize_display("unix:12.3");
        let parsed = parse_display(Some(&display)).unwrap();
        assert_eq!((parsed.display, parsed.screen), (12, 3));
        assert_eq!(
            normalize_display("unix:/tmp/X11.sock"),
            "unix:/tmp/X11.sock"
        );
        assert_eq!(normalize_display(":12.3"), ":12.3");
    }

    #[test]
    fn watchdog_disarms_between_operations_and_interrupts_the_next_stall() {
        use std::io::Read;
        use std::os::unix::net::UnixStream;

        let (stream, mut peer) = UnixStream::pair().unwrap();
        peer.set_read_timeout(Some(Duration::from_secs(1))).unwrap();
        let watchdog = Watchdog::new(&stream).unwrap();
        drop(
            watchdog
                .at(Instant::now() + Duration::from_millis(20))
                .unwrap(),
        );
        std::thread::sleep(Duration::from_millis(40));
        let deadline = watchdog
            .at(Instant::now() + Duration::from_millis(20))
            .unwrap();
        assert_eq!(peer.read(&mut [0]).unwrap(), 0);
        assert!(deadline.finish(Ok(())).is_err());
        assert!(watchdog.operation().is_err());
    }
}
