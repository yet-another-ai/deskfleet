//! Reactor-driven Unix PTY I/O with explicit shutdown and child-exit wakeups.

use std::io::{self, Read, Write};
use std::os::fd::{AsRawFd, RawFd};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use filedescriptor::FileDescriptor;
use portable_pty::{CommandBuilder, MasterPty, PtyPair};
use tokio::io::{Interest, unix::AsyncFd};
use tokio::runtime::Handle;
use tokio::sync::{Mutex as AsyncMutex, mpsc, oneshot, watch};

use super::{
    OUTPUT_CHUNK_BYTES, OUTPUT_QUEUE_CHUNKS, Result, Terminal, TerminalError, TerminalEvent,
    backend, lock,
};

mod process;
use process::Process;

type Exit = Option<std::result::Result<portable_pty::ExitStatus, String>>;

pub(super) struct Handles {
    pub(super) master: Mutex<Option<Box<dyn MasterPty + Send>>>,
    pub(super) closed: AtomicBool,
    process: Arc<Process>,
    input: mpsc::Sender<Input>,
    shutdown: watch::Sender<bool>,
}

struct Input {
    data: Vec<u8>,
    reply: oneshot::Sender<Result<()>>,
}

impl Handles {
    #[cfg(test)]
    pub(super) fn has_exited(&self) -> bool {
        self.process.subscribe().borrow().is_some()
    }

    #[cfg(test)]
    pub(super) fn process_id(&self) -> u32 {
        self.process.process_id()
    }

    pub(super) fn close(&self) -> Result<()> {
        self.closed.store(true, Ordering::Release);
        self.shutdown.send_replace(true);
        let mut master = lock(&self.master);
        let group = master
            .as_ref()
            .and_then(|master| master.process_group_leader());
        // Cancellation releases the async reader/writer FDs. Drop the original
        // master before waiting: a killed process can wait on PTY output on macOS.
        master.take();
        drop(master);
        self.process.terminate(group)
    }

    pub(super) async fn write(&self, data: Vec<u8>) -> Result<()> {
        if self.closed.load(Ordering::Acquire) {
            return Err(TerminalError::Closed);
        }
        let (reply, result) = oneshot::channel();
        self.input
            .send(Input { data, reply })
            .await
            .map_err(|_| TerminalError::Closed)?;
        result.await.map_err(|_| TerminalError::Closed)?
    }
}

struct MasterFd<'a> {
    fd: RawFd,
    _master: &'a dyn MasterPty,
}

impl AsRawFd for MasterFd<'_> {
    fn as_raw_fd(&self) -> RawFd {
        self.fd
    }
}

#[allow(unsafe_code)]
fn io(master: &dyn MasterPty) -> Result<(AsyncFd<FileDescriptor>, AsyncFd<FileDescriptor>)> {
    let master_fd = MasterFd {
        fd: master
            .as_raw_fd()
            .ok_or_else(|| backend("open I/O", "PTY has no file descriptor"))?,
        _master: master,
    };
    let mut reader =
        FileDescriptor::dup(&master_fd).map_err(|error| backend("open reader", error))?;
    reader
        .set_non_blocking(true)
        .map_err(|error| backend("configure reader", error))?;
    let writer = reader
        .try_clone()
        .map_err(|error| backend("open writer", error))?;
    // SAFETY: each FileDescriptor owns its duplicated FD. Neither FD is replaced
    // or closed until its AsyncFd is dropped, which deregisters it first.
    let reader = unsafe { AsyncFd::register_with_interest(reader, Interest::READABLE) }
        .map_err(|error| backend("register reader", error))?;
    // SAFETY: the writer owns a different duplicated FD with the same lifetime guarantee.
    let writer = unsafe { AsyncFd::register_with_interest(writer, Interest::WRITABLE) }
        .map_err(|error| backend("register writer", error))?;
    Ok((reader, writer))
}

pub(super) fn spawn(pair: PtyPair, command: CommandBuilder, runtime: &Handle) -> Result<Terminal> {
    let (reader, writer) = io(&*pair.master)?;
    let child = pair
        .slave
        .spawn_command(command)
        .map_err(|error| backend("spawn", error))?;
    drop(pair.slave);
    let process = Process::new(child);
    let (shutdown, cancelled) = watch::channel(false);
    let (input, requests) = mpsc::channel(1);
    let handles = Arc::new(Handles {
        master: Mutex::new(Some(pair.master)),
        closed: AtomicBool::new(false),
        process: Arc::clone(&process),
        input,
        shutdown: shutdown.clone(),
    });
    let (events, receiver) = mpsc::channel(OUTPUT_QUEUE_CHUNKS);
    let terminal = Terminal {
        handles: Arc::clone(&handles),
        events: AsyncMutex::new(receiver),
        shutdown,
    };
    process.start_waiter()?;
    runtime.spawn(write_input(
        writer,
        requests,
        cancelled.clone(),
        process.subscribe(),
    ));
    let reader_events = events.clone();
    let reader_handles = Arc::clone(&handles);
    let reader_cancelled = cancelled.clone();
    let exited = process.subscribe();
    let (read_done, read_finished) = oneshot::channel();
    runtime.spawn(async move {
        let mut cancelled = reader_cancelled;
        if let Err(error) = read_output(reader, &reader_events, &mut cancelled, exited).await {
            send_event(
                &reader_events,
                TerminalEvent::Error(error.to_string()),
                &mut cancelled,
            )
            .await;
            // read_output has released its FD before kill/wait.
            let _ = tokio::task::spawn_blocking(move || reader_handles.close()).await;
        }
        let _ = read_done.send(());
    });
    runtime.spawn(finish(
        handles,
        events,
        cancelled,
        process.subscribe(),
        read_finished,
    ));
    Ok(terminal)
}

async fn send_event(
    events: &mpsc::Sender<TerminalEvent>,
    event: TerminalEvent,
    cancelled: &mut watch::Receiver<bool>,
) -> bool {
    if *cancelled.borrow() {
        return false;
    }
    tokio::select! {
        result = events.send(event) => result.is_ok(),
        _ = cancelled.changed() => false,
    }
}

async fn read_output(
    mut reader: AsyncFd<FileDescriptor>,
    events: &mpsc::Sender<TerminalEvent>,
    cancelled: &mut watch::Receiver<bool>,
    mut exited: watch::Receiver<Exit>,
) -> Result<()> {
    let mut buffer = [0; OUTPUT_CHUNK_BYTES];
    loop {
        if *cancelled.borrow() {
            return Ok(());
        }
        let has_exited = exited.borrow().is_some();
        let result = if has_exited {
            // A descendant can retain the slave after the shell exits. Drain
            // bytes already available, then finish at WouldBlock instead of EOF.
            match reader.get_mut().read(&mut buffer) {
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => return Ok(()),
                result => result,
            }
        } else {
            tokio::select! {
                result = reader.async_io_mut(Interest::READABLE, |fd| fd.read(&mut buffer)) => result,
                _ = cancelled.changed() => return Ok(()),
                _ = exited.changed() => continue,
            }
        };
        match result {
            Ok(0) => return Ok(()),
            Ok(length) => {
                if !send_event(
                    events,
                    TerminalEvent::Data(buffer[..length].to_vec()),
                    cancelled,
                )
                .await
                {
                    return Ok(());
                }
            }
            Err(error) if error.raw_os_error() == Some(nix::libc::EIO) => return Ok(()),
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(backend("read", error)),
        }
    }
}

async fn write_input(
    mut writer: AsyncFd<FileDescriptor>,
    mut requests: mpsc::Receiver<Input>,
    mut cancelled: watch::Receiver<bool>,
    mut exited: watch::Receiver<Exit>,
) {
    loop {
        if *cancelled.borrow() || exited.borrow().is_some() {
            return;
        }
        let request = tokio::select! {
            request = requests.recv() => match request { Some(request) => request, None => return },
            _ = cancelled.changed() => return,
            _ = exited.changed() => return,
        };
        let result = tokio::select! {
            result = write_all(&mut writer, &request.data) => result,
            _ = cancelled.changed() => Err(TerminalError::Closed),
            _ = exited.changed() => Err(TerminalError::Closed),
        };
        let _ = request.reply.send(result);
    }
}

async fn write_all(writer: &mut AsyncFd<FileDescriptor>, mut data: &[u8]) -> Result<()> {
    while !data.is_empty() {
        match writer
            .async_io_mut(Interest::WRITABLE, |fd| fd.write(data))
            .await
        {
            Ok(0) => return Err(backend("write", io::Error::from(io::ErrorKind::WriteZero))),
            Ok(length) => data = &data[length..],
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(backend("write", error)),
        }
    }
    Ok(())
}

async fn finish(
    handles: Arc<Handles>,
    events: mpsc::Sender<TerminalEvent>,
    mut cancelled: watch::Receiver<bool>,
    mut exited: watch::Receiver<Exit>,
    read_finished: oneshot::Receiver<()>,
) {
    let status = loop {
        if let Some(status) = exited.borrow().clone() {
            break status;
        }
        if *cancelled.borrow() {
            return;
        }
        tokio::select! {
            _ = exited.changed() => {},
            _ = cancelled.changed() => return,
        }
    };
    if status.is_ok() {
        handles.closed.store(true, Ordering::Release);
    }
    // The reader may still be blocked on the bounded output queue. Only report
    // exit after it has delivered the final bytes, unless explicitly closed.
    tokio::select! {
        _ = read_finished => {},
        _ = cancelled.changed() => return,
    }
    lock(&handles.master).take();
    match status {
        Ok(status) => {
            send_event(
                &events,
                TerminalEvent::Exit {
                    exit_code: status.exit_code(),
                },
                &mut cancelled,
            )
            .await;
        }
        Err(error) => {
            send_event(&events, TerminalEvent::Error(error), &mut cancelled).await;
            // An observation failure must not leave a live owned child behind.
            let _ = tokio::task::spawn_blocking(move || handles.close()).await;
        }
    }
}
