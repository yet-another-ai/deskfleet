//! A desktop controller owns one OS thread and releases held input on shutdown.

use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use std::thread::JoinHandle;

use deskfleet_input::InputSession;
pub use deskfleet_input::{InputError, InputEvent};
use tokio::sync::{mpsc, oneshot};

type Result<T> = std::result::Result<T, InputError>;
type Command = (InputEvent, oneshot::Sender<Result<()>>);

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
        let thread = std::thread::Builder::new()
            .name("desktop-input".into())
            .spawn(move || {
                let mut session = match InputSession::new(display_id) {
                    Ok(session) => session,
                    Err(error) => {
                        let _ = ready.send(Err(error));
                        return Ok(());
                    }
                };
                if ready.send(Ok(())).is_err() {
                    return session.release_all();
                }
                while let Some((event, reply)) = receiver.blocking_recv() {
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
