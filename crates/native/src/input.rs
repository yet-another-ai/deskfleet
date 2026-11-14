//! A desktop controller owns one OS thread and releases held input on shutdown.

use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use std::thread::JoinHandle;
use std::time::Duration;

use deskfleet_input::InputSession;
pub use deskfleet_input::{InputError, InputEvent};
use tokio::sync::{mpsc, oneshot};

type Result<T> = std::result::Result<T, InputError>;
type Command = (InputEvent, oneshot::Sender<Result<()>>);

enum Session {
    Local(InputSession),
    #[cfg(target_os = "linux")]
    Android(InputSession<crate::android_scrcpy::ScrcpyInput>),
    #[cfg(windows)]
    Service {
        client: crate::windows_desktop::Client,
        _lease: deskfleet_input::ControlLease,
    },
}

impl Session {
    fn open(display_id: u32) -> Result<Self> {
        #[cfg(target_os = "linux")]
        if crate::android_scrcpy::is_configured() {
            return Ok(Self::Android(InputSession::with_backend(|| {
                crate::android_scrcpy::ScrcpyInput::open(display_id)
            })?));
        }
        #[cfg(windows)]
        if let Some(mut client) =
            crate::windows_desktop::Client::connect().map_err(service_error)?
        {
            let lease = deskfleet_input::ControlLease::acquire()?;
            client.start_input(display_id).map_err(service_error)?;
            return Ok(Self::Service {
                client,
                _lease: lease,
            });
        }
        Ok(Self::Local(InputSession::new(display_id)?))
    }

    fn handle(&mut self, event: InputEvent) -> Result<()> {
        match self {
            Self::Local(session) => session.handle(event),
            #[cfg(target_os = "linux")]
            Self::Android(session) => session.handle(event),
            #[cfg(windows)]
            Self::Service { client, .. } => {
                if matches!(event, InputEvent::SecureAttention) {
                    client
                        .input(InputEvent::ReleaseAll)
                        .map_err(service_error)?;
                    deskfleet_windows_desktop::send_secure_attention()
                        .map_err(|error| InputError::Platform(error.to_string()))
                } else {
                    client.input(event).map_err(service_error)
                }
            }
        }
    }

    fn refresh(&mut self) -> Result<()> {
        match self {
            Self::Local(session) => session.refresh_desktop(),
            #[cfg(target_os = "linux")]
            Self::Android(session) => session.refresh_desktop(),
            #[cfg(windows)]
            Self::Service { client, .. } => client.refresh_input().map_err(service_error),
        }
    }

    fn release_all(&mut self) -> Result<()> {
        match self {
            Self::Local(session) => session.release_all(),
            #[cfg(target_os = "linux")]
            Self::Android(session) => session.release_all(),
            #[cfg(windows)]
            Self::Service { client, .. } => client.stop().map_err(service_error),
        }
    }
}

#[cfg(windows)]
fn service_error(error: crate::media::MediaError) -> InputError {
    InputError::Platform(error.to_string())
}

/// Check this process's Accessibility permission without prompting.
///
/// Returns `None` on platforms without an upfront permission request.
///
/// # Errors
/// Returns an error if the permission worker fails.
pub async fn check_accessibility_access() -> Result<Option<bool>> {
    tokio::task::spawn_blocking(deskfleet_input::check_accessibility_access)
        .await
        .map_err(|error| InputError::Platform(error.to_string()))
}

/// Request this process's Accessibility permission without opening input.
/// Opens the macOS privacy pane when access remains denied.
///
/// Returns `None` on platforms without an upfront permission request.
///
/// # Errors
/// Returns an error if the permission worker or System Settings fails.
pub async fn request_accessibility_access() -> Result<Option<bool>> {
    tokio::task::spawn_blocking(|| {
        let granted = deskfleet_input::request_accessibility_access();
        #[cfg(target_os = "macos")]
        if granted == Some(false) {
            crate::permission_settings::open("Privacy_Accessibility")
                .map_err(|error| InputError::Platform(error.to_string()))?;
        }
        Ok(granted)
    })
    .await
    .map_err(|error| InputError::Platform(error.to_string()))?
}

/// Serializes OS input without blocking Node's event loop or moving OS state.
pub struct InputWorker {
    sender: Option<mpsc::Sender<Command>>,
    stopped: Arc<AtomicBool>,
    thread: Option<JoinHandle<Result<()>>>,
}

impl InputWorker {
    /// Initialize input only for an explicitly authorized desktop controller.
    pub async fn start(display_id: u32) -> Result<Self> {
        let (sender, mut receiver) = mpsc::channel::<Command>(32);
        let (ready, initialized) = oneshot::channel();
        let stopped = Arc::new(AtomicBool::new(false));
        let stop = Arc::clone(&stopped);
        let runtime = tokio::runtime::Handle::current();
        let thread = std::thread::Builder::new()
            .name("desktop-input".into())
            .spawn(move || {
                let mut session = match Session::open(display_id) {
                    Ok(session) => session,
                    Err(error) => {
                        let _ = ready.send(Err(error));
                        return Ok(());
                    }
                };
                if ready.send(Ok(())).is_err() {
                    return session.release_all();
                }
                let mut refresh_failed = false;
                loop {
                    if stop.load(Ordering::Acquire) {
                        break;
                    }
                    let command = runtime.block_on(async {
                        tokio::time::timeout(Duration::from_millis(100), receiver.recv()).await
                    });
                    let (event, reply) = match command {
                        Ok(Some(command)) => command,
                        Ok(None) => break,
                        Err(_) => {
                            match session.refresh() {
                                Ok(()) => refresh_failed = false,
                                Err(error) if !refresh_failed => {
                                    tracing::warn!(%error, "desktop input refresh failed");
                                    refresh_failed = true;
                                }
                                Err(_) => {}
                            }
                            continue;
                        }
                    };
                    if stop.load(Ordering::Acquire) {
                        break;
                    }
                    let result = session.handle(event);
                    let failed = result.is_err();
                    let _ = reply.send(result);
                    if failed {
                        break;
                    }
                }
                session.release_all()
            })
            .map_err(|error| InputError::Platform(error.to_string()))?;
        let worker = Self {
            sender: Some(sender),
            stopped,
            thread: Some(thread),
        };
        initialized.await.map_err(|_| closed())??;
        Ok(worker)
    }

    /// Apply one validated message in arrival order.
    pub async fn handle(&self, event: InputEvent) -> Result<()> {
        if self.stopped.load(Ordering::Acquire) {
            return Err(closed());
        }
        let (reply, result) = oneshot::channel();
        self.sender
            .as_ref()
            .ok_or_else(closed)?
            .send((event, reply))
            .await
            .map_err(|_| closed())?;
        result.await.map_err(|_| closed())?
    }

    /// Discard queued input, release held controls and join the OS worker.
    pub async fn stop(mut self) -> Result<()> {
        self.stopped.store(true, Ordering::Release);
        self.sender.take();
        if let Some(thread) = self.thread.take() {
            tokio::task::spawn_blocking(move || thread.join())
                .await
                .map_err(|error| InputError::Platform(error.to_string()))?
                .map_err(|_| InputError::Platform("desktop input worker panicked".into()))??;
        }
        Ok(())
    }
}

impl Drop for InputWorker {
    fn drop(&mut self) {
        self.stopped.store(true, Ordering::Release);
        self.sender.take();
    }
}

fn closed() -> InputError {
    InputError::Platform("desktop input controller is closed".into())
}
