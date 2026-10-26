use std::{
    os::fd::OwnedFd,
    path::PathBuf,
    sync::{
        Arc, Mutex, OnceLock,
        atomic::{AtomicU64, Ordering},
    },
};

use futures_util::StreamExt;
use tokio::sync::{mpsc, oneshot};

use crate::{
    Error, PermissionSnapshot, PermissionStatus, Result, Source,
    input::Action,
    portal::{self, Live},
};

type Reply<T> = oneshot::Sender<Result<T>>;

enum Command {
    Request(Option<PathBuf>, Reply<PermissionSnapshot>),
    Shutdown(Reply<()>),
    Open(u32, Reply<(OwnedFd, Source)>),
    Attach(u64, u32, Reply<()>),
    Input(u64, Action, Reply<()>),
    Detach(u64),
}

#[derive(Default)]
struct Observed {
    snapshot: PermissionSnapshot,
    sources: Vec<Source>,
}

struct Handle {
    commands: mpsc::UnboundedSender<Command>,
    observed: Arc<Mutex<Observed>>,
}

static RUNTIME: OnceLock<std::result::Result<Handle, String>> = OnceLock::new();

fn handle() -> Result<&'static Handle> {
    RUNTIME
        .get_or_init(|| {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .map_err(|error| error.to_string())?;
            let (commands, receiver) = mpsc::unbounded_channel();
            let observed = Arc::new(Mutex::new(Observed::default()));
            let state = observed.clone();
            std::thread::Builder::new()
                .name("deskfleet-wayland".into())
                .spawn(move || runtime.block_on(run(receiver, state, PortalAuthorizer)))
                .map_err(|error| error.to_string())?;
            Ok(Handle { commands, observed })
        })
        .as_ref()
        .map_err(|error| Error::Unavailable(error.clone()))
}

fn send(command: Command) -> Result<()> {
    handle()?.commands.send(command).map_err(|_| Error::Stopped)
}

pub async fn request(directory: Option<PathBuf>) -> Result<PermissionSnapshot> {
    let (reply, response) = oneshot::channel();
    send(Command::Request(directory, reply))?;
    response.await.map_err(|_| Error::Stopped)?
}

pub fn snapshot() -> PermissionSnapshot {
    let Some(Ok(handle)) = RUNTIME.get() else {
        return PermissionSnapshot::default();
    };
    handle
        .observed
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .snapshot
        .clone()
}

pub fn sources() -> Result<Vec<Source>> {
    let Some(Ok(handle)) = RUNTIME.get() else {
        return Err(Error::PermissionDenied);
    };
    let state = handle
        .observed
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    if !state.snapshot.screen_capture {
        return Err(Error::PermissionDenied);
    }
    Ok(state.sources.clone())
}

pub async fn shutdown() -> Result<()> {
    if RUNTIME.get().is_none() {
        return Ok(());
    }
    let (reply, response) = oneshot::channel();
    send(Command::Shutdown(reply))?;
    response.await.map_err(|_| Error::Stopped)?
}

pub fn open_pipewire(id: u32) -> Result<(OwnedFd, Source)> {
    let (reply, response) = oneshot::channel();
    send(Command::Open(id, reply))?;
    response.blocking_recv().map_err(|_| Error::Stopped)?
}

pub fn attach(source: u32) -> Result<u64> {
    static NEXT: AtomicU64 = AtomicU64::new(1);
    let id = NEXT
        .try_update(Ordering::Relaxed, Ordering::Relaxed, |id| id.checked_add(1))
        .map_err(|_| Error::Stopped)?;
    let (reply, response) = oneshot::channel();
    send(Command::Attach(id, source, reply))?;
    response.blocking_recv().map_err(|_| Error::Stopped)??;
    Ok(id)
}

pub fn input(id: u64, action: Action) -> Result<()> {
    let (reply, response) = oneshot::channel();
    send(Command::Input(id, action, reply))?;
    response.blocking_recv().map_err(|_| Error::Stopped)?
}

pub fn detach(id: u64) {
    if let Some(Ok(handle)) = RUNTIME.get() {
        let _ = handle.commands.send(Command::Detach(id));
    }
}

fn observe(observed: &Mutex<Observed>, snapshot: PermissionSnapshot, sources: Vec<Source>) {
    *observed.lock().unwrap_or_else(|error| error.into_inner()) = Observed { snapshot, sources };
}

fn clear(observed: &Mutex<Observed>, status: PermissionStatus) {
    observe(
        observed,
        PermissionSnapshot {
            status,
            ..PermissionSnapshot::default()
        },
        Vec::new(),
    );
}

async fn run(
    mut receiver: mpsc::UnboundedReceiver<Command>,
    observed: Arc<Mutex<Observed>>,
    mut authorizer: impl Authorizer,
) {
    let mut live: Option<Live> = None;
    let mut directory = None;
    let mut next_source = 1;
    loop {
        let command = if let Some(session) = live.as_mut() {
            tokio::select! {
                command = receiver.recv() => command,
                _ = session.closed.next() => {
                    tracing::info!("Wayland portal session closed");
                    None
                },
                _ = session.owner_changed.next() => {
                    tracing::info!("Wayland portal service changed owner");
                    None
                },
                event = next_input(&mut session.input) => {
                    let result = match event {
                        Some(Ok(event)) => session.input.as_mut().ok_or(Error::Stopped).and_then(|input| input.event(event)),
                        Some(Err(error)) => Err(Error::Input(error.to_string())),
                        None => Err(Error::Stopped),
                    };
                    if result.is_ok() { continue; }
                    if let Err(error) = result {
                        tracing::warn!(%error, "Wayland input connection ended");
                    }
                    None
                }
            }
        } else {
            receiver.recv().await
        };
        let Some(command) = command else {
            clear(&observed, PermissionStatus::Unavailable);
            if let Some(session) = live.take() {
                session.close().await;
            }
            if receiver.is_closed() {
                break;
            }
            continue;
        };
        match command {
            Command::Request(requested_directory, reply) => {
                if let Some(session) = live.as_ref() {
                    let _ = reply.send(Ok(session.snapshot.clone()));
                    continue;
                }
                let restore_only = requested_directory.is_none();
                if let Some(requested) = requested_directory {
                    directory = Some(requested);
                }
                let Some(request_directory) = directory.as_deref() else {
                    let _ = reply.send(Err(Error::PermissionDenied));
                    continue;
                };
                clear(&observed, PermissionStatus::Requesting);
                let outcome = authorizer
                    .authorize(
                        request_directory,
                        restore_only,
                        &mut next_source,
                        &mut receiver,
                    )
                    .await;
                if outcome.shutdown.is_some() {
                    directory = None;
                }
                match outcome.result {
                    Ok(session) => {
                        observe(&observed, session.snapshot.clone(), session.sources.clone());
                        let _ = reply.send(Ok(session.snapshot.clone()));
                        live = Some(session);
                    }
                    Err(error) => {
                        let status = if outcome.shutdown.is_some() {
                            PermissionStatus::Unknown
                        } else if matches!(error, Error::Cancelled | Error::PermissionDenied) {
                            PermissionStatus::Denied
                        } else {
                            PermissionStatus::Unavailable
                        };
                        clear(&observed, status);
                        let _ = reply.send(Err(error));
                    }
                }
                if let Some(shutdown) = outcome.shutdown {
                    let _ = shutdown.send(Ok(()));
                }
            }
            Command::Shutdown(reply) => {
                directory = None;
                clear(&observed, PermissionStatus::Unknown);
                if let Some(session) = live.take() {
                    session.close().await;
                }
                let _ = reply.send(Ok(()));
            }
            Command::Open(id, reply) => {
                let result = if let Some(session) = live.as_ref() {
                    tokio::time::timeout(
                        std::time::Duration::from_secs(2),
                        session.open_pipewire(id),
                    )
                    .await
                    .unwrap_or(Err(Error::Stopped))
                } else {
                    Err(Error::PermissionDenied)
                };
                let _ = reply.send(result);
            }
            Command::Attach(id, source_id, reply) => {
                let result = live
                    .as_mut()
                    .ok_or(Error::PermissionDenied)
                    .and_then(|session| {
                        let source = session
                            .sources
                            .iter()
                            .find(|source| source.id == source_id)
                            .ok_or(Error::StaleSource)?
                            .clone();
                        session
                            .input
                            .as_mut()
                            .ok_or(Error::PermissionDenied)?
                            .attach(id, source)
                    });
                let _ = reply.send(result);
            }
            Command::Input(id, action, reply) => {
                let result =
                    if let Some(input) = live.as_mut().and_then(|session| session.input.as_mut()) {
                        input.action(id, action)
                    } else if matches!(
                        action,
                        Action::Release
                            | Action::Key { pressed: false, .. }
                            | Action::Button { pressed: false, .. }
                    ) {
                        Ok(())
                    } else {
                        Err(Error::PermissionDenied)
                    };
                let _ = reply.send(result);
            }
            Command::Detach(id) => {
                if let Some(input) = live.as_mut().and_then(|session| session.input.as_mut()) {
                    let _ = input.detach_controller(id);
                }
            }
        }
    }
}

async fn next_input(
    input: &mut Option<crate::input::Eis>,
) -> Option<std::result::Result<reis::event::EiEvent, reis::Error>> {
    match input {
        Some(input) => input.events.next().await,
        None => std::future::pending().await,
    }
}

struct AuthorizationOutcome {
    result: Result<Live>,
    shutdown: Option<Reply<()>>,
}

trait Authorizer {
    async fn authorize(
        &mut self,
        directory: &std::path::Path,
        restore_only: bool,
        next_source: &mut u32,
        receiver: &mut mpsc::UnboundedReceiver<Command>,
    ) -> AuthorizationOutcome;
}

struct PortalAuthorizer;

impl Authorizer for PortalAuthorizer {
    async fn authorize(
        &mut self,
        directory: &std::path::Path,
        restore_only: bool,
        next_source: &mut u32,
        receiver: &mut mpsc::UnboundedReceiver<Command>,
    ) -> AuthorizationOutcome {
        let mut connection = None;
        let outcome = {
            let authorization =
                portal::authorize(directory, restore_only, &mut connection, next_source);
            pending_authorization(authorization, receiver).await
        };
        if outcome.result.is_err()
            && let Some(connection) = connection
        {
            let _ = connection.close().await;
        }
        outcome
    }
}

async fn pending_authorization(
    authorization: impl std::future::Future<Output = Result<Live>>,
    receiver: &mut mpsc::UnboundedReceiver<Command>,
) -> AuthorizationOutcome {
    let mut shutdown = None;
    tokio::pin!(authorization);
    let result = {
        loop {
            tokio::select! {
                result = &mut authorization => break result,
                command = receiver.recv() => match command {
                    Some(Command::Shutdown(reply)) => { shutdown = Some(reply); break Err(Error::Cancelled); }
                    Some(Command::Request(_, reply)) => { let _ = reply.send(Err(Error::Busy)); }
                    Some(Command::Open(_, reply)) => { let _ = reply.send(Err(Error::PermissionDenied)); }
                    Some(Command::Attach(_, _, reply)) => { let _ = reply.send(Err(Error::PermissionDenied)); }
                    Some(Command::Input(_, action, reply)) => {
                        let released = matches!(action, Action::Release | Action::Key { pressed: false, .. } | Action::Button { pressed: false, .. });
                        let _ = reply.send(if released { Ok(()) } else { Err(Error::PermissionDenied) });
                    }
                    Some(Command::Detach(_)) => {}
                    None => break Err(Error::Stopped),
                }
            }
        }
    };
    AuthorizationOutcome { result, shutdown }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    struct FakeAuthorizer {
        calls: Arc<AtomicUsize>,
        pending: bool,
    }

    impl Authorizer for FakeAuthorizer {
        async fn authorize(
            &mut self,
            _: &std::path::Path,
            _: bool,
            _: &mut u32,
            receiver: &mut mpsc::UnboundedReceiver<Command>,
        ) -> AuthorizationOutcome {
            self.calls.fetch_add(1, Ordering::Relaxed);
            if self.pending {
                pending_authorization(std::future::pending(), receiver).await
            } else {
                AuthorizationOutcome {
                    result: Err(Error::PermissionDenied),
                    shutdown: None,
                }
            }
        }
    }

    async fn shutdown_prevents_late_restore(pending: bool) {
        let (sender, receiver) = mpsc::unbounded_channel();
        let observed = Arc::new(Mutex::new(Observed::default()));
        let calls = Arc::new(AtomicUsize::new(0));
        let fake = FakeAuthorizer {
            calls: calls.clone(),
            pending,
        };
        let actor = run(receiver, observed.clone(), fake);
        let client = async {
            let (reply, first) = oneshot::channel();
            sender
                .send(Command::Request(
                    Some(PathBuf::from("/unused-test-directory")),
                    reply,
                ))
                .unwrap();
            let (reply, closed) = oneshot::channel();
            sender.send(Command::Shutdown(reply)).unwrap();
            assert!(first.await.unwrap().is_err());
            closed.await.unwrap().unwrap();
            let (reply, restored) = oneshot::channel();
            sender.send(Command::Request(None, reply)).unwrap();
            assert!(matches!(
                restored.await.unwrap(),
                Err(Error::PermissionDenied)
            ));
            assert_eq!(calls.load(Ordering::Relaxed), 1);
            assert_eq!(
                observed.lock().unwrap().snapshot.status,
                PermissionStatus::Unknown
            );
            drop(sender);
        };
        tokio::time::timeout(std::time::Duration::from_secs(1), async {
            tokio::join!(actor, client);
        })
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn shutdown_cancels_pending_authorization_and_disables_restore() {
        shutdown_prevents_late_restore(true).await;
    }

    #[tokio::test]
    async fn shutdown_clears_previous_configuration_before_late_restore() {
        shutdown_prevents_late_restore(false).await;
    }
}
