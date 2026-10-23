//! Daemon-owned PTYs. Detaching a transport does not affect the terminal.

use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, mpsc as sync_mpsc};
use std::time::Duration;

use portable_pty::{Child, CommandBuilder, MasterPty, PtySize, native_pty_system};
use tokio::runtime::Handle;
use tokio::sync::{Mutex as AsyncMutex, mpsc, watch};

const OUTPUT_CHUNK_BYTES: usize = 16 * 1024;
const OUTPUT_QUEUE_CHUNKS: usize = 64;
const MAX_INPUT_BYTES: usize = 64 * 1024;

#[cfg(unix)]
mod unix;

#[derive(Debug, thiserror::Error)]
pub enum TerminalError {
    #[error("terminal dimensions must be positive")]
    InvalidSize,
    #[error("terminal cwd is not a directory: {0}")]
    InvalidDirectory(PathBuf),
    #[error("terminal is closed")]
    Closed,
    #[error("terminal input exceeds 64 KiB")]
    InputTooLarge,
    #[error("terminal events already have a consumer")]
    ConcurrentConsumer,
    #[error("terminal {operation}: {message}")]
    Backend {
        operation: &'static str,
        message: String,
    },
}

type Result<T> = std::result::Result<T, TerminalError>;

#[derive(Debug, Clone)]
pub struct TerminalConfig {
    pub cwd: PathBuf,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TerminalEvent {
    Data(Vec<u8>),
    Exit { exit_code: u32 },
    Error(String),
}

struct Handles {
    master: Mutex<Option<Box<dyn MasterPty + Send>>>,
    writer: Mutex<Option<Box<dyn Write + Send>>>,
    child: Mutex<Box<dyn Child + Send + Sync>>,
    closed: Arc<AtomicBool>,
}

fn lock<T>(value: &Mutex<T>) -> MutexGuard<'_, T> {
    value
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn backend(operation: &'static str, error: impl std::fmt::Display) -> TerminalError {
    TerminalError::Backend {
        operation,
        message: error.to_string(),
    }
}

fn size(cols: u16, rows: u16) -> Result<PtySize> {
    if cols == 0 || rows == 0 {
        return Err(TerminalError::InvalidSize);
    }
    Ok(PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    })
}

impl Handles {
    // Kill before taking the writer lock: a pending write can be blocked on
    // the child reading input, and terminating the child releases that write.
    fn close(&self) -> Result<()> {
        self.closed.store(true, Ordering::Release);
        let mut child = lock(&self.child);
        #[cfg(unix)]
        if child
            .try_wait()
            .map_err(|error| backend("wait", error))?
            .is_none()
        {
            // Interactive shells put the foreground job in a separate group.
            // Hang up that job too, as closing a terminal emulator does.
            if let Some(group) = lock(&self.master)
                .as_ref()
                .and_then(|master| master.process_group_leader())
            {
                let _ = nix::sys::signal::killpg(
                    nix::unistd::Pid::from_raw(group),
                    nix::sys::signal::Signal::SIGHUP,
                );
            }
        }
        let result = match child.try_wait().map_err(|error| backend("wait", error)) {
            Ok(None) => child.kill().map_err(|error| backend("terminate", error)),
            Ok(Some(_)) => Ok(()),
            Err(error) => Err(error),
        };
        // A killed process can wait for PTY output to drain on macOS. Release
        // master handles before wait(), including after a saturated reader.
        lock(&self.writer).take();
        lock(&self.master).take();
        result?;
        child.wait().map_err(|error| backend("wait", error))?;
        Ok(())
    }
}

/// Keep this object in the daemon's session registry, independently of peers.
pub struct Terminal {
    handles: Arc<Handles>,
    events: AsyncMutex<mpsc::Receiver<TerminalEvent>>,
    shutdown: watch::Sender<bool>,
}

impl Terminal {
    /// Spawn the user's default shell in a PTY. Unix shells are login shells.
    ///
    /// # Errors
    /// Returns an error for an invalid directory or size, or OS spawn failure.
    pub async fn spawn(config: TerminalConfig) -> Result<Self> {
        Self::spawn_command(config, CommandBuilder::new_default_prog()).await
    }

    async fn spawn_command(config: TerminalConfig, mut command: CommandBuilder) -> Result<Self> {
        let runtime = Handle::current();
        tokio::task::spawn_blocking(move || {
            let dimensions = size(config.cols, config.rows)?;
            // portable-pty falls back to HOME for an invalid cwd. Reject it so
            // the reported terminal directory matches the process we launch.
            if !config.cwd.is_absolute() || !config.cwd.is_dir() {
                return Err(TerminalError::InvalidDirectory(config.cwd));
            }
            command.cwd(&config.cwd);
            command.env("TERM", "xterm-256color");
            command.env("COLORTERM", "truecolor");
            let pair = native_pty_system()
                .openpty(dimensions)
                .map_err(|error| backend("open PTY", error))?;
            let (shutdown, cancelled) = watch::channel(false);
            let closed = Arc::new(AtomicBool::new(false));
            #[cfg(unix)]
            let (reader, writer) = unix::io(&*pair.master, Arc::clone(&closed), cancelled.clone())?;
            #[cfg(not(unix))]
            let reader = pair
                .master
                .try_clone_reader()
                .map_err(|error| backend("open reader", error))?;
            #[cfg(not(unix))]
            let writer = pair
                .master
                .take_writer()
                .map_err(|error| backend("open writer", error))?;
            #[cfg(windows)]
            let writer = reply_conpty_cursor(writer)?;
            let child = pair
                .slave
                .spawn_command(command)
                .map_err(|error| backend("spawn", error))?;
            drop(pair.slave);

            let handles = Arc::new(Handles {
                master: Mutex::new(Some(pair.master)),
                writer: Mutex::new(Some(writer)),
                child: Mutex::new(child),
                closed,
            });
            let (events, receiver) = mpsc::channel(OUTPUT_QUEUE_CHUNKS);
            let terminal = Self {
                handles: Arc::clone(&handles),
                events: AsyncMutex::new(receiver),
                shutdown,
            };
            let (read_done, read_finished) = sync_mpsc::channel();
            let reader_events = events.clone();
            let mut reader_cancelled = cancelled.clone();
            let reader_runtime = runtime.clone();
            let reader_handles = Arc::clone(&handles);
            std::thread::Builder::new()
                .name("deskfleet-pty-read".into())
                .spawn(move || {
                    if let Err(error) = read_output(
                        reader,
                        &reader_events,
                        &mut reader_cancelled,
                        &reader_runtime,
                    ) {
                        send_event(
                            &reader_events,
                            TerminalEvent::Error(error.to_string()),
                            &mut reader_cancelled,
                            &reader_runtime,
                        );
                        // read_output has released its FD before kill/wait.
                        let _ = reader_handles.close();
                    }
                    let _ = read_done.send(());
                })
                .map_err(|error| backend("start reader", error))?;
            std::thread::Builder::new()
                .name("deskfleet-pty-wait".into())
                .spawn(move || {
                    wait_for_exit(&handles, read_finished, &events, cancelled, &runtime);
                })
                .map_err(|error| backend("start reaper", error))?;
            Ok(terminal)
        })
        .await
        .map_err(|error| backend("spawn worker", error))?
    }

    /// Write input bytes without decoding UTF-8 or interpreting escape sequences.
    pub async fn write(&self, data: Vec<u8>) -> Result<()> {
        if data.len() > MAX_INPUT_BYTES {
            return Err(TerminalError::InputTooLarge);
        }
        let handles = Arc::clone(&self.handles);
        tokio::task::spawn_blocking(move || {
            let mut writer = lock(&handles.writer);
            if handles.closed.load(Ordering::Acquire) {
                return Err(TerminalError::Closed);
            }
            let writer = writer.as_mut().ok_or(TerminalError::Closed)?;
            writer
                .write_all(&data)
                .map_err(|error| backend("write", error))
        })
        .await
        .map_err(|error| backend("write worker", error))?
    }

    pub async fn resize(&self, cols: u16, rows: u16) -> Result<()> {
        let dimensions = size(cols, rows)?;
        let handles = Arc::clone(&self.handles);
        tokio::task::spawn_blocking(move || {
            let master = lock(&handles.master);
            if handles.closed.load(Ordering::Acquire) {
                return Err(TerminalError::Closed);
            }
            master
                .as_ref()
                .ok_or(TerminalError::Closed)?
                .resize(dimensions)
                .map_err(|error| backend("resize", error))
        })
        .await
        .map_err(|error| backend("resize worker", error))?
    }

    /// One daemon loop consumes output, including while no client is attached.
    pub async fn next_event(&self) -> Result<Option<TerminalEvent>> {
        let mut events = self
            .events
            .try_lock()
            .map_err(|_| TerminalError::ConcurrentConsumer)?;
        let mut shutdown = self.shutdown.subscribe();
        if *shutdown.borrow() {
            events.close();
            return Ok(events.recv().await);
        }
        Ok(tokio::select! {
            event = events.recv() => event,
            _ = shutdown.changed() => {
                events.close();
                events.recv().await
            }
        })
    }

    /// Explicit termination; peer disconnection must not call this method.
    pub async fn close(&self) -> Result<()> {
        self.shutdown.send_replace(true);
        let handles = Arc::clone(&self.handles);
        tokio::task::spawn_blocking(move || handles.close())
            .await
            .map_err(|error| backend("close worker", error))?
    }
}

impl Drop for Terminal {
    fn drop(&mut self) {
        self.shutdown.send_replace(true);
        if !self.handles.closed.load(Ordering::Acquire) {
            let handles = Arc::clone(&self.handles);
            // Finalization may run on Node's event loop, where kill/wait must
            // never block. Explicit close remains the normal shutdown path.
            let _ = std::thread::Builder::new()
                .name("deskfleet-pty-close".into())
                .spawn(move || {
                    if let Err(error) = handles.close() {
                        tracing::warn!(%error, "terminal cleanup failed");
                    }
                });
        }
    }
}

fn send_event(
    events: &mpsc::Sender<TerminalEvent>,
    event: TerminalEvent,
    cancelled: &mut watch::Receiver<bool>,
    runtime: &Handle,
) -> bool {
    if *cancelled.borrow() {
        return false;
    }
    runtime.block_on(async {
        tokio::select! {
            result = events.send(event) => result.is_ok(),
            _ = cancelled.changed() => false,
        }
    })
}

#[cfg(windows)]
fn reply_conpty_cursor(mut writer: Box<dyn Write + Send>) -> Result<Box<dyn Write + Send>> {
    // portable-pty 0.9 sets PSEUDOCONSOLE_INHERIT_CURSOR. ConPTY writes
    // ESC[6n and will not run the child until the host answers.
    writer
        .write_all(b"\x1b[1;1R")
        .map_err(|error| backend("cursor report", error))?;
    writer
        .flush()
        .map_err(|error| backend("cursor report", error))?;
    Ok(writer)
}

fn read_output(
    mut reader: Box<dyn Read + Send>,
    events: &mpsc::Sender<TerminalEvent>,
    cancelled: &mut watch::Receiver<bool>,
    runtime: &Handle,
) -> Result<()> {
    let mut buffer = [0_u8; OUTPUT_CHUNK_BYTES];
    loop {
        match reader.read(&mut buffer) {
            Ok(0) => break,
            Ok(length) => {
                if !send_event(
                    events,
                    TerminalEvent::Data(buffer[..length].to_vec()),
                    cancelled,
                    runtime,
                ) {
                    break;
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(backend("read", error)),
        }
    }
    Ok(())
}

fn wait_for_exit(
    handles: &Handles,
    read_finished: sync_mpsc::Receiver<()>,
    events: &mpsc::Sender<TerminalEvent>,
    mut cancelled: watch::Receiver<bool>,
    runtime: &Handle,
) {
    let status = loop {
        if *cancelled.borrow() {
            return;
        }
        let result = lock(&handles.child).try_wait();
        match result {
            Ok(Some(status)) => break status,
            Ok(None) => std::thread::sleep(Duration::from_millis(25)),
            Err(error) => {
                send_event(
                    events,
                    TerminalEvent::Error(backend("wait", error).to_string()),
                    &mut cancelled,
                    runtime,
                );
                return;
            }
        }
    };
    handles.closed.store(true, Ordering::Release);
    #[cfg(windows)]
    {
        // Closing ConPTY terminates its client side and lets the active reader
        // finish draining output even if a child inherited a console handle.
        lock(&handles.writer).take();
        lock(&handles.master).take();
    }
    // Preserve output-before-exit ordering even if the bounded queue is full.
    loop {
        match read_finished.recv_timeout(Duration::from_millis(25)) {
            Ok(()) | Err(sync_mpsc::RecvTimeoutError::Disconnected) => break,
            Err(sync_mpsc::RecvTimeoutError::Timeout) if *cancelled.borrow() => return,
            Err(sync_mpsc::RecvTimeoutError::Timeout) => {}
        }
    }
    lock(&handles.writer).take();
    lock(&handles.master).take();
    send_event(
        events,
        TerminalEvent::Exit {
            exit_code: status.exit_code(),
        },
        &mut cancelled,
        runtime,
    );
}

#[cfg(test)]
mod tests;
